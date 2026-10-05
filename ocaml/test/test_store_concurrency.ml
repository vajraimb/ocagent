(** Store critical sections, one executor, and approval identity.
    Barriers are pipes or atomics, not sleeps. *)

module S = Ocagent_harness.Store
module J = Ocagent_harness.Journal
module D = Ocagent_harness.Durable
module P = Ocagent_harness.Proto
module Json = Ocagent_harness.Json

let fail fmt = Printf.ksprintf failwith fmt

let run_id = "run"
let version = "v1"

let fresh_path name =
  let dir =
    Filename.concat (Filename.get_temp_dir_name ())
      (Printf.sprintf "ocagent-%s-%d-%d" name (Unix.getpid ()) (Random.bits ()))
  in
  Unix.mkdir dir 0o755;
  (dir, Filename.concat dir "snapshot.json")

let ok = function
  | Ok v -> v
  | Error err -> fail "意外错误 %s" (S.describe err)

let snapshot path =
  match S.read_snapshot path with
  | Ok snap -> snap
  | Error err -> fail "读快照 %s" (S.describe err)

let req ~seq ~kind ~hash ~approval =
  {
    S.seq;
    kind;
    label = kind;
    req_hash = hash;
    req = Json.String hash;
    recovery = (if approval then "AwaitingApproval" else "Manual_only");
    approval;
  }

let llm_req seq = req ~seq ~kind:"Llm" ~hash:("llm-" ^ string_of_int seq) ~approval:false
let ask_req seq = req ~seq ~kind:"Ask_human" ~hash:("ask-" ^ string_of_int seq) ~approval:true

let approved = Json.Assoc [ ("tag", Json.String "Approved") ]

let decision path seq callback decision_json =
  let snap = snapshot path in
  let entry = List.nth !(snap.journal.J.entries) seq in
  S.commit_decision ~path ~run_id ~agent_version:version ~seq ~callback_id:callback
    ~expected_request_hash:entry.J.req_hash ~decision_json

let wait_pid pid =
  let deadline = Unix.gettimeofday () +. 3. in
  let rec loop () =
    match Unix.waitpid [ Unix.WNOHANG ] pid with
    | 0, _ when Unix.gettimeofday () > deadline ->
        Unix.kill pid Sys.sigkill;
        ignore (Unix.waitpid [] pid);
        fail "子进程超时"
    | 0, _ ->
        Unix.sleepf 0.01;
        loop ()
    | _, Unix.WEXITED 0 -> ()
    | _, _ -> fail "子进程状态不对"
  in
  loop ()

let hold path =
  match
    S.with_executor ~path ~run_id ~agent_version:version (fun _ ->
        print_endline "ready";
        flush stdout;
        ignore (input_char stdin);
        Ok ())
  with
  | Ok () -> exit 0
  | Error err -> fail "hold %s" (S.describe err)

let test_revision path =
  ignore (ok (S.with_executor ~path ~run_id ~agent_version:version (fun ex -> Ok (S.epoch ex))));
  let first = snapshot path in
  let stale = first.S.journal in
  let epoch = ok (S.with_executor ~path ~run_id ~agent_version:version (fun ex -> Ok (S.epoch ex))) in
  if epoch <> 2 then fail "第二次领取 epoch=%d" epoch;
  let current = snapshot path in
  let bytes = S.file_bytes path in
  (match S.compare_and_save ~path ~expected_revision:first.revision ~epoch:first.epoch stale with
  | Error S.Revision_conflict -> ()
  | Ok () -> fail "旧 revision 覆盖了新快照"
  | Error err -> fail "覆盖 %s" (S.describe err));
  let after = snapshot path in
  if after.revision <> current.revision || after.epoch <> current.epoch || S.file_bytes path <> bytes then
    fail "冲突写入改动了快照"

let test_double_prepare path =
  let calls = ref 0 in
  ok
    (S.with_executor ~path ~run_id ~agent_version:version (fun ex ->
         match S.prepare_operation ex (llm_req 0) with
         | Ok (S.Execute _) -> (
             incr calls;
             match S.prepare_operation ex (llm_req 0) with
             | Ok S.In_flight -> Ok ()
             | Ok (S.Execute _) -> fail "第二次又签发了"
             | Ok _ -> fail "第二次准备结果不对"
             | Error err -> fail "第二次 %s" (S.describe err))
         | _ -> fail "第一次没有 Execute"));
  if !calls <> 1 then fail "provider 调用 %d" !calls

