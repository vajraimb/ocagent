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

let toolchain () =
  match (which "ocamlc", which "ocamlrun") with
  | None, _ -> Error (Unavailable "ocamlc")
  | _, None -> Error (Unavailable "ocamlrun")
  | Some ocamlc, Some ocamlrun ->
      Ok
        ( Printf.sprintf "ocamlc 5.3.0 %s" (hash_file ocamlc),
          Printf.sprintf "ocamlrun 5.3.0 %s" (hash_file ocamlrun) )

let run ~dir argv =
  let stdout_path = Filename.concat dir "tool.out" in
  let stderr_path = Filename.concat dir "tool.err" in
  match Unix.fork () with
  | 0 -> (
      try
        Unix.chdir dir;
        let out = Unix.openfile stdout_path [ Unix.O_WRONLY; Unix.O_CREAT; Unix.O_TRUNC ] 0o600 in
        let err = Unix.openfile stderr_path [ Unix.O_WRONLY; Unix.O_CREAT; Unix.O_TRUNC ] 0o600 in
        Unix.dup2 out Unix.stdout;
        Unix.dup2 err Unix.stderr;
        Unix.execv argv.(0) argv
      with _ -> exit 127)
  | pid ->
      let deadline = Unix.gettimeofday () +. compile_timeout in
      let rec wait () =
        match Unix.waitpid [ Unix.WNOHANG ] pid with
        | 0, _ when Unix.gettimeofday () > deadline ->
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
        | _, _ ->
            let message =
              if Sys.file_exists stderr_path then
                let text = read_file stderr_path in
                if String.length text > 500 then String.sub text 0 500 else text
              else "compiler failed"
            in
            Error (Rejected message)
      in
      wait ()

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

let compile ~source ~modules ~input =
  if List.length modules > 16 then Error (Rejected "too many modules")
  else
    match (sdk_dir (), toolchain (), input_text input) with
    | Error _ as err, _, _ | _, (Error _ as err), _ | _, _, (Error _ as err) -> err
    | Ok sdk, Ok (compiler_id, runtime_id), Ok input_bytes -> (
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
                      match which "ocamlc" with
                      | None -> Error (Unavailable "ocamlc")
                      | Some ocamlc -> (
                          let rec build = function
                            | [] -> Ok ()
                            | args :: rest -> (
                                match run ~dir (Array.of_list (ocamlc :: args)) with
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
                                  match run ~dir (Array.of_list (ocamlc :: ("-I" :: dir :: "-o" :: "worker" :: objects))) with
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
                                                compiler_id;
                                                runtime_id;
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

