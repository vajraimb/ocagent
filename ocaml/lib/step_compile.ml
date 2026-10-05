(** Compile one Step to bytecode, then hand the bytes to the store.
    The temporary directory is removed before admission. *)

type validated_artifact = { bundle : Step_manifest.bundle }

type error =
  | Rejected of string
  | Unavailable of string
  | Store of Store.error

let describe = function
  | Rejected msg -> msg
  | Unavailable msg -> msg
  | Store err -> Store.describe err

type module_source = {
  name : string;
  source : string;
  interface_ : string;
}

type setup_fault =
  | Rlimit
  | Descriptors
  | Isolation

type collect_state = {
  reaped : Unix.process_status option;
  eof : bool;
  length : int;
}

type collect_event =
  | Output of int
  | Pipe_eof
  | Would_block
  | Reaped of Unix.process_status
  | Deadline

type collect_action =
  | Read
  | Reap
  | Wait
  | Done
  | Failed of string

let max_output = 262144
let compile_timeout = 30.0
let compile_as_bytes = 1024 * 1024 * 1024
let compile_file_bytes = 16 * 1024 * 1024
let max_text = 262144

external limit_compiler : int -> int -> int -> int = "ocagent_limit_compiler"
external close_extra_fds : int -> int -> int -> int = "ocagent_close_extra_fds"
external kill_group : int -> int = "ocagent_kill_group"
external getpgid : int -> int = "ocagent_getpgid"
external realpath : string -> string = "ocagent_realpath"
external clearenv : unit -> unit = "ocagent_clearenv"
external unshare_user : unit -> int = "ocagent_unshare_user"
external write_maps : int -> int = "ocagent_write_maps"
external mount_jail : string -> string -> int = "ocagent_mount_jail"
external enter_landlock : string -> string -> int = "ocagent_enter_landlock"

let which name =
  match Sys.getenv_opt "PATH" with
  | None -> None
  | Some path ->
      let rec go = function
        | [] -> None
        | dir :: rest ->
            let candidate = if Filename.is_relative dir then Filename.concat (Sys.getcwd ()) (Filename.concat dir name) else Filename.concat dir name in
            if Sys.file_exists candidate then Some candidate else go rest
      in
      go (String.split_on_char ':' path)

let read_file path =
  let ic = open_in_bin path in
  Fun.protect ~finally:(fun () -> close_in ic) (fun () -> really_input_string ic (in_channel_length ic))

let write_exact path bytes =
  let oc = open_out_bin path in
  Fun.protect ~finally:(fun () -> close_out oc) (fun () -> output_string oc bytes)

let hash_file path = Step_manifest.sha256 (read_file path)

let find_root marker =
  let rec up dir =
    if Sys.file_exists (Filename.concat dir marker) then Some dir
    else
      let parent = Filename.dirname dir in
      if parent = dir then None else up parent
  in
  up (Sys.getcwd ())

let sdk_dir () =
  match find_root "ocaml/step-sdk/step_api.mli" with
  | Some root -> Ok (Filename.concat root "ocaml/step-sdk")
  | None -> Error (Unavailable "step sdk sources")

let rec remove_tree dir =
  if Sys.file_exists dir then (
    let entries = Sys.readdir dir in
    Array.iter
      (fun name ->
        let path = Filename.concat dir name in
        if Sys.is_directory path then remove_tree path else Unix.unlink path)
      entries;
    Unix.rmdir dir)

let collector_step state = function
  | Deadline -> state, Failed "compile timeout"
  | Reaped status ->
      if state.reaped <> None then state, Failed "collector"
      else
        let state = { state with reaped = Some status } in
        if state.eof then state, Done else state, Read
  | Pipe_eof ->
      let state = { state with eof = true } in
      if state.reaped = None then state, Reap else state, Done
  | Output n ->
      let length = state.length + n in
      if length > max_output then { state with length }, Failed "compiler output" else { state with length }, Read
  | Would_block -> if state.reaped = None then state, Reap else if state.eof then state, Done else state, Wait

let empty_collect = { reaped = None; eof = false; length = 0 }

let read_some fd buf =
  try Some (Unix.read fd buf 0 (Bytes.length buf)) with
  | Unix.Unix_error ((Unix.EAGAIN | Unix.EWOULDBLOCK | Unix.EINTR), _, _) -> None

let kill_collected pid =
  ignore (kill_group pid);
  (try Unix.kill pid Sys.sigkill with Unix.Unix_error _ -> ());
  let proc_ids pid =
    let path = "/proc/" ^ string_of_int pid ^ "/stat" in
    try
      let ic = open_in_bin path in
      let buf = Buffer.create 64 in
      let bytes = Bytes.create 128 in
      Fun.protect ~finally:(fun () -> close_in ic) (fun () ->
          let rec go () =
            match input ic bytes 0 128 with
            | 0 -> Buffer.contents buf
            | n ->
                Buffer.add_subbytes buf bytes 0 n;
                go ()
          in
          go ())
      |> fun text ->
      match String.rindex_opt text ')' with
      | None -> None
      | Some index -> (
          let rest = String.trim (String.sub text (index + 1) (String.length text - index - 1)) in
          match String.split_on_char ' ' rest with
          | state :: _ppid :: group :: _ -> Some (state, int_of_string group)
          | _ -> None)
    with _ -> None
  in
  let live_members pgid =
    Array.fold_left
      (fun count name ->
        match int_of_string_opt name with
        | None -> count
        | Some pid -> (
            match proc_ids pid with
            | Some (state, group) when group = pgid && state <> "Z" -> count + 1
            | _ -> count))
      0
      (try Sys.readdir "/proc" with Sys_error _ -> [||])
  in
  let rec drain spins =
    if spins = 0 || live_members pid = 0 then ()
    else (
      ignore (kill_group pid);
      Unix.sleepf 0.02;
      drain (spins - 1))
  in
  drain 25

