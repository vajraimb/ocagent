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
external close_extra_fds : int -> int = "ocagent_close_extra_fds"
external kill_group : int -> int = "ocagent_kill_group"
external getpgid : int -> int = "ocagent_getpgid"
external realpath : string -> string = "ocagent_realpath"
external enter_userns : string -> string -> int = "ocagent_enter_userns"
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
  (try Unix.kill pid Sys.sigkill with Unix.Unix_error _ -> ())

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
          if close_extra_fds (-1) <> 0 then exit 125;
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
              let bin = Filename.concat root "bin" in
              let libdir = Filename.concat root "lib" in
              let stdlib = Filename.concat root "stdlib" in
              Unix.mkdir bin 0o700;
              Unix.mkdir libdir 0o700;
              Unix.mkdir stdlib 0o700;
              copy_file ocamlc_path (Filename.concat bin "ocamlc");
              copy_file ocamlrun_path (Filename.concat bin "ocamlrun");
              copy_file loader_src (Filename.concat root "ld-linux");
              copy_file libc_src (Filename.concat libdir "libc.so.6");
              copy_file libm_src (Filename.concat libdir "libm.so.6");
              List.iter (fun name -> copy_file (Filename.concat stdlib_src name) (Filename.concat stdlib name)) (list_files stdlib_src);
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
                  Ok
                    {
                      tools with
                      compiler_id = Printf.sprintf "ocamlc %s manifest %s" compiler_version hash;
                      runtime_id = Printf.sprintf "ocamlrun %s manifest %s" runtime_version hash;
                    }
              | Error _ as err, _ ->
                  remove_tree root;
                  err
              | _, (Error _ as err) ->
                  remove_tree root;
                  err
              | _ ->
                  remove_tree root;
                  Error (Unavailable "toolchain pair"))

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

let isolate ~work ~snap =
  let userns = enter_userns work snap in
  if userns = 0 then Ok ()
  else if userns / 1000 = 3 then
    let other = enter_landlock work snap in
    if other = 0 then Ok () else Error (stage_text userns ^ " " ^ stage_text other)
  else Error (stage_text userns)

let become_isolated ~setup_fault ~work ~snap =
  let rc = limit_compiler 30 compile_as_bytes compile_file_bytes in
  match setup_fault with
  | Some Rlimit -> Error "rlimit 1"
  | Some Descriptors -> Error "fd 1"
  | Some Isolation -> (
      match isolate ~work:"/no/such-ocagent-work" ~snap:"/no/such-ocagent-snap" with
      | Ok () -> Error "isolation 0"
      | Error _ as err -> err)
  | None when rc <> 0 -> Error ("rlimit " ^ string_of_int (abs rc))
  | None -> isolate ~work ~snap

let launch ~deadline ~work ~tools ~setup_fault args =
  if Unix.gettimeofday () >= deadline then Error (Rejected "compile timeout")
  else
    let stdout_path = Filename.concat work "tool.out" in
    let stderr_path = Filename.concat work "tool.err" in
    let marker = Filename.concat work "exec-marker" in
    let read_fd, write_fd = Unix.pipe ~cloexec:true () in
    match Unix.fork () with
    | 0 -> (
        try
          let null = Unix.openfile "/dev/null" [ Unix.O_RDONLY ] 0 in
          let out = Unix.openfile stdout_path [ Unix.O_WRONLY; Unix.O_CREAT; Unix.O_TRUNC ] 0o600 in
          let err = Unix.openfile stderr_path [ Unix.O_WRONLY; Unix.O_CREAT; Unix.O_TRUNC ] 0o600 in
          Unix.dup2 null Unix.stdin;
          Unix.dup2 out Unix.stdout;
          Unix.dup2 err Unix.stderr;
          let keep = to_int write_fd in
          let report msg =
            let bytes = Bytes.of_string msg in
            ignore (Unix.write write_fd bytes 0 (Bytes.length bytes))
          in
          (match setup_fault with
          | Some Descriptors -> if close_extra_fds keep <> 0 then ()
          | _ -> if close_extra_fds keep <> 0 then (report "FAIL fd 1\n"; exit 126));
          (match become_isolated ~setup_fault ~work ~snap:tools.root with
          | Error msg ->
              report ("FAIL " ^ msg ^ "\n");
              exit 126
          | Ok () -> ());
          Unix.chdir work;
          write_exact marker "exec";
          report "OK\n";
          Unix.close write_fd;
          let argv = loader_argv tools tools.ocamlc args in
          Unix.execve argv.(0) argv tools.env
        with _ -> exit 127)
    | pid -> (
        Unix.close write_fd;
        Fun.protect
          ~finally:(fun () -> try Unix.rmdir (Printf.sprintf "/tmp/ocagent-jail-%d" pid) with Unix.Unix_error _ -> ())
          (fun () ->
            match collect_child ~deadline pid read_fd with
            | Error _ as err -> err
            | Ok (text, Unix.WEXITED 0) -> (
                match status_of text with
                | Ok () ->
                    let out_len = (Unix.stat stdout_path).st_size in
                    let err_len = (Unix.stat stderr_path).st_size in
                    if out_len > max_output || err_len > max_output then Error (Rejected "compiler output") else Ok ()
                | Error _ as err -> err)
            | Ok (text, Unix.WEXITED 126) -> (
                match status_of text with
                | Error (Unavailable _) as err -> if Sys.file_exists marker then Error (Rejected "fallback") else err
                | Error _ as err -> err
                | Ok () -> Error (Unavailable "status"))
            | Ok (text, Unix.WEXITED 127) -> Error (Unavailable ("compiler exec " ^ String.trim text))
            | Ok (_, Unix.WEXITED _) ->
                let message =
                  if Sys.file_exists stderr_path then
                    let text = read_file stderr_path in
                    if String.length text > 500 then String.sub text 0 500 else text
                  else "compiler failed"
                in
                Error (Rejected message)
            | Ok _ -> Error (Rejected "compiler failed")))

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

