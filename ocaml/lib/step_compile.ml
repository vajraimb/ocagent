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

let max_output = 262144
let compile_timeout = 30.0
let compile_as_bytes = 1024 * 1024 * 1024
let compile_file_bytes = 16 * 1024 * 1024

external limit_compiler : int -> int -> int -> int = "ocagent_limit_compiler"
external close_extra_fds : unit -> int = "ocagent_close_extra_fds"
external kill_group : int -> int = "ocagent_kill_group"

let which name =
  match Sys.getenv_opt "PATH" with
  | None -> None
  | Some path ->
      let rec go = function
        | [] -> None
        | dir :: rest ->
            let candidate = Filename.concat dir name in
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

external enter_jail : string -> string -> string -> string -> int = "ocagent_enter_jail"
external limits_must_fail : unit -> int = "ocagent_limits_must_fail"

let restricted_env ocamlc =
  let bindir = Filename.dirname ocamlc in
  let stdlib = Filename.concat (Filename.dirname bindir) "lib/ocaml" in
  if not (Sys.file_exists (Filename.concat stdlib "stdlib.cma")) then Error (Unavailable "ocaml stdlib")
  else Ok (stdlib, [| "LANG=C"; "OCAMLLIB=" ^ stdlib; "PATH=" ^ bindir |])

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

let read_some fd buf =
  try Some (Unix.read fd buf 0 (Bytes.length buf)) with
  | Unix.Unix_error ((Unix.EAGAIN | Unix.EWOULDBLOCK | Unix.EINTR), _, _) -> None

let stop_child pid fd =
  ignore (kill_group pid);
  (try Unix.kill pid Sys.sigkill with Unix.Unix_error _ -> ());
  (try ignore (Unix.waitpid [] pid) with Unix.Unix_error _ -> ());
  (try Unix.close fd with Unix.Unix_error _ -> ())

let collect_child ~deadline pid fd =
  Unix.set_nonblock fd;
  let buf = Buffer.create 64 in
  let bytes = Bytes.create 256 in
  let finished = ref false in
  Fun.protect
    ~finally:(fun () -> if not !finished then stop_child pid fd else (try Unix.close fd with Unix.Unix_error _ -> ()))
    (fun () ->
      let rec loop () =
        if Unix.gettimeofday () >= deadline then Error (Rejected "compile timeout")
        else
          match read_some fd bytes with
          | Some 0 -> (
              match Unix.waitpid [ Unix.WNOHANG ] pid with
              | 0, _ ->
                  Unix.sleepf 0.02;
                  loop ()
              | _, Unix.WEXITED 0 ->
                  finished := true;
                  Ok (Buffer.contents buf)
              | _, Unix.WEXITED 125 ->
                  finished := true;
                  Error (Unavailable "compiler limits")
              | _, Unix.WEXITED 126 ->
                  finished := true;
                  Error (Unavailable "compiler isolation")
              | _, Unix.WEXITED 127 ->
                  finished := true;
                  Error (Unavailable "compiler exec")
              | _, _ ->
                  finished := true;
                  Error (Rejected "compiler failed"))
          | Some n ->
              Buffer.add_subbytes buf bytes 0 n;
              if Buffer.length buf > 256 then Error (Rejected "compiler output") else loop ()
          | None -> (
              match Unix.waitpid [ Unix.WNOHANG ] pid with
              | 0, _ ->
                  Unix.sleepf 0.02;
                  loop ()
              | _, Unix.WEXITED 0 -> loop ()
              | _, Unix.WEXITED 125 ->
                  finished := true;
                  Error (Unavailable "compiler limits")
              | _, Unix.WEXITED 126 ->
                  finished := true;
                  Error (Unavailable "compiler isolation")
              | _, Unix.WEXITED 127 ->
                  finished := true;
                  Error (Unavailable "compiler exec")
              | _, _ ->
                  finished := true;
                  Error (Rejected "compiler failed"))
      in
      loop ())

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
          if close_extra_fds () <> 0 then exit 125;
          Unix.execve argv.(0) argv env
        with _ -> exit 127)
    | pid ->
        Unix.close write_fd;
        collect_child ~deadline pid read_fd

let probe ~deadline env bin args = spawn ~deadline ~env (Array.append [| bin |] args)