let collect_child ~deadline pid fd =
  Unix.set_nonblock fd;
  let buf = Buffer.create 64 in
  let bytes = Bytes.create 256 in
  let state = ref empty_collect in
  let finished = ref false in
  Fun.protect
    ~finally:(fun () ->
      if not !finished then (
        kill_collected pid;
        if !state.reaped = None then (try ignore (Unix.waitpid [] pid) with Unix.Unix_error _ -> ());
        try Unix.close fd with Unix.Unix_error _ -> ())
      else (try Unix.close fd with Unix.Unix_error _ -> ()))
    (fun () ->
      let rec apply event =
        let next, action = collector_step !state event in
        state := next;
        match action with
        | Failed msg -> Error (Rejected msg)
        | Done -> (
            match next.reaped with
            | Some status when next.eof ->
                finished := true;
                Ok (Buffer.contents buf, status)
            | _ -> Error (Unavailable "collector"))
        | Read -> loop ()
        | Wait ->
            Unix.sleepf 0.02;
            loop ()
        | Reap -> (
            if Unix.gettimeofday () >= deadline then Error (Rejected "compile timeout")
            else
              match Unix.waitpid [ Unix.WNOHANG ] pid with
              | exception Unix.Unix_error (Unix.ECHILD, _, _) -> Error (Unavailable "collector")
              | 0, _ ->
                  Unix.sleepf 0.02;
                  loop ()
              | _, status -> apply (Reaped status))
      and loop () =
        if Unix.gettimeofday () >= deadline then Error (Rejected "compile timeout")
        else if not !state.eof then
          match read_some fd bytes with
          | Some 0 -> apply Pipe_eof
          | Some n ->
              Buffer.add_subbytes buf bytes 0 n;
              apply (Output n)
          | None -> apply Would_block
        else apply Would_block
      in
      loop ())

let version_parts text =
  match String.split_on_char '.' text with
  | [ major; minor; patch ] -> (
      match (int_of_string_opt major, int_of_string_opt minor, int_of_string_opt patch) with
      | Some major, Some minor, Some patch -> Some (major, minor, patch)
      | _ -> None)
  | _ -> None

let toolchain_acceptable ~compiler ~runtime =
  match (version_parts compiler, version_parts runtime) with
  | Some (5, minor, _), Some (5, minor2, _) when minor >= 3 && (minor, compiler) = (minor2, runtime) -> true
  | _ -> false

type toolchain = {
  root : string;
  loader : string;
  libdir : string;
  ocamlc : string;
  ocamlrun : string;
  env : string array;
  compiler_id : string;
  runtime_id : string;
}

let release tools = remove_tree tools.root

let stage_text code =
  let stage =
    match code / 1000 with
    | 3 -> "namespace"
    | 4 -> "uid"
    | 5 -> "gid"
    | 6 -> "mount"
    | 7 -> "chroot"
    | 8 -> "chdir"
    | 9 -> "landlock"
    | 10 -> "setgroups"
    | 11 -> "propagation_private"
    | 12 -> "jail_mkdir"
    | 13 -> "jail_tmpfs"
    | 14 -> "snapshot_bind"
    | 15 -> "snapshot_readonly"
    | 16 -> "work_bind"
    | 17 -> "root_move"
    | n -> "stage" ^ string_of_int n
  in
  stage ^ " " ^ string_of_int (code mod 1000)

let copy_file src dst =
  write_exact dst (read_file src);
  Unix.chmod dst (Unix.stat src).st_perm

let list_files dir =
  let skip name =
    Filename.check_suffix name ".o" || Filename.check_suffix name ".a" || Filename.check_suffix name ".cmx"
    || Filename.check_suffix name ".cmxa" || Filename.check_suffix name ".cmxs"
  in
  Array.to_list (Sys.readdir dir)
  |> List.filter (fun name ->
         let path = Filename.concat dir name in
         (not (Sys.is_directory path)) && not (skip name))
  |> List.sort String.compare

let manifest_hash root =
  let rec walk rel =
    let dir = if rel = "" then root else Filename.concat root rel in
    let names = Array.to_list (Sys.readdir dir) |> List.sort String.compare in
    List.concat_map
      (fun name ->
        let child = if rel = "" then name else Filename.concat rel name in
        let path = Filename.concat root child in
        if Sys.is_directory path then walk child else [ child ])
      names
  in
  let lines = List.map (fun rel -> rel ^ " " ^ hash_file (Filename.concat root rel)) (walk "") in
  Step_manifest.sha256 (String.concat "\n" lines ^ "\n")

let loader_argv tools bin args = Array.of_list (tools.loader :: "--library-path" :: tools.libdir :: bin :: args)

