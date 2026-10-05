(** Faults around a recorded approval and a journal file.
    Unknown does not re-execute. A second resume is rejected. A changed
    approval payload is nondeterminism. A late result cannot overwrite Done.
    A cut JSONL tail is refused. *)

module H = Ocagent_harness.Harness
module J = Ocagent_harness.Journal
module P = Ocagent_harness.Proto
module W = Ocagent_harness.World
module Json = Ocagent_harness.Json

let fail fmt = Printf.ksprintf failwith fmt

let agent payload () =
  let _ =
    Effect.perform
      (P.Llm { purpose = "plan"; messages = [ { role = "user"; content = payload } ] })
  in
  let decision =
    Effect.perform
      (P.Ask_human { action = "fetch"; risk = `High; payload = Json.String payload })
  in
  match decision with
  | P.Rejected _ -> "no"
  | P.Approved ->
      let page = Effect.perform (P.Fetch { url = "https://example.test/spec" }) in
      string_of_int page.status

let suspend payload =
  let held = H.run ~profile:H.Prod ~run_id:"fault" (agent payload) in
  if held.result.status <> H.Suspended then fail "应先挂起";
  held

let approve_pending (session : _ H.session) =
  let exited = session.exit_process () in
  let seq = match exited.result.suspend_seq with Some n -> n | None -> fail "无序号" in
  let entry = List.nth !(exited.result.journal.entries) seq in
  entry.status <- J.Done;
  entry.result <- P.decision_json P.Approved;
  exited

let () =
  let held = suspend "v1" in
  let first = held.resume_fast P.Approved in
  let second = held.resume_fast P.Approved in
  (match second.result.status with
  | H.Failed H.Continuation_already_resumed -> ()
  | H.Failed e -> fail "重复审批：%s" (H.describe e)
  | _ -> fail "重复审批回调没有被拒绝");
  (match first.result.status with
  | H.Done _ -> ()
  | H.Failed e -> fail "第一次审批：%s" (H.describe e)
  | _ -> fail "第一次审批没有完成");

  let exited = approve_pending (suspend "v1") in
  let changed =
    H.run ~profile:H.Prod ~run_id:"fault" ~journal:exited.result.journal (agent "v2")
  in
  (match changed.result.status with
  | H.Failed (H.Nondeterminism _) -> ()
  | H.Failed e -> fail "改参数：%s" (H.describe e)
  | H.Done _ -> fail "改过的审批参数仍被执行"
  | _ -> fail "改参数没有失败");
  if changed.result.world.sandbox_execs <> 0 then fail "参数被改后仍执行了 Fetch";

  let journal = J.copy exited.result.journal in
  (match !(journal.entries) with
  | entry :: _ -> entry.status <- J.Unknown
  | [] -> fail "空日志");
  let unknown = H.run ~profile:H.Prod ~run_id:"fault" ~journal (agent "v1") in
  (match unknown.result.status with
  | H.Failed (H.Harness msg) when P.contains msg "结果未知" -> ()
  | H.Failed e -> fail "未知结果：%s" (H.describe e)
  | _ -> fail "未知结果被重做了");
  if unknown.result.world.sandbox_execs <> 0 then fail "结果未知时仍执行了 Fetch";

  let late_entry =
    match !(exited.result.journal.entries) with
    | entry :: _ -> entry
    | [] -> fail "空日志"
  in
  let original = late_entry.result in
  (match J.accept_late late_entry (Json.String "late") with
  | Error _ -> ()
  | Ok () -> fail "迟到结果覆盖了已完成的记录");
  if late_entry.result <> original then fail "冲突的迟到结果写进了日志";
  (match J.accept_late late_entry original with
  | Ok () -> ()
  | Error msg -> fail "相同的迟到结果应视为重复：%s" msg);

  let text = J.to_jsonl exited.result.journal in
  let cut = String.sub text 0 (String.length text - 8) in
  (match J.of_jsonl cut with
  | _ -> fail "截断的 JSONL 被接受了"
  | exception Json.Parse msg when P.contains msg "truncated" -> ());
  print_endline "faults ok"
