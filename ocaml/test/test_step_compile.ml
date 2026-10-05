(** T1/T2: validate, compile, and admit a real bytecode artifact.
    The worker is not started past the driver's refusal. *)

module C = Ocagent_harness.Step_compile
module S = Ocagent_harness.Store
module M = Step_manifest

let fail fmt = Printf.ksprintf failwith fmt

let helper =
  {
    C.name = "Helper";
    source = "let valid material body = String.equal material body\n";
    interface_ = "val valid : string -> string -> bool\n";
  }

let step =
  {|open Step_api

module Step : STEP = struct
  let run () =
    match Input.get "material", Input.get "fetch_url" with
    | Some material, Some url -> (
        match Net.get url with
        | Ok r when r.status = 200 && Helper.valid material r.body -> Done "validated"
        | Ok _ -> Partial "validation failed"
        | Error (Net.Approval_rejected reason) -> Done reason
        | Error (Net.Denied reason) -> Done reason)
    | _ -> Partial "missing fixed input"
end
|}

let fresh () =
  let dir = Filename.temp_dir "ocagent-admit" "" in
  Filename.concat dir "snapshot.json"

let compile_ok () =
  match C.compile ~source:step ~modules:[ helper ] ~input:[ ("material", "spec-body"); ("fetch_url", "http://127.0.0.1/spec") ] with
  | Ok artifact -> artifact
  | Error err -> fail "compile %s" (C.describe err)

let () =
  let absent = fresh () in
  (match C.compile ~source:"let run () = 1\n" ~modules:[] ~input:[] with
  | Error (C.Rejected _) -> ()
  | Ok _ -> fail "type error was compiled"
  | Error err -> fail "type error %s" (C.describe err));
  if Sys.file_exists absent then fail "rejected compile created a snapshot";
  let init =
    {|open Step_api
module Step : STEP = struct
  let warm = Input.get "material"
  let run () = Partial "no"
end
|}
  in
  (match C.compile ~source:init ~modules:[] ~input:[] with
  | Error (C.Rejected _) -> ()
  | Ok _ -> fail "initialization was compiled"
  | Error err -> fail "init %s" (C.describe err));
  let unix_alias =
    {|open Step_api
module U = Unix
module Step : STEP = struct
  let run () = ignore (U.gettimeofday ()); Done "x"
end
|}
  in
  (match C.compile ~source:unix_alias ~modules:[] ~input:[] with
  | Error (C.Rejected msg) when String.starts_with ~prefix:"forbidden module" msg -> ()
  | Error (C.Rejected msg) -> fail "alias rejected as %s" msg
  | Ok _ -> fail "Unix alias was compiled"
  | Error err -> fail "alias %s" (C.describe err));
  let higher =
    {|open Step_api
module Step : STEP = struct
  let call f = f ()
  let run () = ignore (call Unix.gettimeofday); Done "x"
end
|}
  in
  (match C.compile ~source:higher ~modules:[] ~input:[] with
  | Error (C.Rejected _) -> ()
  | Ok _ -> fail "higher-order Unix was compiled"
  | Error err -> fail "higher %s" (C.describe err));
  let extension = "[%%not_supported]\n" in
  (match C.compile ~source:extension ~modules:[] ~input:[] with
  | Error (C.Rejected _) -> ()
  | Ok _ -> fail "extension was compiled"
  | Error err -> fail "extension %s" (C.describe err));
  let artifact = compile_ok () in
  let path = fresh () in
  let manifest =
    match C.admit ~path ~run_id:"run" ~agent_version:"step-v3" ~admission_key:"adm" artifact with
    | Ok manifest -> manifest
    | Error err -> fail "admit %s" (C.describe err)
  in
  let compiler_id, runtime_id =
    match C.toolchain () with
    | Ok ids -> ids
    | Error err -> fail "toolchain %s" (C.describe err)
  in
  if manifest.compiler_id <> compiler_id || manifest.runtime_id <> runtime_id then fail "toolchain id was not bound";
  let bytes =
    match S.read_blob ~path ~hash:manifest.artifact_hash ~kind:S.Artifact with
    | Ok bytes -> bytes
    | Error err -> fail "read artifact %s" (S.describe err)
  in
  if bytes = "" || (not (String.starts_with ~prefix:"#!" bytes)) || not (String.exists (fun c -> c = 'C') bytes) then
    fail "artifact is not bytecode";
  if M.sha256 bytes <> manifest.artifact_hash then fail "artifact hash does not match the stored bytes";
  let worker = Filename.temp_file "ocagent-worker" "" in
  let oc = open_out_bin worker in
  output_string oc bytes;
  close_out oc;
  let pid = Unix.create_process "ocamlrun" [| "ocamlrun"; worker |] Unix.stdin Unix.stdout Unix.stderr in
  let _, status = Unix.waitpid [] pid in
  Unix.unlink worker;
  (match status with
  | Unix.WEXITED 2 -> ()
  | _ -> fail "bytecode did not stop before Step.run");
  let before = S.file_bytes path in
  let epoch = (match S.read_snapshot path with Ok snap -> snap.epoch | Error err -> fail "snap %s" (S.describe err)) in
  (match S.preflight ~path ~execution_hash:manifest.execution_hash ~compiler_id ~runtime_id with
  | Ok S.Ready -> ()
  | Ok (S.Stored _) -> fail "prepared step looked completed"
  | Error err -> fail "preflight %s" (S.describe err));
  let blob = S.read_blob ~path ~hash:manifest.artifact_hash ~kind:S.Artifact in
  let blob_path =
    match blob with
    | Ok _ ->
        let dir = Filename.concat (Filename.dirname path) "step-blobs" in
        Filename.concat dir manifest.artifact_hash
    | Error err -> fail "blob %s" (S.describe err)
  in
  Unix.unlink blob_path;
  (match S.preflight ~path ~execution_hash:manifest.execution_hash ~compiler_id ~runtime_id with
  | Error S.Artifact_missing -> ()
  | Ok _ -> fail "missing artifact was ready"
  | Error err -> fail "missing %s" (S.describe err));
  if S.file_bytes path <> before then fail "missing artifact rewrote the snapshot";
  let epoch2 = match S.read_snapshot path with Ok snap -> snap.epoch | Error err -> fail "snap2 %s" (S.describe err) in
  if epoch2 <> epoch then fail "missing artifact changed the epoch";
  let huge = String.make 262145 'a' in
  let huge_path = fresh () in
  let bundle =
    {
      M.source = huge;
      modules = [];
      compiler_id = "ocamlc";
      runtime_id = "ocamlrun";
      sdk = "sdk";
      driver = "driver";
      artifact = "artifact-bytes";
      base_workspace = "";
      input_context = "{}";
      capability_grant = "net";
      policy_version = "p";
    }
  in
  (match S.admit_step ~path:huge_path ~run_id:"run" ~agent_version:"step-v3" ~admission_key:"adm" bundle with
  | Error (S.Protocol "too big") -> ()
  | Ok _ -> fail "oversized source was admitted"
  | Error err -> fail "oversize %s" (S.describe err));
  if Sys.file_exists huge_path then fail "oversized source wrote a snapshot";
  let binary = String.make 300000 '\x00' in
  let binary_path = fresh () in
  (match
     S.admit_step ~path:binary_path ~run_id:"run" ~agent_version:"step-v3" ~admission_key:"adm"
       { bundle with M.source = "let run () = Done \"ok\"\n"; artifact = binary }
   with
  | Ok manifest ->
      let stored =
        match S.read_blob ~path:binary_path ~hash:manifest.artifact_hash ~kind:S.Artifact with
        | Ok stored -> stored
        | Error err -> fail "binary read %s" (S.describe err)
      in
      if stored <> binary then fail "binary artifact was not stored whole";
      let workspace = M.sha256 "ws" in
      (match
         S.with_step_executor ~path:binary_path ~execution_hash:manifest.execution_hash (fun ex ->
             S.complete_step ex ~cursor:0 ~reply:(M.Done "done") ~workspace_hash:workspace)
       with
      | Ok (S.Resumed ()) -> ()
      | Ok (S.Stored_completion _) -> fail "first completion looked stored"
      | Error err -> fail "complete %s" (S.describe err));
      let blob_path = Filename.concat (Filename.concat (Filename.dirname binary_path) "step-blobs") manifest.artifact_hash in
      Unix.unlink blob_path;
      let closed = S.file_bytes binary_path in
      (match S.preflight ~path:binary_path ~execution_hash:manifest.execution_hash ~compiler_id:"gone" ~runtime_id:"gone" with
      | Ok (S.Stored { reply = M.Done "done"; workspace = got }) when got = workspace -> ()
      | Ok _ -> fail "completed query changed the reply"
      | Error err -> fail "completed query %s" (S.describe err));
      if S.file_bytes binary_path <> closed then fail "completed query wrote the snapshot"
  | Error err -> fail "binary admit %s" (S.describe err));
  print_endline "step compile ok"