let test_same_process path =
  let ready = Atomic.make false in
  let release = Atomic.make false in
  let domain =
    Domain.spawn (fun () ->
        S.with_executor ~path ~run_id ~agent_version:version (fun _ ->
            Atomic.set ready true;
            let deadline = Unix.gettimeofday () +. 3. in
            while (not (Atomic.get release)) && Unix.gettimeofday () < deadline do
              Domain.cpu_relax ()
            done;
            if not (Atomic.get release) then fail "同进程等待超时";
            Ok ()))
  in
  let deadline = Unix.gettimeofday () +. 3. in
  while (not (Atomic.get ready)) && Unix.gettimeofday () < deadline do
    Domain.cpu_relax ()
  done;
  if not (Atomic.get ready) then fail "同进程执行者没有起来";
  let bytes = S.file_bytes path in
  let revision = (snapshot path).revision in
  (match S.with_executor ~path ~run_id ~agent_version:version (fun _ -> Ok ()) with
  | Error S.Already_running -> ()
  | Ok _ -> fail "同进程第二个执行者进来了"
  | Error err -> fail "同进程 %s" (S.describe err));
  ignore (snapshot path);
  if S.file_bytes path <> bytes || (snapshot path).revision <> revision then fail "只读 status 改了快照";
  Atomic.set release true;
  (match Domain.join domain with
  | Ok () -> ()
  | Error err -> fail "持有者 %s" (S.describe err))

let test_other_process path =
  let pin, pout = Unix.pipe () in
  let cin, cout = Unix.pipe () in
  let pid =
    Unix.create_process Sys.argv.(0) [| Sys.argv.(0); "hold"; path |] cin pout Unix.stderr
  in
  Unix.close cin;
  Unix.close pout;
  let buf = Bytes.create 6 in
  let rec read_ready off =
    if off < 6 then
      let n = Unix.read pin buf off (6 - off) in
      if n = 0 then fail "持有进程提前退出" else read_ready (off + n)
  in
  read_ready 0;
  if Bytes.to_string buf <> "ready\n" then fail "同步字不对";
  (match S.with_executor ~path ~run_id ~agent_version:version (fun _ -> Ok ()) with
  | Error S.Already_running -> ()
  | Ok _ -> fail "另一个进程拿到了执行者"
  | Error err -> fail "跨进程 %s" (S.describe err));
  let pending = snapshot path in
  ignore (Unix.write cout (Bytes.of_string "x") 0 1);
  wait_pid pid;
  Unix.close pin;
  Unix.close cout;
  if (snapshot path).revision <> pending.revision then fail "拒绝 resume 时改了 revision"

let test_stale path =
  let ticket =
    ok
      (S.with_executor ~path ~run_id ~agent_version:version (fun ex ->
           match S.prepare_operation ex (llm_req 0) with
           | Ok (S.Execute issued) -> Ok (S.export_issued issued)
           | _ -> fail "没有签发"))
  in
  ignore (ok (S.with_executor ~path ~run_id ~agent_version:version (fun ex -> Ok (S.epoch ex))));
  let bytes = S.file_bytes path in
  let issued = ok (S.import_issued ticket) in
  (match S.commit_result path issued (Json.String "late") with
  | Error S.Stale_attempt -> ()
  | Ok () -> fail "迟到结果写进去了"
  | Error err -> fail "迟到 %s" (S.describe err));
  if S.file_bytes path <> bytes then fail "迟到提交改了快照"

let test_identity path =
  let bytes = S.file_bytes path in
  let revision = (snapshot path).revision in
  (match S.with_executor ~path ~run_id:"other" ~agent_version:version (fun _ -> Ok ()) with
  | Error S.Run_mismatch -> ()
  | Ok _ -> fail "run 不同仍执行"
  | Error err -> fail "run %s" (S.describe err));
  (match S.with_executor ~path ~run_id ~agent_version:"other" (fun _ -> Ok ()) with
  | Error S.Version_mismatch -> ()
  | Ok _ -> fail "version 不同仍执行"
  | Error err -> fail "version %s" (S.describe err));
  if S.file_bytes path <> bytes || (snapshot path).revision <> revision then fail "身份不符仍写盘"

