(** Step admission on an OCAGENT 3 snapshot. No worker is started. *)

module S = Ocagent_harness.Store
module M = Step_manifest
module Json = Ocagent_harness.Json
module J = Ocagent_harness.Journal

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

let workspace = M.sha256 "ws"

let contains s sub =
  let n = String.length s and m = String.length sub in
  let rec at i = i + m <= n && (String.sub s i m = sub || at (i + 1)) in
  m = 0 || at 0

let () =
  let path = fresh () in
  let first = ok (admit path "let run () = Done \"ok\"\n" "adm") in
  if first.M.step_id <> "0" || first.step_seq <> 0 then fail "step id";
  let bytes = S.file_bytes path in
  let rev = (ok (S.read_snapshot path)).revision in
  let again = ok (admit path "let run () = Done \"ok\"\n" "adm") in
  if again.execution_hash <> first.execution_hash || again.step_id <> first.step_id then fail "retry changed identity";
  if S.file_bytes path <> bytes || (ok (S.read_snapshot path)).revision <> rev then fail "retry wrote the snapshot";
  (match S.admit_step ~path ~run_id:"run" ~agent_version:"other" ~admission_key:"adm" (bundle "let run () = Done \"ok\"\n") with
  | Error S.Version_mismatch -> ()
  | Ok _ -> fail "不同 agent_version 被当成同一次接纳"
  | Error err -> fail "agent_version %s" (S.describe err));
  if S.file_bytes path <> bytes then fail "agent_version 冲突改了快照";
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
         match S.complete_step ex ~cursor:1 ~reply:(M.Done "no") ~workspace_hash:workspace with
         | Error S.Replay_incomplete -> Ok ()
         | Ok () -> fail "short cursor completed"
         | Error err -> fail "cursor %s" (S.describe err))
   with
  | Ok (S.Resumed ()) -> ()
  | Ok (S.Stored_completion _) -> fail "incomplete looked stored"
  | Error err -> fail "run %s" (S.describe err));
  (match
     S.with_step_executor ~path ~execution_hash:first.execution_hash (fun ex ->
         ok (S.complete_step ex ~cursor:0 ~reply:(M.Done "done") ~workspace_hash:workspace);
         Ok ())
   with
  | Ok (S.Resumed ()) -> ()
  | _ -> fail "complete");
  let done_bytes = S.file_bytes path in
  let done_rev = (ok (S.read_snapshot path)).revision in
  let done_epoch = (ok (S.read_snapshot path)).epoch in
  (match S.with_step_executor ~path ~execution_hash:first.execution_hash (fun _ -> Ok ()) with
  | Ok (S.Stored_completion { reply = M.Done "done"; workspace }) when workspace = M.sha256 "ws" -> ()
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
  let pending = fresh () in
  let pending_manifest = ok (admit pending "let run () = Done \"ok\"\n" "adm") in
  let issued = ref None in
  (match
     S.with_step_executor ~path:pending ~execution_hash:pending_manifest.execution_hash (fun ex ->
         let request =
           {
             S.seq = 0;
             kind = "Fetch";
             label = "Fetch";
             req_hash = "params";
             req = Json.String "http://127.0.0.1/spec";
             recovery = "Manual_only";
             approval = false;
           }
         in
         match S.prepare_operation ex request with
         | Ok (S.Execute token) -> (
             issued := Some token;
             match S.complete_step ex ~cursor:1 ~reply:(M.Done "early") ~workspace_hash:workspace with
             | Error S.Replay_incomplete -> Ok ()
             | Ok () -> fail "pending fetch completed"
             | Error err -> fail "pending %s" (S.describe err))
         | Ok _ -> fail "fetch was not executable"
         | Error err -> fail "prepare %s" (S.describe err))
   with
  | Ok (S.Resumed ()) -> ()
  | _ -> fail "pending run");
  let open_bytes = S.file_bytes pending in
  (match (ok (S.read_snapshot pending)).step with
  | Some record when record.state = M.Completed -> fail "pending fetch became completed"
  | Some _ -> ()
  | None -> fail "pending lost the step");
  let token = match !issued with Some token -> token | None -> fail "no issued" in
  let exported = S.export_issued token in
  if not (contains exported pending_manifest.execution_hash) then fail "issued is not bound to the step";
  let other = fresh () in
  let other_manifest =
    ok (S.admit_step ~path:other ~run_id:"other-run" ~agent_version:"step-v3" ~admission_key:"adm" (bundle "let run () = Done \"ok\"\n"))
  in
  let other_bytes = S.file_bytes other in
  (match S.commit_result other token (Json.String "spec-body") with
  | Error S.Manifest_mismatch -> ()
  | Ok () -> fail "issued committed on another step"
  | Error err -> fail "cross commit %s" (S.describe err));
  if S.file_bytes other <> other_bytes then fail "cross commit wrote the other snapshot";
  ignore other_manifest;
  ok (S.commit_result pending token (Json.String "spec-body"));
  (match
     S.with_step_executor ~path:pending ~execution_hash:pending_manifest.execution_hash (fun ex ->
         ok (S.complete_step ex ~cursor:1 ~reply:(M.Done "done") ~workspace_hash:workspace);
         let request =
           {
             S.seq = 1;
             kind = "Fetch";
             label = "Fetch";
             req_hash = "again";
             req = Json.String "http://127.0.0.1/spec";
             recovery = "Manual_only";
             approval = false;
           }
         in
         match S.prepare_operation ex request with
         | Error (S.Protocol "completed") -> Ok ()
         | Ok _ -> fail "completed step accepted another operation"
         | Error err -> fail "after complete %s" (S.describe err))
   with
  | Ok (S.Resumed ()) -> ()
  | Ok (S.Stored_completion _) -> fail "just completed looked already stored"
  | Error err -> fail "finish %s" (S.describe err));
  let closed = S.file_bytes pending in
  (match S.commit_result pending token (Json.String "spec-body") with
  | Error (S.Protocol "completed") -> ()
  | Ok () -> fail "completed ledger accepted another commit"
  | Error err -> fail "late commit %s" (S.describe err));
  if S.file_bytes pending <> closed then fail "late commit wrote the snapshot";
  if S.file_bytes pending = open_bytes then fail "completion did not record the result";
  let gated = fresh () in
  let _ = ok (admit gated "let run () = Done \"ok\"\n" "adm") in
  let gated_bytes = S.file_bytes gated in
  let gated_epoch = (ok (S.read_snapshot gated)).epoch in
  let foreign = J.create ~run_id:"run" ~agent_version:"step-v3" in
  (match S.compare_and_save ~path:gated ~expected_revision:1 ~epoch:9 foreign with
  | Error S.Manifest_mismatch -> ()
  | Ok () -> fail "旧入口改写了未完成的 Step"
  | Error err -> fail "旧入口 %s" (S.describe err));
  (match
     S.commit_decision ~path:gated ~run_id:"run" ~agent_version:"step-v3" ~seq:0 ~callback_id:"c"
       ~expected_request_hash:"h"
       ~decision_json:(Json.Assoc [ ("tag", Json.String "Approved") ])
   with
  | Error S.Manifest_mismatch -> ()
  | Ok () -> fail "旧审批改写了 Step"
  | Error err -> fail "旧审批 %s" (S.describe err));
  if S.file_bytes gated <> gated_bytes || (ok (S.read_snapshot gated)).epoch <> gated_epoch then
    fail "旧入口改了未完成的快照";
  let planted = fresh () in
  let source = "let run () = Done \"ok\"\n" in
  let dir = Filename.concat (Filename.dirname planted) "step-blobs" in
  Unix.mkdir dir 0o700;
  let oc = open_out (Filename.concat dir (M.sha256 source)) in
  output_string oc "not-the-source";
  close_out oc;
  (match admit planted source "adm" with
  | Error S.Artifact_corrupt -> ()
  | Ok _ -> fail "坏 blob 被接纳了"
  | Error err -> fail "坏 blob %s" (S.describe err));
  if Sys.file_exists planted then fail "坏 blob 仍然写了快照";
  print_endline "step store ok"