let spawn ~deadline ~env argv =
  if Unix.gettimeofday () >= deadline then Error (Rejected "compile timeout")
  else
    let read_fd, write_fd = Unix.pipe ~cloexec:true () in
    match Unix.fork () with
    | 0 -> (
        try
          let null = Unix.openfile "/dev/null" [ Unix.O_RDONLY ] 0 in
          Unix.dup2 null Unix.stdin;
          Unix.dup2 write_fd Unix.stdout;
          Unix.dup2 write_fd Unix.stderr;
          Unix.close read_fd;
          if limit_compiler 5 compile_as_bytes compile_file_bytes <> 0 then exit 125;
          if close_extra_fds (-1) (-1) (-1) <> 0 then exit 125;
          Unix.execve argv.(0) argv env
        with _ -> exit 127)
    | pid -> (
        Unix.close write_fd;
        match collect_child ~deadline pid read_fd with
        | Ok (text, Unix.WEXITED 0) -> Ok (String.trim text)
        | Ok _ -> Error (Unavailable "compiler version")
        | Error _ as err -> err)

let select_toolchain ~deadline =
  if Unix.gettimeofday () >= deadline then Error (Rejected "compile timeout")
  else
    match (which "ocamlc", which "ocamlrun") with
    | None, _ -> Error (Unavailable "ocamlc")
    | _, None -> Error (Unavailable "ocamlrun")
    | Some ocamlc_path, Some ocamlrun_path -> (
        match (realpath ocamlc_path, realpath ocamlrun_path) with
        | exception Failure _ -> Error (Unavailable "toolchain path")
        | ocamlc_path, ocamlrun_path ->
            let stdlib_src = Filename.concat (Filename.dirname (Filename.dirname ocamlc_path)) "lib/ocaml" in
            let loader_src = "/lib64/ld-linux-x86-64.so.2" in
            let libc_src = "/lib/x86_64-linux-gnu/libc.so.6" in
            let libm_src = "/lib/x86_64-linux-gnu/libm.so.6" in
            if not (Sys.file_exists (Filename.concat stdlib_src "stdlib.cma") && Sys.file_exists loader_src && Sys.file_exists libc_src) then
              Error (Unavailable "ocaml stdlib")
            else
              let root = Filename.temp_dir "ocagent-tc" "" in
              let kept = ref false in
              Fun.protect ~finally:(fun () -> if not !kept then remove_tree root) (fun () ->
                  if Unix.gettimeofday () >= deadline then Error (Rejected "compile timeout")
                  else
                    let bin = Filename.concat root "bin" in
                    let libdir = Filename.concat root "lib" in
                    let stdlib = Filename.concat root "stdlib" in
                    Unix.mkdir bin 0o700;
                    Unix.mkdir libdir 0o700;
                    Unix.mkdir stdlib 0o700;
                    let copy src dst =
                      if Unix.gettimeofday () >= deadline then Error (Rejected "compile timeout")
                      else
                        try
                          copy_file src dst;
                          Ok ()
                        with
                        | Unix.Unix_error (err, _, path) -> Error (Unavailable (Unix.error_message err ^ " " ^ path))
                        | Sys_error msg -> Error (Unavailable msg)
                    in
                    let rec copies = function
                      | [] -> Ok ()
                      | (src, dst) :: rest -> (
                          match copy src dst with
                          | Error _ as err -> err
                          | Ok () -> copies rest)
                    in
                    let files =
                      [
                        (ocamlc_path, Filename.concat bin "ocamlc");
                        (ocamlrun_path, Filename.concat bin "ocamlrun");
                        (loader_src, Filename.concat root "ld-linux");
                        (libc_src, Filename.concat libdir "libc.so.6");
                        (libm_src, Filename.concat libdir "libm.so.6");
                      ]
                      @ List.map (fun name -> (Filename.concat stdlib_src name, Filename.concat stdlib name)) (list_files stdlib_src)
                    in
                    match copies files with
                    | Error _ as err -> err
                    | Ok () ->
                        if Unix.gettimeofday () >= deadline then Error (Rejected "compile timeout")
                        else
                          let tools =
                        {
                          root;
                          loader = Filename.concat root "ld-linux";
                          libdir;
                          ocamlc = Filename.concat bin "ocamlc";
                          ocamlrun = Filename.concat bin "ocamlrun";
                          env = [| "LANG=C"; "OCAMLLIB=" ^ stdlib; "PATH=" ^ bin |];
                          compiler_id = "";
                          runtime_id = "";
                        }
                      in
                      let hash = manifest_hash root in
                      match
                        ( spawn ~deadline ~env:tools.env (loader_argv tools tools.ocamlc [ "-vnum" ]),
                          spawn ~deadline ~env:tools.env (loader_argv tools tools.ocamlrun [ "-vnum" ]) )
                      with
                      | Ok compiler_version, Ok runtime_version
                        when toolchain_acceptable ~compiler:compiler_version ~runtime:runtime_version ->
                          kept := true;
                          Ok
                            {
                              tools with
                              compiler_id = Printf.sprintf "ocamlc %s manifest %s" compiler_version hash;
                              runtime_id = Printf.sprintf "ocamlrun %s manifest %s" runtime_version hash;
                            }
                      | Error _ as err, _ -> err
                      | _, (Error _ as err) -> err
                      | _ -> Error (Unavailable "toolchain pair")))

let toolchain () =
  match select_toolchain ~deadline:(Unix.gettimeofday () +. 5.) with
  | Ok tools ->
      let ids = (tools.compiler_id, tools.runtime_id) in
      release tools;
      Ok ids
  | Error _ as err -> err