let test_tail dir =
  let fetch _ = fail "tail 不应调用 Fetch" in
  let long () =
    ignore (Effect.perform (P.Llm { purpose = "one"; messages = [] }));
    ignore (Effect.perform (P.Llm { purpose = "two"; messages = [] }));
    "long"
  in
  let short () =
    ignore (Effect.perform (P.Llm { purpose = "one"; messages = [] }));
    "short"
  in
  (match D.run ~dir ~run_id ~agent_version:version ~fetch long with
  | D.Finished "long" -> ()
  | D.Blocked msg -> fail "长任务 %s" msg
  | _ -> fail "长任务没有完成");
  match D.run ~dir ~run_id ~agent_version:version ~fetch short with
  | D.Blocked msg when String.sub msg 0 (min 18 (String.length msg)) = "Replay_incomplete" || msg = "Replay_incomplete" ->
      ()
  | D.Finished _ -> fail "只消费前缀却完成了"
  | D.Blocked msg -> fail "尾部 %s" msg
  | D.Suspended -> fail "尾部变成挂起"

let test_approval path =
  ok
    (S.with_executor ~path ~run_id ~agent_version:version (fun ex ->
         (match S.prepare_operation ex (ask_req 0) with
         | Ok S.Awaiting_approval -> ()
         | _ -> fail "审批没有等待");
         (match S.prepare_operation ex (ask_req 1) with
         | Ok S.Awaiting_approval -> ()
         | _ -> fail "第二条审批没有等待");
         Ok ()));
  let before = snapshot path in
  let bytes = S.file_bytes path in
  (match decision path 0 "cb-a" (Json.Assoc [ ("tag", Json.String "Approved"); ("extra", Json.Int 1) ]) with
  | Error (S.Bad_decision _) -> ()
  | Ok () -> fail "多余字段被接受"
  | Error err -> fail "多余字段 %s" (S.describe err));
  (match decision path 0 "cb-a" (Json.Assoc [ ("tag", Json.String "Nope") ]) with
  | Error (S.Bad_decision _) -> ()
  | _ -> fail "未知 tag 被接受");
  if S.file_bytes path <> bytes then fail "非法审批写了盘";
  (match decision path 0 "cb-a" approved with
  | Ok () -> ()
  | Error err -> fail "批准 %s" (S.describe err));
  let once = (snapshot path).revision in
  (match decision path 0 "cb-a" approved with
  | Ok () -> ()
  | Error err -> fail "重复批准 %s" (S.describe err));
  if (snapshot path).revision <> once then fail "重复批准增加了 revision";
  (match decision path 0 "cb-b" approved with
  | Error S.Approval_conflict -> ()
  | Ok () -> fail "另一个 callback 覆盖了"
  | Error err -> fail "callback %s" (S.describe err));
  (match decision path 0 "cb-a" (Json.Assoc [ ("reason", Json.String "no"); ("tag", Json.String "Rejected") ]) with
  | Error S.Approval_conflict -> ()
  | Ok () -> fail "改了决定"
  | Error err -> fail "改决定 %s" (S.describe err));
  let issued =
    ok
      (S.import_issued (String.concat "\n" [ run_id; version; "0"; "ask-0"; string_of_int before.epoch ]))
  in
  let bytes = S.file_bytes path in
  (match S.commit_result path issued approved with
  | Error (S.Bad_decision _) -> ()
  | Ok () -> fail "结果入口批准了 Ask_human"
  | Error err -> fail "结果入口 %s" (S.describe err));
  if S.file_bytes path <> bytes then fail "结果入口写了盘";
  (match decision path 1 "cb-c" approved with
  | Ok () -> ()
  | Error err -> fail "第二条 %s" (S.describe err));
  let snap = snapshot path in
  let ask0 = List.nth !(snap.journal.entries) 0 in
  let ask1 = List.nth !(snap.journal.entries) 1 in
  if ask0.J.status <> J.Done || ask1.J.status <> J.Done then fail "两条审批没有都留下"

