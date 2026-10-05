(** One process reads, asks the model, and suspends on approval.
    The next process restores from JSONL and performs Fetch once inside the
    sandbox. A third process replays that journal and must not run Llm or Fetch
    in the world again. *)

module H = Ocagent_harness.Harness
module J = Ocagent_harness.Journal
module P = Ocagent_harness.Proto
module W = Ocagent_harness.World
module Json = Ocagent_harness.Json

let fail fmt = Printf.ksprintf failwith fmt

let url = "https://example.test/spec"

let agent payload () =
  let read =
    Effect.perform
      (P.Tool
         {
           call_id = "read";
           name = "read_file";
           args = Json.Assoc [ ("path", Json.String "notes/spec.md") ];
         })
  in
  let plan =
    Effect.perform
      (P.Llm { purpose = "plan"; messages = [ { P.role = "user"; content = read.output } ] })
  in
  let decision =
    Effect.perform
      (P.Ask_human { action = "fetch"; risk = `High; payload = Json.String payload })
  in
  match decision with
  | P.Rejected reason -> "no:" ^ reason
  | P.Approved ->
      let page = Effect.perform (P.Fetch { url }) in
      if page.status = 200 then "done:" ^ plan.text else "bad"

let world () =
  let world = W.create () in
  world.files <- W.Map.add "notes/spec.md" "spec: add" world.files;
  world

let count name (w : W.t) =
  List.length (List.filter (fun (s : W.side) -> s.name = name) w.log)

let () =
  let held = H.run ~profile:H.Prod ~run_id:"chain" ~world:(world ()) (agent "v1") in
  if held.result.status <> H.Suspended then fail "审批前应该挂起";
  let exited = held.exit_process () in
  if exited.result.continuation <> H.Discontinued then fail "退出后 continuation 应该被丢掉";
  let seq = match exited.result.suspend_seq with Some n -> n | None -> fail "没有挂起序号" in
  let entry = List.nth !(exited.result.journal.entries) seq in
  entry.status <- J.Done;
  entry.result <- P.decision_json P.Approved;
  let journal = J.of_jsonl (J.to_jsonl exited.result.journal) in
  let recovered_world = world () in
  let recovered =
    H.run ~profile:H.Prod ~run_id:"chain" ~journal ~world:recovered_world (agent "v1")
  in
  (match recovered.result.status with
  | H.Done text when String.starts_with ~prefix:"done:" text -> ()
  | H.Done text -> fail "恢复结果不对：%s" text
  | H.Failed e -> fail "恢复失败：%s" (H.describe e)
  | H.Suspended -> fail "恢复后仍挂起"
  | H.Crashed { seq; window } -> fail "恢复崩溃 %d %s" seq window);
  if count "Llm" recovered_world <> 0 then fail "已记录的模型调用又进了 world";
  if count "Fetch" recovered_world <> 1 then fail "Fetch 应只在沙箱里执行一次";
  if recovered_world.sandbox_execs <> 1 then fail "沙箱执行次数 %d" recovered_world.sandbox_execs;
  let replay_world = world () in
  let replayed =
    H.run ~profile:H.Prod ~run_id:"chain" ~journal:recovered.result.journal ~world:replay_world (agent "v1")
  in
  (match replayed.result.status with
  | H.Done _ -> ()
  | H.Failed e -> fail "重放失败：%s" (H.describe e)
  | _ -> fail "重放没有完成");
  if replay_world.log <> [] then fail "重放又碰到了 world";
  if replay_world.sandbox_execs <> 0 then fail "重放又执行了沙箱";
  print_endline "chain ok"