let validate_child ~deadline ~users source modules =
  if Unix.gettimeofday () >= deadline then Error (Rejected "compile timeout")
  else
    let read_fd, write_fd = Unix.pipe ~cloexec:true () in
    match Unix.fork () with
    | 0 -> (
        try
          if limit_compiler 30 compile_as_bytes compile_file_bytes <> 0 then exit 125;
          Unix.dup2 write_fd Unix.stdout;
          Unix.close read_fd;
          let say msg =
            let msg = if String.length msg > 500 then String.sub msg 0 500 else msg in
            output_string stdout (msg ^ "\n");
            flush stdout
          in
          let rec mods = function
            | [] -> say "OK"; exit 0
            | item :: rest -> (
                match Step_validate.interface ~users item.interface_ with
                | Error (Step_validate.Rejected msg) -> say msg; exit 2
                | Ok () -> (
                    match Step_validate.implementation ~users item.source with
                    | Error (Step_validate.Rejected msg) -> say msg; exit 2
                    | Ok () -> mods rest))
          in
          match Step_validate.implementation ~users source with
          | Error (Step_validate.Rejected msg) -> say msg; exit 2
          | Ok () -> mods modules
        with _ -> exit 2)
    | pid -> (
        Unix.close write_fd;
        match collect_child ~deadline pid read_fd with
        | Ok (text, Unix.WEXITED 0) when String.trim text = "OK" -> Ok ()
        | Ok (text, Unix.WEXITED 2) -> Error (Rejected (String.trim text))
        | Ok (_, Unix.WEXITED 125) -> Error (Unavailable "validator limits")
        | Error (Rejected "compile timeout") -> Error (Rejected "compile timeout")
        | Error (Rejected "compiler output") -> Error (Rejected "validator output")
        | Ok _ -> Error (Rejected "validator")
        | Error _ as err -> err)

let validate_cmt ~deadline ~users dir names =
  if Unix.gettimeofday () >= deadline then Error (Rejected "compile timeout")
  else
    let read_fd, write_fd = Unix.pipe ~cloexec:true () in
    match Unix.fork () with
    | 0 -> (
        try
          if limit_compiler 30 compile_as_bytes compile_file_bytes <> 0 then exit 125;
          Unix.dup2 write_fd Unix.stdout;
          Unix.close read_fd;
          let rec go = function
            | [] -> output_string stdout "OK\n"; exit 0
            | name :: rest -> (
                match Step_validate.scan_cmt ~users (Filename.concat dir (name ^ ".cmt")) with
                | Error (Step_validate.Rejected msg) ->
                    output_string stdout ((if String.length msg > 500 then String.sub msg 0 500 else msg) ^ "\n");
                    exit 2
                | Ok () -> go rest)
          in
          go names
        with _ -> exit 2)
    | pid -> (
        Unix.close write_fd;
        match collect_child ~deadline pid read_fd with
        | Ok (text, Unix.WEXITED 0) when String.trim text = "OK" -> Ok ()
        | Ok (text, Unix.WEXITED 2) -> Error (Rejected (String.trim text))
        | Error _ as err -> err
        | Ok _ -> Error (Rejected "validator"))