let test_legacy path =
  let oc = open_out path in
  output_string oc "OCAGENT 1\nrevision 1\nrecords 0\nchecksum 00000000\n";
  close_out oc;
  let bytes = S.file_bytes path in
  (match S.with_executor ~path ~run_id ~agent_version:version (fun _ -> Ok ()) with
  | Error (S.Corrupt_snapshot _) -> ()
  | Ok _ -> fail "旧快照被执行了"
  | Error err -> fail "旧快照 %s" (S.describe err));
  if S.file_bytes path <> bytes then fail "拒绝旧快照时改了文件"

let test_release dir =
  let fetch _ = failwith "不应取网络" in
  let agent () =
    let _ =
      Effect.perform (P.Ask_human { action = "look"; risk = `High; payload = Json.String "v" })
    in
    "no"
  in
  (match D.run ~dir ~run_id ~agent_version:version ~fetch agent with
  | D.Suspended -> ()
  | D.Blocked msg -> fail "挂起 %s" msg
  | D.Finished _ -> fail "审批被当成完成");
  match D.run ~dir ~run_id ~agent_version:version ~fetch agent with
  | D.Suspended -> ()
  | D.Blocked msg -> fail "第二次领取 %s" msg
  | D.Finished _ -> fail "第二次完成了"

let test_raise path =
  (match S.with_executor ~path ~run_id ~agent_version:version (fun _ -> failwith "boom") with
  | exception Failure _ -> ()
  | Ok _ -> fail "异常被吞了"
  | Error err -> fail "异常变成 %s" (S.describe err));
  match S.with_executor ~path ~run_id ~agent_version:version (fun ex -> Ok (S.epoch ex)) with
  | Ok _ -> ()
  | Error S.Already_running -> fail "异常后锁没释放"
  | Error err -> fail "异常后 %s" (S.describe err)

let approve_child path seq callback =
  match decision path (int_of_string seq) callback approved with
  | Ok () -> exit 0
  | Error err -> fail "%s" (S.describe err)

let test_parallel path =
  ok
    (S.with_executor ~path ~run_id ~agent_version:version (fun ex ->
         (match S.prepare_operation ex (ask_req 0) with
         | Ok S.Awaiting_approval -> ()
         | _ -> fail "并行审批 0");
         (match S.prepare_operation ex (ask_req 1) with
         | Ok S.Awaiting_approval -> ()
         | _ -> fail "并行审批 1");
         Ok ()));
  let before = (snapshot path).revision in
  let spawn seq callback =
    Unix.create_process Sys.argv.(0)
      [| Sys.argv.(0); "approve"; path; string_of_int seq; callback |]
      Unix.stdin Unix.stdout Unix.stderr
  in
  let a = spawn 0 "par-a" in
  let b = spawn 1 "par-b" in
  wait_pid a;
  wait_pid b;
  let snap = snapshot path in
  if snap.revision <> before + 2 then fail "并行批准 revision %d -> %d" before snap.revision;
  let ask0 = List.nth !(snap.journal.entries) 0 in
  let ask1 = List.nth !(snap.journal.entries) 1 in
  if ask0.J.callback_id <> "par-a" || ask1.J.callback_id <> "par-b" then fail "并行批准丢了更新"

let parent () =
  let dir, path = fresh_path "rev" in
  test_revision path;
  test_identity path;
  let _, path = fresh_path "prep" in
  test_double_prepare path;
  let _, path = fresh_path "dom" in
  test_same_process path;
  let _, path = fresh_path "proc" in
  test_other_process path;
  let _, path = fresh_path "stale" in
  test_stale path;
  let _, path = fresh_path "ask" in
  test_approval path;
  let _, path = fresh_path "par" in
  test_parallel path;
  let _, path = fresh_path "boom" in
  test_raise path;
  let tail_dir, _ = fresh_path "tail" in
  test_tail tail_dir;
  let rel_dir, _ = fresh_path "rel" in
  test_release rel_dir;
  let _, legacy = fresh_path "legacy" in
  test_legacy legacy;
  ignore dir;
  print_endline "store concurrency ok"

let () =
  match Array.to_list Sys.argv with
  | _ :: "hold" :: path :: _ -> hold path
  | _ :: "approve" :: path :: seq :: callback :: _ -> approve_child path seq callback
  | _ -> parent ()
