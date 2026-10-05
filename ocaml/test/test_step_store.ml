(** Step admission on an OCAGENT 3 snapshot. No worker is started. *)

module S = Ocagent_harness.Store
module M = Step_manifest

let fail fmt = Printf.ksprintf failwith fmt

let ok = function
  | Ok v -> v
  | Error err -> fail "%s" (S.describe err)

let fresh () =
  let dir =
    Filename.concat (Filename.get_temp_dir_name ())
      (Printf.sprintf "ocagent-step-%d-%d" (Unix.getpid ()) (Random.bits ()))
  in
  Unix.mkdir dir 0o755;
  Filename.concat dir "snapshot.json"

let bundle source =
  {
    M.source;
    modules =
      [
        {
          M.name = "Helper";
          source = "let answer = 1\n";
          interface_ = "val answer : int\n";
          artifact = "cmx-a";
        };
      ];
    compiler_id = "ocaml-5.3.0";
    runtime_id = "ocaml-5.3.0";
    sdk = "sdk-v1";
    driver = "driver-v1";
    artifact = "artifact-bytes";
    base_workspace = "materials";
    input_context = "ctx";
    capability_grant = "files,net.get";
    policy_version = "p0b-1";
  }

let admit path source key =
  S.admit_step ~path ~run_id:"run" ~agent_version:"step-v3" ~admission_key:key (bundle source)

let () =
  let path = fresh () in
  let first = ok (admit path "let run () = Done \"ok\"\n" "adm") in
  if first.M.step_id <> "0" || first.step_seq <> 0 then fail "step id";
  let bytes = S.file_bytes path in
  let rev = (ok (S.read_snapshot path)).revision in
  let again = ok (admit path "let run () = Done \"ok\"\n" "adm") in
  if again.execution_hash <> first.execution_hash || again.step_id <> first.step_id then fail "retry changed identity";
  if S.file_bytes path <> bytes || (ok (S.read_snapshot path)).revision <> rev then fail "retry wrote the snapshot";
  let before = S.file_bytes path in
  (match admit path "let run () = Done \"other\"\n" "adm" with
  | Error S.Admission_conflict -> ()
  | Ok _ -> fail "changed source was accepted"
  | Error err -> fail "conflict %s" (S.describe err));
  if S.file_bytes path <> before then fail "conflict wrote the snapshot";
  (match admit path "let run () = Done \"ok\"\n" "other" with
  | Error S.Multiple_steps_unsupported -> ()
  | Ok _ -> fail "second step was accepted"
  | Error err -> fail "second %s" (S.describe err));
  if S.file_bytes path <> before then fail "second step wrote the snapshot";
  let epoch = (ok (S.read_snapshot path)).epoch in
  (match S.with_step_executor ~path ~execution_hash:"nope" (fun _ -> Ok ()) with
  | Error S.Manifest_mismatch -> ()
  | Ok _ -> fail "wrong hash ran"
  | Error err -> fail "hash %s" (S.describe err));
  if (ok (S.read_snapshot path)).epoch <> epoch || S.file_bytes path <> before then fail "mismatch wrote the snapshot";
  (match
     S.with_step_executor ~path ~execution_hash:first.execution_hash (fun ex ->
         match S.complete_step ex ~cursor:1 ~reply:"no" ~workspace_hash:"ws" with
         | Error S.Replay_incomplete -> Ok ()
         | Ok () -> fail "short cursor completed"
         | Error err -> fail "cursor %s" (S.describe err))
   with
  | Ok (S.Resumed ()) -> ()
  | Ok (S.Stored_completion _) -> fail "incomplete looked stored"
  | Error err -> fail "run %s" (S.describe err));
  (match
     S.with_step_executor ~path ~execution_hash:first.execution_hash (fun ex ->
         ok (S.complete_step ex ~cursor:0 ~reply:"done" ~workspace_hash:"ws");
         Ok ())
   with
  | Ok (S.Resumed ()) -> ()
  | _ -> fail "complete");
  let done_bytes = S.file_bytes path in
  let done_rev = (ok (S.read_snapshot path)).revision in
  let done_epoch = (ok (S.read_snapshot path)).epoch in
  (match S.with_step_executor ~path ~execution_hash:first.execution_hash (fun _ -> Ok ()) with
  | Ok (S.Stored_completion { reply = "done"; workspace = "ws" }) -> ()
  | Ok (S.Resumed ()) -> fail "completed step ran again"
  | Ok (S.Stored_completion _) -> fail "stored reply changed"
  | Error err -> fail "stored %s" (S.describe err));
  if S.file_bytes path <> done_bytes || (ok (S.read_snapshot path)).revision <> done_rev || (ok (S.read_snapshot path)).epoch <> done_epoch
  then fail "stored resume wrote the snapshot";
  let v2 = fresh () in
  ok (S.with_executor ~path:v2 ~run_id:"run" ~agent_version:"v2" (fun _ -> Ok ()));
  let v2_bytes = S.file_bytes v2 in
  (match admit v2 "let run () = Done \"ok\"\n" "adm" with
  | Error S.Version_unavailable -> ()
  | Ok _ -> fail "v2 was upgraded"
  | Error err -> fail "v2 %s" (S.describe err));
  if S.file_bytes v2 <> v2_bytes then fail "v2 bytes changed";
  let missing = fresh () in
  let manifest = ok (admit missing "let run () = Done \"ok\"\n" "adm") in
  let blob_dir = Filename.concat (Filename.dirname missing) "step-blobs" in
  Sys.remove (Filename.concat blob_dir manifest.source_hash);
  let kept = S.file_bytes missing in
  let kept_epoch = (ok (S.read_snapshot missing)).epoch in
  (match S.with_step_executor ~path:missing ~execution_hash:manifest.execution_hash (fun _ -> Ok ()) with
  | Error S.Artifact_missing -> ()
  | Ok _ -> fail "missing artifact ran"
  | Error err -> fail "missing %s" (S.describe err));
  if S.file_bytes missing <> kept || (ok (S.read_snapshot missing)).epoch <> kept_epoch then fail "missing artifact wrote the snapshot";
  print_endline "step store ok"