let compile_with ~setup_fault ~deadline tools ~source ~modules ~input =
  match (sdk_dir (), input_text input) with
  | Error _ as err, _ | _, (Error _ as err) -> err
  | Ok sdk, Ok input_bytes -> (
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
              (fun item -> [ [ "-I"; dir; "-bin-annot"; "-c"; item.name ^ ".mli" ]; [ "-I"; dir; "-bin-annot"; "-c"; item.name ^ ".ml" ] ])
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
                match launch ~deadline ~work:dir ~tools ~setup_fault args with
                | Error _ as err -> err
                | Ok () -> build rest)
          in
          match build cmds with
          | Error _ as err -> err
          | Ok () -> (
              match validate_cmt ~deadline ~users:("Step" :: List.map (fun item -> item.name) modules) dir ("step" :: List.map (fun item -> item.name) modules) with
              | Error _ as err -> err
              | Ok () -> (
                  let objects = "step_api.cmo" :: List.map (fun item -> item.name ^ ".cmo") modules @ [ "step.cmo"; "step_check.cmo"; "step_driver.cmo" ] in
                  match launch ~deadline ~work:dir ~tools ~setup_fault ("-I" :: dir :: "-o" :: "worker" :: objects) with
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
                          }))))

let compile_go ~setup_fault ~source ~modules ~input =
  if List.length modules > 16 then Error (Rejected "too many modules")
  else if (not (text_ok source)) || List.exists (fun item -> not (text_ok item.source && text_ok item.interface_)) modules then Error (Rejected "too big")
  else if List.exists (fun (key, value) -> not (text_ok key && text_ok value)) input then Error (Rejected "too big")
  else
    let names = List.map (fun item -> item.name) modules in
    if List.exists (fun name -> not (module_name_ok name)) names then Error (Rejected "module name")
    else if List.length names <> List.length (List.sort_uniq String.compare names) then Error (Rejected "duplicate module")
    else
      let deadline = Unix.gettimeofday () +. compile_timeout in
      let users = "Step" :: names in
      match validate_child ~deadline ~users source modules with
      | Error _ as err -> err
      | Ok () -> (
          match select_toolchain ~deadline with
          | Error _ as err -> err
          | Ok tools -> Fun.protect ~finally:(fun () -> release tools) (fun () -> compile_with ~setup_fault ~deadline tools ~source ~modules ~input))

let compile ~source ~modules ~input = compile_go ~setup_fault:None ~source ~modules ~input

let compile_fault setup_fault ~source ~modules ~input = compile_go ~setup_fault:(Some setup_fault) ~source ~modules ~input

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
        if close_extra_fds (-1) <> 0 then exit 125;
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

let probe_isolation tools ~sentinel ~port =
  let work = Filename.temp_dir "ocagent-probe" "" in
  Fun.protect ~finally:(fun () -> remove_tree work) (fun () ->
      match Unix.fork () with
      | 0 -> (
          try
            match become_isolated ~setup_fault:None ~work ~snap:tools.root with
            | Error _ -> exit 126
            | Ok () ->
                if Sys.file_exists sentinel then exit 3;
                let wrote_snap =
                  try
                    let oc = open_out (Filename.concat tools.root "ro-test") in
                    output_string oc "x";
                    close_out oc;
                    true
                  with _ -> false
                in
                if wrote_snap then exit 6;
                (try
                   let oc = open_out (Filename.concat work "proof") in
                   output_string oc "ok";
                   close_out oc
                 with _ -> exit 5);
                let connected =
                  try
                    let socket = Unix.socket ~cloexec:true Unix.PF_INET Unix.SOCK_STREAM 0 in
                    Unix.connect socket (Unix.ADDR_INET (Unix.inet_addr_loopback, port));
                    true
                  with _ -> false
                in
                exit (if connected then 4 else 0)
          with _ -> exit 126)
      | pid -> (
          let _, status = Unix.waitpid [] pid in
          (try Unix.rmdir (Printf.sprintf "/tmp/ocagent-jail-%d" pid) with Unix.Unix_error _ -> ());
          match status with
          | Unix.WEXITED 0 when Sys.file_exists (Filename.concat work "proof") -> Ok ()
          | Unix.WEXITED 126 -> Error (Unavailable "isolation")
          | Unix.WEXITED code -> Error (Unavailable ("isolation " ^ string_of_int code))
          | _ -> Error (Unavailable "isolation")))