let hold_toolchain ~deadline = select_toolchain ~deadline

let status_of text =
  match String.trim text with
  | "OK" -> Ok ()
  | text when String.starts_with ~prefix:"FAIL " text -> Error (Unavailable (String.sub text 5 (String.length text - 5)))
  | _ -> Error (Unavailable "status")
external to_int : Unix.file_descr -> int = "%identity"

let userns_setup_failure msg =
  List.exists
    (fun prefix -> String.starts_with ~prefix msg)
    [
      "namespace ";
      "setgroups ";
      "uid ";
      "gid ";
      "mount ";
      "chroot ";
      "chdir ";
      "propagation_private ";
      "jail_mkdir ";
      "jail_tmpfs ";
      "snapshot_bind ";
      "snapshot_readonly ";
      "work_bind ";
      "root_move ";
    ]

let wait_byte fd deadline =
  let buf = Bytes.create 1 in
  let rec go () =
    if Unix.gettimeofday () >= deadline then Error (Rejected "compile timeout")
    else
      match Unix.select [ fd ] [] [] 0.05 with
      | [], _, _ -> go ()
      | _ -> (
          match Unix.read fd buf 0 1 with
          | exception Unix.Unix_error ((Unix.EAGAIN | Unix.EINTR), _, _) -> go ()
          | 0 -> Error (Unavailable "sync")
          | _ -> Ok (Bytes.get buf 0))
  in
  go ()

let signal_byte fd ch =
  let bytes = Bytes.make 1 ch in
  ignore (Unix.write fd bytes 0 1)

let report_fd fd msg =
  let bytes = Bytes.of_string msg in
  ignore (Unix.write fd bytes 0 (Bytes.length bytes))

type job =
  | Exec of string array * string array
  | Call of (unit -> unit)

let finish_status ~marker text status =
  match status with
  | Unix.WEXITED 0 ->
      let text = String.trim text in
      if text = "" then Error (Unavailable "status") else Ok text
  | Unix.WEXITED 126 -> (
      match status_of text with
      | Error (Unavailable _) as err -> if Sys.file_exists marker then Error (Rejected "fallback") else err
      | Error _ as err -> err
      | Ok () -> Error (Unavailable "status"))
  | Unix.WEXITED 125 -> Error (Unavailable "rlimit")
  | Unix.WEXITED 127 -> Error (Unavailable ("compiler exec " ^ String.trim text))
  | Unix.WEXITED _ -> Error (Rejected (if text = "" then "compiler failed" else text))
  | _ -> Error (Rejected "compiler failed")

let observed_netns = ref ""
let fault_skip = ref 0
let marker_seq = ref 0

let fresh_marker dir =
  marker_seq := !marker_seq + 1;
  let path = Filename.concat dir (Printf.sprintf ".exec-marker-%d" !marker_seq) in
  (try Unix.unlink path with Unix.Unix_error _ -> ());
  path

let run_userns ~deadline ~work ~snap ~setup_fault ~marker ~stdout ~stderr job =
  if Unix.gettimeofday () >= deadline then Error (Rejected "compile timeout")
  else
    let setup_fault =
      match setup_fault with
      | Some _ when !fault_skip > 0 ->
          fault_skip := !fault_skip - 1;
          None
      | fault -> fault
    in
    let status_r, status_w = Unix.pipe ~cloexec:true () in
    let child_to_parent_r, child_to_parent_w = Unix.pipe ~cloexec:true () in
    let parent_to_child_r, parent_to_child_w = Unix.pipe ~cloexec:true () in
    match Unix.fork () with
    | 0 -> (
        try
          let null = Unix.openfile "/dev/null" [ Unix.O_RDONLY ] 0 in
          Unix.dup2 null Unix.stdin;
          Unix.dup2 stdout Unix.stdout;
          Unix.dup2 stderr Unix.stderr;
          let fd_rc = close_extra_fds (to_int status_w) (to_int child_to_parent_w) (to_int parent_to_child_r) in
          let fd_rc = match setup_fault with Some Descriptors -> -13 | _ -> fd_rc in
          if fd_rc <> 0 then (report_fd status_w (Printf.sprintf "FAIL fd %d\n" (abs fd_rc)); exit 126);
          clearenv ();
          let rc = limit_compiler 30 compile_as_bytes compile_file_bytes in
          let rc = match setup_fault with Some Rlimit -> -13 | _ -> rc in
          if rc <> 0 then (report_fd status_w (Printf.sprintf "FAIL rlimit %d\n" (abs rc)); exit 126);
          let unshare_rc = unshare_user () in
          if unshare_rc <> 0 then (report_fd status_w ("FAIL " ^ stage_text unshare_rc ^ "\n"); exit 126);
          signal_byte child_to_parent_w 'R';
          let buf = Bytes.create 1 in
          if Unix.read parent_to_child_r buf 0 1 <> 1 || Bytes.get buf 0 <> 'G' then exit 126;
          (try observed_netns := Unix.readlink "/proc/self/ns/net" with _ -> ());
          let mount_rc =
            match setup_fault with
            | Some Isolation -> mount_jail "/no/such-ocagent-work" "/no/such-ocagent-snap"
            | _ -> mount_jail work snap
          in
          if mount_rc <> 0 then (report_fd status_w ("FAIL " ^ stage_text mount_rc ^ "\n"); exit 126);
          Unix.chdir work;
          match job with
          | Exec (argv, env) ->
              write_exact marker "exec";
              report_fd status_w "OK\n";
              Unix.close status_w;
              Unix.execve argv.(0) argv env
          | Call fn ->
              Unix.dup2 status_w Unix.stdout;
              (try fn () with _ -> report_fd status_w "FAIL validator\n"; exit 2);
              exit 0
        with _ -> exit 127)
    | pid ->
        Unix.close status_w;
        Unix.close child_to_parent_w;
        Unix.close parent_to_child_r;
        Fun.protect
          ~finally:(fun () ->
            (try Unix.close child_to_parent_r with Unix.Unix_error _ -> ());
            (try Unix.close parent_to_child_w with Unix.Unix_error _ -> ());
            (try Unix.rmdir (Printf.sprintf "/tmp/ocagent-jail-%d" pid) with Unix.Unix_error _ -> ()))
          (fun () ->
            let handshake = wait_byte child_to_parent_r deadline in
            let after_maps =
              match handshake with
              | Error (Unavailable "sync") -> None
              | Error _ as err -> Some err
              | Ok _ ->
                  let code = write_maps pid in
                  if code <> 0 then (
                    (try signal_byte parent_to_child_w 'A' with Unix.Unix_error _ -> ());
                    kill_collected pid;
                    Some (Error (Unavailable (stage_text code))))
                  else (
                    (try signal_byte parent_to_child_w 'G' with Unix.Unix_error _ -> ());
                    None)
            in
            match collect_child ~deadline pid status_r with
            | Error _ as err -> (match after_maps with Some earlier -> earlier | None -> err)
            | Ok (text, status) -> (
                match after_maps with
                | Some earlier -> earlier
                | None -> finish_status ~marker text status))