type tools = {
  ocamlc : string;
  ocamlrun : string;
  stdlib : string;
  env : string array;
  compiler_id : string;
  runtime_id : string;
}

let select_toolchain ~deadline =
  match (which "ocamlc", which "ocamlrun") with
  | None, _ -> Error (Unavailable "ocamlc")
  | _, None -> Error (Unavailable "ocamlrun")
  | Some ocamlc, Some ocamlrun -> (
      match restricted_env ocamlc with
      | Error _ as err -> err
      | Ok (stdlib, env) -> (
          match (probe ~deadline env ocamlc [| "-vnum" |], probe ~deadline env ocamlrun [| "-vnum" |]) with
          | Ok compiler_version, Ok runtime_version when toolchain_acceptable ~compiler:(String.trim compiler_version) ~runtime:(String.trim runtime_version) ->
              let compiler_version = String.trim compiler_version in
              let runtime_version = String.trim runtime_version in
              Ok
                {
                  ocamlc;
                  ocamlrun;
                  stdlib;
                  env;
                  compiler_id =
                    Printf.sprintf "ocamlc %s %s stdlib %s" compiler_version (hash_file ocamlc)
                      (hash_file (Filename.concat stdlib "stdlib.cma"));
                  runtime_id = Printf.sprintf "ocamlrun %s %s" runtime_version (hash_file ocamlrun);
                }
          | Error _ as err, _ -> err
          | _, (Error _ as err) -> err
          | _ -> Error (Unavailable "toolchain pair")))

let toolchain () =
  match select_toolchain ~deadline:(Unix.gettimeofday () +. 5.) with
  | Ok tools -> Ok (tools.compiler_id, tools.runtime_id)
  | Error _ as err -> err

let run ~dir ~deadline ~env ~ocamlc ~ocamlrun ~stdlib argv =
  if Unix.gettimeofday () >= deadline then Error (Rejected "compile timeout")
  else
    let stdout_path = Filename.concat dir "tool.out" in
    let stderr_path = Filename.concat dir "tool.err" in
    match Unix.fork () with
    | 0 -> (
        try
          let null = Unix.openfile "/dev/null" [ Unix.O_RDONLY ] 0 in
          let out = Unix.openfile stdout_path [ Unix.O_WRONLY; Unix.O_CREAT; Unix.O_TRUNC ] 0o600 in
          let err = Unix.openfile stderr_path [ Unix.O_WRONLY; Unix.O_CREAT; Unix.O_TRUNC ] 0o600 in
          Unix.dup2 null Unix.stdin;
          Unix.dup2 out Unix.stdout;
          Unix.dup2 err Unix.stderr;
          if limit_compiler 30 compile_as_bytes compile_file_bytes <> 0 then exit 125;
          if close_extra_fds () <> 0 then exit 125;
          if enter_jail dir ocamlc ocamlrun stdlib <> 0 then exit 126;
          Unix.chdir dir;
          Unix.execve argv.(0) argv env
        with _ -> exit 127)
    | pid -> (
        let rec wait () =
          match Unix.waitpid [ Unix.WNOHANG ] pid with
          | 0, _ when Unix.gettimeofday () >= deadline ->
              ignore (kill_group pid);
              (try Unix.kill pid Sys.sigkill with Unix.Unix_error _ -> ());
              ignore (Unix.waitpid [] pid);
              Error (Rejected "compile timeout")
          | 0, _ ->
              Unix.sleepf 0.02;
              wait ()
          | _, Unix.WEXITED 0 ->
              let out_len = (Unix.stat stdout_path).st_size in
              let err_len = (Unix.stat stderr_path).st_size in
              if out_len > max_output || err_len > max_output then Error (Rejected "compiler output") else Ok ()
          | _, Unix.WEXITED 125 -> Error (Unavailable "compiler limits")
          | _, Unix.WEXITED 126 -> Error (Unavailable "compiler isolation")
          | _, Unix.WEXITED 127 -> Error (Unavailable "compiler exec")
          | _, _ ->
              let message =
                if Sys.file_exists stderr_path then
                  let text = read_file stderr_path in
                  if String.length text > 500 then String.sub text 0 500 else text
                else "compiler failed"
              in
              Error (Rejected message)
        in
        Fun.protect
          ~finally:(fun () ->
            let jail = Printf.sprintf "/tmp/ocagent-jail-%d" pid in
            try Unix.rmdir jail with Unix.Unix_error _ -> ())
          wait)

let bounded_command ~timeout argv =
  match spawn ~deadline:(Unix.gettimeofday () +. timeout) ~env:[| "LANG=C" |] argv with
  | Ok _ as ok -> ok
  | Error _ as err -> err

let limits_failure marker =
  match Unix.fork () with
  | 0 -> if limits_must_fail () = 0 then (let oc = open_out marker in output_string oc "ran"; close_out oc; exit 0) else exit 125
  | pid -> (
      let _, status = Unix.waitpid [] pid in
      if Sys.file_exists marker then Error (Rejected "fallback")
      else
        match status with
        | Unix.WEXITED 125 -> Error (Unavailable "compiler limits")
        | _ -> Error (Unavailable "compiler limits"))

let isolation_probe ~sentinel =
  let rec cleanup dir =
    if Sys.file_exists dir then (
      Array.iter
        (fun name ->
          let path = Filename.concat dir name in
          if Sys.is_directory path then cleanup path else Unix.unlink path)
        (Sys.readdir dir);
      Unix.rmdir dir)
  in
  let dir = Filename.temp_dir "ocagent-iso" "" in
  Fun.protect ~finally:(fun () -> cleanup dir) (fun () ->
      match select_toolchain ~deadline:(Unix.gettimeofday () +. 5.) with
      | Error _ as err -> err
      | Ok tools -> (
          match Unix.fork () with
          | 0 -> (
              try
                if enter_jail dir tools.ocamlc tools.ocamlrun tools.stdlib <> 0 then exit 126;
                if Sys.file_exists sentinel then exit 3;
                (try
                   let oc = open_out (Filename.concat dir "proof") in
                   output_string oc "ok";
                   close_out oc
                 with _ -> exit 5);
                let connected =
                  try
                    let socket = Unix.socket ~cloexec:true Unix.PF_INET Unix.SOCK_STREAM 0 in
                    Unix.connect socket (Unix.ADDR_INET (Unix.inet_addr_of_string "127.0.0.1", 9));
                    true
                  with _ -> false
                in
                exit (if connected then 4 else 0)
              with _ -> exit 126)
          | pid -> (
              let _, status = Unix.waitpid [] pid in
              (try Unix.rmdir (Printf.sprintf "/tmp/ocagent-jail-%d" pid) with Unix.Unix_error _ -> ());
              match status with
              | Unix.WEXITED 0 when Sys.file_exists (Filename.concat dir "proof") -> Ok ()
              | Unix.WEXITED 126 -> Error (Unavailable "compiler isolation")
              | _ -> Error (Unavailable "compiler isolation"))))

let rec remove_tree dir =
  if Sys.file_exists dir then (
    let entries = Sys.readdir dir in
    Array.iter
      (fun name ->
        let path = Filename.concat dir name in
        if Sys.is_directory path then remove_tree path else Unix.unlink path)
      entries;
    Unix.rmdir dir)

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

let bounded text =
  if String.length text > 262144 then false
  else
    let depth = ref 0 in
    let max_depth = ref 0 in
    String.iter
      (fun c ->
        match c with
        | '(' | '{' | '[' ->
            incr depth;
            if !depth > !max_depth then max_depth := !depth
        | ')' | '}' | ']' -> if !depth > 0 then decr depth
        | _ -> ())
      text;
    !max_depth <= 128