let module_name_ok name =
  let reserved = function
    | "Step" | "Step_api" | "Stdlib" | "Unix" | "Sys" | "Obj" | "Marshal" -> true
    | _ -> false
  in
  String.length name > 0
  && name.[0] >= 'A'
  && name.[0] <= 'Z'
  && (not (reserved name))
  && String.for_all
       (fun c -> c = '_' || (c >= '0' && c <= '9') || (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z'))
       name

let policy_text =
  {|{"compile_timeout_s":30,"log_bytes":1048576,"worker_memory_mib":256,"worker_timeout_s":20}|}

let input_text pairs =
  let fields =
    List.map (fun (key, value) -> (key, Step_manifest.String value)) (List.sort (fun (a, _) (b, _) -> String.compare a b) pairs)
  in
  match Step_manifest.canonical (Step_manifest.Obj fields) with
  | Ok text -> Ok text
  | Error err -> Error (Rejected (Step_manifest.describe err))

let text_ok text = String.length text <= max_text

let say_limited msg =
  let msg = if String.length msg > 500 then String.sub msg 0 500 else msg in
  output_string stdout (msg ^ "\n");
  flush stdout

let check_sources ~users source modules =
  let rec mods = function
    | [] -> say_limited "OK"
    | item :: rest -> (
        match Step_validate.interface ~users item.interface_ with
        | Error (Step_validate.Rejected msg) -> say_limited msg; exit 2
        | Ok () -> (
            match Step_validate.implementation ~users item.source with
            | Error (Step_validate.Rejected msg) -> say_limited msg; exit 2
            | Ok () -> mods rest))
  in
  match Step_validate.implementation ~users source with
  | Error (Step_validate.Rejected msg) -> say_limited msg; exit 2
  | Ok () -> mods modules

let validate_child ~hang ~deadline ~snap ~setup_fault ~users source modules =
  let work = Filename.temp_dir "ocagent-check" "" in
  let null = Unix.openfile "/dev/null" [ Unix.O_RDWR ] 0o600 in
  Fun.protect ~finally:(fun () -> Unix.close null; remove_tree work) (fun () ->
      let marker = fresh_marker work in
      match
        run_userns ~deadline ~work ~snap ~setup_fault ~marker ~stdout:null ~stderr:null
          (Call
             (fun () ->
               if hang then Unix.sleep 60;
               check_sources ~users source modules))
      with
      | Ok "OK" -> Ok ()
      | Ok msg -> Error (Rejected msg)
      | Error (Rejected "compile timeout") -> Error (Rejected "compile timeout")
      | Error (Rejected msg) -> Error (Rejected msg)
      | Error _ as err -> err)

let validate_cmt ~deadline ~snap ~setup_fault ~users dir names =
  let null = Unix.openfile "/dev/null" [ Unix.O_RDWR ] 0o600 in
  Fun.protect ~finally:(fun () -> Unix.close null) (fun () ->
      let marker = fresh_marker dir in
      match
        run_userns ~deadline ~work:dir ~snap ~setup_fault ~marker ~stdout:null ~stderr:null
          (Call
             (fun () ->
               let rec go = function
                 | [] -> say_limited "OK"
                 | name :: rest -> (
                     match Step_validate.scan_cmt ~users (Filename.concat dir (name ^ ".cmt")) with
                     | Error (Step_validate.Rejected msg) -> say_limited msg; exit 2
                     | Ok () -> go rest)
               in
               go names))
      with
      | Ok "OK" -> Ok ()
      | Ok msg -> Error (Rejected msg)
      | Error (Unavailable msg) when String.starts_with ~prefix:"rlimit" msg -> Error (Unavailable msg)
      | Error _ as err -> err)

let source_gate ~hang ~deadline ~snap ~setup_fault ~source ~modules ~input =
  if List.length modules > 16 then Error (Rejected "too many modules")
  else if (not (text_ok source)) || List.exists (fun item -> not (text_ok item.source && text_ok item.interface_)) modules then
    Error (Rejected "too big")
  else if List.exists (fun (key, value) -> not (text_ok key && text_ok value)) input then Error (Rejected "too big")
  else
    let names = List.map (fun item -> item.name) modules in
    if List.exists (fun name -> not (module_name_ok name)) names then Error (Rejected "module name")
    else if List.length names <> List.length (List.sort_uniq String.compare names) then Error (Rejected "duplicate module")
    else validate_child ~hang ~deadline ~snap ~setup_fault ~users:("Step" :: names) source modules

let landlock_note = ref (fun ~work:_ ~snap:_ msg -> Error (Unavailable msg))

let launch_compile ~deadline ~work ~tools ~setup_fault args =
  let stdout_path = Filename.concat work "tool.out" in
  let stderr_path = Filename.concat work "tool.err" in
  let marker = fresh_marker work in
  let out = Unix.openfile stdout_path [ Unix.O_WRONLY; Unix.O_CREAT; Unix.O_TRUNC ] 0o600 in
  let err = Unix.openfile stderr_path [ Unix.O_WRONLY; Unix.O_CREAT; Unix.O_TRUNC ] 0o600 in
  Fun.protect ~finally:(fun () -> Unix.close out; Unix.close err) (fun () ->
      match
        run_userns ~deadline ~work ~snap:tools.root ~setup_fault ~marker ~stdout:out ~stderr:err
          (Exec (loader_argv tools tools.ocamlc args, tools.env))
      with
      | Ok _ ->
          let out_len = (Unix.stat stdout_path).st_size in
          let err_len = (Unix.stat stderr_path).st_size in
          if out_len > max_output || err_len > max_output then Error (Rejected "compiler output") else Ok ()
      | Error (Unavailable msg) when userns_setup_failure msg -> !landlock_note ~work ~snap:tools.root msg
      | Error (Rejected _) as err when Sys.file_exists stderr_path ->
          let message = read_file stderr_path in
          let message = if String.length message > 500 then String.sub message 0 500 else message in
          if message = "" then err else Error (Rejected message)
      | Error _ as err -> err)

let compile_with ~setup_fault ~hang ~deadline tools ~source ~modules ~input =
  match source_gate ~hang ~deadline ~snap:tools.root ~setup_fault ~source ~modules ~input with
  | Error _ as err -> err
  | Ok () -> (
      match input_text input with
      | Error _ as err -> err
      | Ok input_bytes -> (
          match sdk_dir () with
          | Error _ as err -> err
          | Ok sdk -> (
              let dir = Filename.temp_dir "ocagent-step" "" in
              Fun.protect ~finally:(fun () -> remove_tree dir) (fun () ->
                  let api_mli = read_file (Filename.concat sdk "step_api.mli") in
                  let api_ml = read_file (Filename.concat sdk "step_api.ml") in
                  let driver = read_file (Filename.concat sdk "step_driver.ml") in
                  write_exact (Filename.concat dir "step_api.mli") api_mli;
                  write_exact (Filename.concat dir "step_api.ml") api_ml;
                  write_exact (Filename.concat dir "step.ml") source;
                  write_exact (Filename.concat dir "step_driver.ml") driver;
                  write_exact (Filename.concat dir "step_check.ml") "module _ : Step_api.STEP = Step.Step\n";
                  List.iter
                    (fun item ->
                      write_exact (Filename.concat dir (item.name ^ ".mli")) item.interface_;
                      write_exact (Filename.concat dir (item.name ^ ".ml")) item.source)
                    modules;
                  let user_cmds =
                    List.concat_map
                      (fun item ->
                        [ [ "-I"; dir; "-bin-annot"; "-c"; item.name ^ ".mli" ]; [ "-I"; dir; "-bin-annot"; "-c"; item.name ^ ".ml" ] ])
                      modules
                  in
                  let cmds =
                    [ [ "-I"; dir; "-bin-annot"; "-c"; "step_api.mli" ]; [ "-I"; dir; "-bin-annot"; "-c"; "step_api.ml" ] ]
                    @ user_cmds
                    @ [ [ "-I"; dir; "-bin-annot"; "-c"; "step.ml" ]; [ "-I"; dir; "-bin-annot"; "-c"; "step_check.ml" ]; [ "-I"; dir; "-c"; "step_driver.ml" ] ]
                  in
                  let rec build = function
                    | [] -> Ok ()
                    | args :: rest -> (
                        match launch_compile ~deadline ~work:dir ~tools ~setup_fault args with
                        | Error _ as err -> err
                        | Ok () -> build rest)
                  in
                  match build cmds with
                  | Error _ as err -> err
                  | Ok () -> (
                      match
                        validate_cmt ~deadline ~snap:tools.root ~setup_fault ~users:("Step" :: List.map (fun item -> item.name) modules) dir
                          ("step" :: List.map (fun item -> item.name) modules)
                      with
                      | Error _ as err -> err
                      | Ok () -> (
                          let objects =
                            "step_api.cmo" :: List.map (fun item -> item.name ^ ".cmo") modules @ [ "step.cmo"; "step_check.cmo"; "step_driver.cmo" ]
                          in
                          match launch_compile ~deadline ~work:dir ~tools ~setup_fault ("-I" :: dir :: "-o" :: "worker" :: objects) with
                          | Error _ as err -> err
                          | Ok () ->
                              let bytecode = read_file (Filename.concat dir "worker") in
                              if String.length bytecode > 16 * 1024 * 1024 then Error (Rejected "artifact")
                              else if not (String.starts_with ~prefix:"#!" bytecode) then Error (Rejected "bytecode")
                              else
                                let module_bytes =
                                  List.map
                                    (fun item ->
                                      {
                                        Step_manifest.name = item.name;
                                        source = item.source;
                                        interface_ = item.interface_;
                                        artifact = read_file (Filename.concat dir (item.name ^ ".cmo"));
                                      })
                                    modules
                                in
                                Ok
                                  {
                                    bundle =
                                      {
                                        Step_manifest.source;
                                        modules = module_bytes;
                                        compiler_id = tools.compiler_id;
                                        runtime_id = tools.runtime_id;
                                        sdk = api_mli;
                                        driver = api_ml ^ driver;
                                        artifact = bytecode;
                                        base_workspace = "";
                                        input_context = input_bytes;
                                        capability_grant = {|{"net":"get"}|};
                                        policy_version = policy_text;
                                      };
                                  }))))))

let compile_go ~setup_fault ~hang ~budget ~source ~modules ~input =
  fault_skip := 0;
  Fun.protect ~finally:(fun () -> fault_skip := 0) (fun () ->
      let deadline = Unix.gettimeofday () +. budget in
      match select_toolchain ~deadline with
      | Error _ as err -> err
      | Ok tools ->
          Fun.protect ~finally:(fun () -> release tools) (fun () -> compile_with ~setup_fault ~hang ~deadline tools ~source ~modules ~input))

let compile ~source ~modules ~input = compile_go ~setup_fault:None ~hang:false ~budget:compile_timeout ~source ~modules ~input

let compile_fault setup_fault ~source ~modules ~input =
  compile_go ~setup_fault:(Some setup_fault) ~hang:false ~budget:compile_timeout ~source ~modules ~input

let compile_fault_after n setup_fault ~deadline tools ~source ~modules ~input =
  fault_skip := n;
  Fun.protect ~finally:(fun () -> fault_skip := 0) (fun () ->
      compile_with ~setup_fault:(Some setup_fault) ~hang:false ~deadline tools ~source ~modules ~input)

let admit ~path ~run_id ~agent_version ~admission_key artifact =
  match Store.admit_step ~path ~run_id ~agent_version ~admission_key artifact.bundle with
  | Ok manifest -> Ok manifest
  | Error err -> Error (Store err)

let submit ~path ~run_id ~agent_version ~admission_key ~source ~modules ~input =
  match compile ~source ~modules ~input with
  | Error _ as err -> err
  | Ok artifact -> admit ~path ~run_id ~agent_version ~admission_key artifact

let submit_fault setup_fault ~path ~run_id ~agent_version ~admission_key ~source ~modules ~input =
  match compile_fault setup_fault ~source ~modules ~input with
  | Error _ as err -> err
  | Ok artifact -> admit ~path ~run_id ~agent_version ~admission_key artifact

let submit_hang ~budget ~path ~run_id ~agent_version ~admission_key ~source ~modules ~input =
  match select_toolchain ~deadline:(Unix.gettimeofday () +. 20.) with
  | Error _ as err -> err
  | Ok tools ->
      Fun.protect ~finally:(fun () -> release tools) (fun () ->
          let deadline = Unix.gettimeofday () +. budget in
          match compile_with ~setup_fault:None ~hang:true ~deadline tools ~source ~modules ~input with
          | Error _ as err -> err
          | Ok artifact -> admit ~path ~run_id ~agent_version ~admission_key artifact)

let command ~timeout argv =
  let deadline = Unix.gettimeofday () +. timeout in
  let read_fd, write_fd = Unix.pipe ~cloexec:true () in
  match Unix.fork () with
  | 0 -> (
      try
        let null = Unix.openfile "/dev/null" [ Unix.O_RDONLY ] 0 in
        Unix.dup2 null Unix.stdin;
        Unix.dup2 write_fd Unix.stdout;
        Unix.dup2 write_fd Unix.stderr;
        Unix.close read_fd;
        if limit_compiler 5 compile_as_bytes compile_file_bytes <> 0 then exit 125;
        if close_extra_fds (-1) (-1) (-1) <> 0 then exit 125;
        Unix.execve argv.(0) argv [| "LANG=C" |]
      with _ -> exit 127)
  | pid ->
      Unix.close write_fd;
      let rec settle n =
        match getpgid pid with
        | pgid when pgid = pid -> pgid
        | _ when n = 0 -> pid
        | _ ->
            Unix.sleepf 0.01;
            settle (n - 1)
        | exception Failure _ -> pid
      in
      let pgid = settle 20 in
      let result =
        match collect_child ~deadline pid read_fd with
        | Ok (text, Unix.WEXITED 0) -> Ok text
        | Ok _ -> Error (Rejected "compiler failed")
        | Error _ as err -> err
      in
      (pid, pgid, result)

let contract_line ~sentinel ~tcp_port ~udp_port =
  let stat_visible = try ignore (Unix.stat sentinel); true with _ -> false in
  let content_visible =
    try
      let ic = open_in_bin sentinel in
      Fun.protect ~finally:(fun () -> close_in ic) (fun () ->
          let bytes = Bytes.create 8 in
          input ic bytes 0 8 > 0)
    with _ -> false
  in
  let udp_open =
    try
      let socket = Unix.socket ~cloexec:true Unix.PF_INET Unix.SOCK_DGRAM 0 in
      Fun.protect ~finally:(fun () -> Unix.close socket) (fun () ->
          Unix.connect socket (Unix.ADDR_INET (Unix.inet_addr_loopback, udp_port));
          ignore (Unix.write socket (Bytes.of_string "hi") 0 2);
          true)
    with _ -> false
  in
  let tcp_open =
    try
      let socket = Unix.socket ~cloexec:true Unix.PF_INET Unix.SOCK_STREAM 0 in
      Fun.protect ~finally:(fun () -> Unix.close socket) (fun () ->
          Unix.connect socket (Unix.ADDR_INET (Unix.inet_addr_loopback, tcp_port));
          true)
    with _ -> false
  in
  Printf.sprintf "stat=%d read=%d udp=%d tcp=%d" (if stat_visible then 1 else 0) (if content_visible then 1 else 0)
    (if udp_open then 1 else 0) (if tcp_open then 1 else 0)

let probe_isolation tools ~sentinel ~tcp_port ~udp_port =
  let work = Filename.temp_dir "ocagent-probe" "" in
  let null = Unix.openfile "/dev/null" [ Unix.O_RDWR ] 0o600 in
  Fun.protect ~finally:(fun () -> Unix.close null; remove_tree work) (fun () ->
      let marker = fresh_marker work in
      let deadline = Unix.gettimeofday () +. 5. in
      match
        run_userns ~deadline ~work ~snap:tools.root ~setup_fault:None ~marker ~stdout:null ~stderr:null
          (Call
             (fun () ->
               let line = contract_line ~sentinel ~tcp_port ~udp_port in
               let wrote_snap =
                 try
                   let oc = open_out (Filename.concat tools.root "ro-test") in
                   output_string oc "x";
                   close_out oc;
                   true
                 with _ -> false
               in
               let wrote_work =
                 try
                   let oc = open_out (Filename.concat work "proof") in
                   output_string oc !observed_netns;
                   close_out oc;
                   true
                 with _ -> false
               in
               say_limited (Printf.sprintf "%s snap=%d work=%d" line (if wrote_snap then 1 else 0) (if wrote_work then 1 else 0))))
      with
      | Ok line ->
          let proof = Filename.concat work "proof" in
          let child_ns = try read_file proof with _ -> "" in
          let parent_ns = try Unix.readlink "/proc/self/ns/net" with _ -> "" in
          if line = "stat=0 read=0 udp=0 tcp=0 snap=0 work=1" && child_ns <> "" && child_ns <> parent_ns && Sys.file_exists proof then Ok ()
          else Error (Unavailable ("isolation " ^ line ^ " ns=" ^ child_ns))
      | Error err -> Error err)

let probe_landlock ~work ~snap ~sentinel ~tcp_port ~udp_port =
  let deadline = Unix.gettimeofday () +. 3. in
  let read_fd, write_fd = Unix.pipe ~cloexec:true () in
  match Unix.fork () with
  | 0 -> (
      try
        Unix.dup2 write_fd Unix.stdout;
        clearenv ();
        let code = enter_landlock work snap in
        if code <> 0 then (say_limited ("FAIL " ^ stage_text code); exit 126);
        say_limited (contract_line ~sentinel ~tcp_port ~udp_port);
        exit 0
      with _ -> exit 126)
  | pid -> (
      Unix.close write_fd;
      match collect_child ~deadline pid read_fd with
      | Ok (text, Unix.WEXITED 0) ->
          let text = String.trim text in
          if String.equal text "stat=0 read=0 udp=0 tcp=0" then Ok () else Error (Unavailable ("landlock contract " ^ text))
      | Ok (text, _) -> Error (Unavailable (String.trim text))
      | Error _ as err -> err)

let () =
  landlock_note :=
    fun ~work ~snap msg ->
      let tcp = Unix.socket ~cloexec:true Unix.PF_INET Unix.SOCK_STREAM 0 in
      let udp = Unix.socket ~cloexec:true Unix.PF_INET Unix.SOCK_DGRAM 0 in
      Unix.bind tcp (Unix.ADDR_INET (Unix.inet_addr_loopback, 0));
      Unix.listen tcp 1;
      Unix.bind udp (Unix.ADDR_INET (Unix.inet_addr_loopback, 0));
      let port_of socket = match Unix.getsockname socket with Unix.ADDR_INET (_, port) -> port | _ -> 0 in
      let sentinel = Filename.temp_file "ocagent-gap" "" in
      Fun.protect
        ~finally:(fun () -> Unix.close tcp; Unix.close udp; (try Unix.unlink sentinel with Unix.Unix_error _ -> ()))
        (fun () ->
          match probe_landlock ~work ~snap ~sentinel ~tcp_port:(port_of tcp) ~udp_port:(port_of udp) with
          | Ok () -> Error (Unavailable (msg ^ " landlock contract met"))
          | Error (Unavailable gap) -> Error (Unavailable (msg ^ " " ^ gap))
          | Error _ as err -> err)