let compile ~source ~modules ~input =
  if List.length modules > 16 then Error (Rejected "too many modules")
  else if not (bounded source) || List.exists (fun item -> not (bounded item.source && bounded item.interface_)) modules then
    Error (Rejected "too big")
  else if List.exists (fun (key, value) -> not (bounded key && bounded value)) input then Error (Rejected "too big")
  else
    let deadline = Unix.gettimeofday () +. compile_timeout in
    match (sdk_dir (), select_toolchain ~deadline, input_text input) with
    | Error _ as err, _, _ | _, (Error _ as err), _ | _, _, (Error _ as err) -> err
    | Ok sdk, Ok tools, Ok input_bytes -> (
        let names = List.map (fun item -> item.name) modules in
        if List.exists (fun name -> not (module_name_ok name)) names then Error (Rejected "module name")
        else if List.length names <> List.length (List.sort_uniq String.compare names) then Error (Rejected "duplicate module")
        else
          let users = "Step" :: names in
          match Step_validate.implementation ~users source with
          | Error (Step_validate.Rejected msg) -> Error (Rejected msg)
          | Ok () -> (
              let rec mods = function
                | [] -> Ok ()
                | item :: rest -> (
                    match Step_validate.interface ~users item.interface_ with
                    | Error (Step_validate.Rejected msg) -> Error (Rejected msg)
                    | Ok () -> (
                        match Step_validate.implementation ~users item.source with
                        | Error (Step_validate.Rejected msg) -> Error (Rejected msg)
                        | Ok () -> mods rest))
              in
              match mods modules with
              | Error _ as err -> err
              | Ok () -> (
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
                      match tools.ocamlc with
                      | ocamlc -> (
                          let rec build = function
                            | [] -> Ok ()
                            | args :: rest -> (
                                match run ~dir ~deadline ~env:tools.env ~ocamlc ~ocamlrun:tools.ocamlrun ~stdlib:tools.stdlib (Array.of_list (ocamlc :: args)) with
                                | Error _ as err -> err
                                | Ok () -> build rest)
                          in
                          let user_cmds =
                            List.concat_map
                              (fun item ->
                                [
                                  [ "-I"; dir; "-bin-annot"; "-c"; item.name ^ ".mli" ];
                                  [ "-I"; dir; "-bin-annot"; "-c"; item.name ^ ".ml" ];
                                ])
                              modules
                          in
                          let cmds =
                            [ [ "-I"; dir; "-bin-annot"; "-c"; "step_api.mli" ]; [ "-I"; dir; "-bin-annot"; "-c"; "step_api.ml" ] ]
                            @ user_cmds
                            @ [
                                [ "-I"; dir; "-bin-annot"; "-c"; "step.ml" ];
                                [ "-I"; dir; "-bin-annot"; "-c"; "step_check.ml" ];
                                [ "-I"; dir; "-c"; "step_driver.ml" ];
                              ]
                          in
                          match build cmds with
                          | Error _ as err -> err
                          | Ok () -> (
                              let rec typed = function
                                | [] -> Ok ()
                                | name :: rest -> (
                                    match Step_validate.scan_cmt ~users (Filename.concat dir (name ^ ".cmt")) with
                                    | Error (Step_validate.Rejected msg) -> Error (Rejected msg)
                                    | Ok () -> typed rest)
                              in
                              match typed ("step" :: names) with
                              | Error _ as err -> err
                              | Ok () -> (
                                  let objects =
                                    "step_api.cmo"
                                    :: List.map (fun item -> item.name ^ ".cmo") modules
                                    @ [ "step.cmo"; "step_check.cmo"; "step_driver.cmo" ]
                                  in
                                  match run ~dir ~deadline ~env:tools.env ~ocamlc ~ocamlrun:tools.ocamlrun ~stdlib:tools.stdlib (Array.of_list (ocamlc :: ("-I" :: dir :: "-o" :: "worker" :: objects))) with
                                  | Error _ as err -> err
                                  | Ok () ->
                                      let bytecode = read_file (Filename.concat dir "worker") in
                                      if String.length bytecode > (16 * 1024 * 1024) then Error (Rejected "artifact")
                                      else if not (String.starts_with ~prefix:"#!" bytecode) then Error (Rejected "bytecode")
                                      else
                                        let module_bytes =
                                          List.map
                                            (fun item ->
                                              let object_bytes = read_file (Filename.concat dir (item.name ^ ".cmo")) in
                                              {
                                                Step_manifest.name = item.name;
                                                source = item.source;
                                                interface_ = item.interface_;
                                                artifact = object_bytes;
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
                                          })))))))

let admit ~path ~run_id ~agent_version ~admission_key artifact =
  match Store.admit_step ~path ~run_id ~agent_version ~admission_key artifact.bundle with
  | Ok manifest -> Ok manifest
  | Error err -> Error (Store err)

