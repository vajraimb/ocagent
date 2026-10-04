(** Acceptance tests for spec v0.1, milestones M0–M4. *)

module Json = Ocagent_harness.Json
module H = Ocagent_harness.Harness
module A = Ocagent_harness.Agent
module J = Ocagent_harness.Journal
module W = Ocagent_harness.World
module P = Ocagent_harness.Proto

let failed = ref 0

let check id pass detail =
  if pass then Printf.printf "PASS  %s  %s\n" id detail
  else (
    incr failed;
    Printf.printf "FAIL  %s  %s\n" id detail)

let prompt_fix = "把 src/math.ml 里的 add 改成加法"
let prompt_publish = "把 src/math.ml 里的 add 改成加法，然后发布"

let run_fix ?(profile = H.Eval) ?crash ?journal ?world ?llm_mode ?(run_id = "eval-fix") () =
  let probe = ref false in
  let session =
    H.run ~profile ~run_id ~probe ?crash ?journal ?world ?llm_mode (fun () ->
        A.swe ~probe prompt_fix)
  in
  (session, !probe)

let read_agent () =
  let paths =
    [ "agent.ml"; "../lib/agent.ml"; "lib/agent.ml"; "../../lib/agent.ml" ]
  in
  let rec loop = function
    | [] -> failwith "找不到 agent.ml"
    | path :: rest -> (
        match In_channel.with_open_text path In_channel.input_all with
        | source -> source
        | exception Sys_error _ -> loop rest)
  in
  loop paths

let test_marshal () =
  let observed =
    Effect.Deep.try_with
      (fun () -> Effect.perform P.Now)
      ()
      {
        effc =
          (fun (type a) (e : a Effect.t) ->
            match e with
            | P.Now ->
                Some
                  (fun (k : (a, _) Effect.Deep.continuation) ->
                    let plain =
                      match Marshal.to_string k [] with
                      | (_ : string) -> false
                      | exception Invalid_argument _ -> true
                    in
                    let closures =
                      match Marshal.to_string k [ Marshal.Closures ] with
                      | (_ : string) -> false
                      | exception (Invalid_argument _ | Failure _) -> true
                    in
                    Effect.Deep.continue k (if plain && closures then 1. else 0.))
            | _ -> None);
      }
  in
  check "m0-marshal" (observed = 1.)
    (if observed = 1. then "Marshal 存不了 continuation，Closures 也不行。恢复靠日志，不靠 k。"
     else Printf.sprintf "observed=%g" observed)

let test_strict () =
  match H.strict_only (fun () -> ignore (Effect.perform P.Now)) with
  | Error msg when P.contains msg "Now" ->
      check "m0-strict" true "最外层 strict 把 Unhandled 收成 Harness_error。"
  | Error msg -> check "m0-strict" false msg
  | Ok () -> check "m0-strict" false "Now 不该被静默吃掉"

let test_fiber () =
  let raw =
    match
      H.scheduler (fun () ->
          let _ =
            Effect.Deep.try_with
              (fun () ->
                Effect.perform
                  (H.Fork (fun () -> ignore (Effect.perform P.Now : float))))
              ()
              {
                effc =
                  (fun (type a) (e : a Effect.t) ->
                    match e with
                    | P.Now ->
                        Some
                          (fun (k : (a, _) Effect.Deep.continuation) ->
                            Effect.Deep.continue k 0.)
                    | _ -> None);
              }
          in
          ())
    with
    | () -> "inherited"
    | exception Effect.Unhandled _ -> "Harness_error:Now"
  in
  let installed = ref "missing" in
  let profile thunk =
    ignore
      (Effect.Deep.try_with thunk ()
         {
           effc =
             (fun (type a) (e : a Effect.t) ->
               match e with
               | P.Now ->
                   Some
                     (fun (k : (a, _) Effect.Deep.continuation) ->
                       Effect.Deep.continue k 1.)
               | _ -> None);
         })
  in
  H.scheduler (fun () ->
      H.spawn profile (fun () ->
          let n = Effect.perform P.Now in
          installed := if n = 1. then "installed" else "wrong"));
  let pass = raw = "Harness_error:Now" && !installed = "installed" in
  check "m0-fiber" pass
    (if pass then "裸 fork 得到 Unhandled；Harness.spawn 在子 fiber 里重装 handler 后得到 installed。"
     else Printf.sprintf "裸 fork=%s，spawn=%s" raw !installed)

let test_oneshot () =
  let probe = ref false in
  let session =
    H.run ~profile:H.Dev ~run_id:"m0-oneshot" ~probe (fun () -> A.swe ~probe prompt_publish)
  in
  match session.result.status with
  | H.Suspended ->
      let first = session.resume_fast P.Approved in
      let second = session.resume_fast P.Approved in
      let pass =
        (match first.result.status with H.Done r -> r.published = A.Yes | _ -> false)
        &&
        match second.result.status with
        | H.Failed H.Continuation_already_resumed -> true
        | _ -> false
      in
      check "m0-oneshot" pass
        (if pass then "快路径第一次 continue 成功，第二次 Continuation_already_resumed。"
         else H.describe (match second.result.status with H.Failed e -> e | H.Crashed { seq; window } -> H.Crash { seq; window } | _ -> H.Harness "status"))
  | other ->
      check "m0-oneshot" false
        (match other with
        | H.Failed e -> H.describe e
        | H.Crashed { seq; window } -> H.describe (H.Crash { seq; window })
        | H.Done _ -> "没有挂起"
        | H.Suspended -> "unreachable")

let test_r1 () =
  let source = read_agent () in
  let forbidden = [ "Unix.time"; "Unix.gettimeofday"; "Random."; "open Unix"; "In_channel"; "Out_channel" ] in
  let hits = List.filter (fun needle -> P.contains source needle) forbidden in
  check "m0-r1" (hits = [])
    (if hits = [] then "agent.ml 不直接调用 Unix / Random / 文件 IO。"
     else "发现 " ^ String.concat ", " hits)

let test_coverage () =
  let cover with_compact () =
    let _id = Effect.perform P.Fresh_id in
    let _now = Effect.perform P.Now in
    Effect.perform (P.Checkpoint "cover");
    let _plan =
      Effect.perform
        (P.Llm { purpose = "plan"; messages = [ { P.role = "user"; content = "cover" } ] })
    in
    let _read =
      Effect.perform
        (P.Tool
           {
             call_id = "cover-read";
             name = "read_file";
             args = Json.Assoc [ ("path", Json.String W.math_path) ];
           })
    in
    if with_compact then
      ignore (Effect.perform (P.Compact [ { P.role = "user"; content = "cover" } ]));
    ()
  in
  let one name profile with_compact =
    let session = H.run ~profile ~run_id:("cover-" ^ name) (cover with_compact) in
    match session.result.status with
    | H.Done () -> true
    | H.Failed e ->
        Printf.printf "  coverage %s: %s\n" name (H.describe e);
        false
    | H.Suspended ->
        Printf.printf "  coverage %s suspended\n" name;
        false
    | H.Crashed _ -> false
  in
  let ask name profile =
    let session =
      H.run ~profile ~run_id:("ask-" ^ name) (fun () ->
          ignore
            (Effect.perform
               (P.Ask_human { action = "shell"; risk = `High; payload = Json.Null })))
    in
    match session.result.status with
    | H.Suspended -> true
    | H.Failed (H.Unhandled _) -> false
    | H.Failed e ->
        Printf.printf "  ask %s: %s\n" name (H.describe e);
        false
    | _ -> false
  in
  let pass =
    one "dev" H.Dev true && one "eval" H.Eval false && one "prod" H.Prod true && ask "dev" H.Dev
    && ask "eval" H.Eval && ask "prod" H.Prod
  in
  check "m0-coverage" pass
    (if pass then "三个 profile 都盖住自己栈上的 effect；Ask_human 挂起，而不是 Unhandled。Eval 不含 compact。"
     else "某个 profile 漏了 handler")

let same_result (a : A.result) (b : A.result) =
  a.ok = b.ok && a.attempts = b.attempts && a.stamp = b.stamp && a.now = b.now
  && a.published = b.published && a.diagnostics = b.diagnostics

let test_determinism () =
  let logs = Hashtbl.create 4 in
  let traces = Hashtbl.create 4 in
  let broken = ref None in
  for i = 1 to 100 do
    let session, _ = run_fix ~run_id:"eval-fix" () in
    match session.result.status with
    | H.Done value when value.ok ->
        Hashtbl.replace logs (J.slim session.result.journal) ();
        let trace =
          String.concat "\n"
            (List.map
               (fun ev ->
                 String.concat "|" [ ev.H.handler; ev.effect_name; ev.phase; ev.detail ])
               session.result.trace)
        in
        Hashtbl.replace traces trace ()
    | other ->
        if !broken = None then
          broken :=
            Some
              (Printf.sprintf "第 %d 次 %s" i
                 (match other with
                 | H.Failed e -> H.describe e
                 | H.Crashed { seq; window } -> H.describe (H.Crash { seq; window })
                 | H.Suspended -> "suspended"
                 | H.Done r -> Printf.sprintf "ok=%b attempts=%d" r.ok r.attempts))
  done;
  match !broken with
  | Some msg -> check "m1-bytes" false msg
  | None ->
      let pass = Hashtbl.length logs = 1 && Hashtbl.length traces = 1 in
      check "m1-bytes" pass
        (if pass then "同一 fixture 跑 100 次，账本和 eval_logger 都只有一个字节形态。"
         else Printf.sprintf "账本形态 %d，日志形态 %d" (Hashtbl.length logs) (Hashtbl.length traces))

let test_crash () =
  let clean, _ = run_fix ~run_id:"m2-crash" () in
  match clean.result.status with
  | H.Done clean_value -> (
      let windows = [ H.After_pending; H.Before_done; H.After_done ] in
      let checks = ref 0 in
      let problem = ref None in
      List.iter
        (fun entry ->
          List.iter
            (fun window ->
              if !problem = None then (
                let crashed, _ =
                  run_fix ~run_id:"m2-crash" ~crash:(entry.J.seq, window) ()
                in
                match crashed.result.status with
                | H.Crashed _ when crashed.result.protect_released ->
                    problem := Some "kill -9 不应运行 Fun.protect"
                | H.Crashed _ -> (
                    incr checks;
                    let recovered, _ =
                      run_fix ~run_id:"m2-crash" ~journal:crashed.result.journal
                        ~world:crashed.result.world ()
                    in
                    match recovered.result.status with
                    | H.Done value
                      when J.slim recovered.result.journal = J.slim clean.result.journal
                           && same_result value clean_value
                           && W.file recovered.result.world W.math_path
                              = W.file clean.result.world W.math_path
                           && W.mutation_count recovered.result.world
                              = W.mutation_count clean.result.world ->
                        ()
                    | H.Done _ ->
                        problem :=
                          Some
                            (Printf.sprintf "seq %d %s 恢复后账本、文件或副作用不一致"
                               entry.seq (H.window_name window))
                    | H.Failed e ->
                        problem :=
                          Some
                            (Printf.sprintf "seq %d %s 恢复失败：%s" entry.seq
                               (H.window_name window) (H.describe e))
                    | _ ->
                        problem :=
                          Some
                            (Printf.sprintf "seq %d %s 恢复没有完成" entry.seq
                               (H.window_name window)))
                | H.Failed e ->
                    problem :=
                      Some
                        (Printf.sprintf "seq %d %s 没有崩溃：%s" entry.seq
                           (H.window_name window) (H.describe e))
                | _ ->
                    problem :=
                      Some
                        (Printf.sprintf "seq %d %s 没有崩溃" entry.seq (H.window_name window))))
            windows)
        !(clean.result.journal.entries);
      match !problem with
      | Some msg -> check "m2-crash" false msg
      | None ->
          check "m2-crash" true
            (Printf.sprintf "%d 个 seq × 3 个窗口，共 %d 次。账本一致，apply_patch 不重复写入。"
               (List.length !(clean.result.journal.entries))
               !checks))
  | H.Failed e -> check "m2-crash" false (H.describe e)
  | _ -> check "m2-crash" false "干净运行没有完成"

let test_jsonl () =
  let session, _ = run_fix ~run_id:"jsonl" () in
  match session.result.status with
  | H.Done _ ->
      let text = J.to_jsonl session.result.journal in
      let back = J.of_jsonl text in
      let pass = J.slim back = J.slim session.result.journal && not (P.contains text "continuation") in
      check "m2-jsonl" pass
        (if pass then "JSONL 往返一致，日志里没有 continuation。" else "JSONL 往返不一致")
  | H.Failed e -> check "m2-jsonl" false (H.describe e)
  | _ -> check "m2-jsonl" false "没有完成"

let test_version () =
  let session, _ = run_fix ~run_id:"ver" () in
  let journal = J.copy session.result.journal in
  let pass =
    match
      H.run ~run_id:"ver" ~agent_version:"swe-agent@9" ~journal (fun () ->
          A.swe ~probe:(ref false) prompt_fix)
    with
    | _ -> false
    | exception P.Version_mismatch _ -> true
  in
  check "m2-version" pass
    (if pass then "agent_version 不一致时拒绝重放。" else "版本不符没有被拒绝")

let test_human () =
  let probe = ref false in
  let held =
    H.run ~profile:H.Prod ~run_id:"m3-human" ~probe (fun () -> A.swe ~probe prompt_publish)
  in
  match held.result.status with
  | H.Suspended when (not held.result.protect_released) && held.result.continuation = H.Held -> (
      let fast = held.resume_fast P.Approved in
      let durable_probe = ref false in
      let durable =
        H.run ~profile:H.Prod ~run_id:"m3-durable" ~probe:durable_probe (fun () ->
            A.swe ~probe:durable_probe prompt_publish)
      in
      let exited = durable.exit_process () in
      let seq = match durable.result.suspend_seq with Some n -> n | None -> -1 in
      let entry = List.nth !(exited.result.journal.entries) seq in
      entry.status <- J.Done;
      entry.result <- P.decision_json P.Approved;
      let replay_probe = ref false in
      let replayed =
        H.run ~profile:H.Prod ~run_id:"m3-durable" ~probe:replay_probe
          ~journal:exited.result.journal ~world:exited.result.world (fun () ->
            A.swe ~probe:replay_probe prompt_publish)
      in
      let drifted =
        H.run ~profile:H.Prod ~run_id:"m3-human" ~journal:(J.copy fast.result.journal)
          ~world:(W.copy fast.result.world) (fun () ->
            A.swe ~probe:(ref false) "改去做一件别的事，然后发布")
      in
      let drift_ok =
        match drifted.result.status with
        | H.Failed (H.Nondeterminism _) -> true
        | _ -> false
      in
      let pass =
        (match fast.result.status with H.Done r -> r.published = A.Yes | _ -> false)
        && exited.result.protect_released
        && exited.result.continuation = H.Discontinued
        && (match replayed.result.status with H.Done r -> r.published = A.Yes | _ -> false)
        && drift_ok
      in
      let detail =
        if pass then "进程内 continue 一次；优雅退出会 discontinue 并释放资源；隔日重放得到批准；改 prompt 触发 Nondeterminism。"
        else
          Printf.sprintf "fast=%s exit_released=%b cont=%s replay=%s drift=%s"
            (match fast.result.status with
            | H.Done r -> if r.published = A.Yes then "yes" else "other"
            | H.Failed e -> H.describe e
            | H.Suspended -> "suspended"
            | H.Crashed { seq; window } -> H.describe (H.Crash { seq; window }))
            exited.result.protect_released
            (match exited.result.continuation with
            | H.Held -> "held"
            | H.Discontinued -> "discontinued"
            | H.Gone -> "gone")
            (match replayed.result.status with
            | H.Done r -> if r.published = A.Yes then "yes" else "other"
            | H.Failed e -> H.describe e
            | _ -> "no")
            (match drifted.result.status with
            | H.Failed e -> H.describe e
            | H.Done _ -> "done"
            | H.Suspended -> "suspended"
            | H.Crashed { seq; window } -> H.describe (H.Crash { seq; window }))
      in
      check "m3-human" pass detail)
  | H.Failed e -> check "m3-human" false (H.describe e)
  | _ -> check "m3-human" false "没有挂起，或挂起时已经释放了资源"

let test_reject () =
  let probe = ref false in
  let session =
    H.run ~profile:H.Prod ~run_id:"m3-reject" ~probe (fun () -> A.swe ~probe prompt_publish)
  in
  let resumed = session.resume_fast (P.Rejected "先别发") in
  match resumed.result.status with
  | H.Done r when r.published = A.Rejected && W.mutation_count resumed.result.world = 1 ->
      check "m3-policy" true "拒绝后不执行 shell，handler 不改写命令，诊断原样返回。"
  | H.Done r ->
      check "m3-policy" false
        (Printf.sprintf "published=%s mutations=%d diags=%s"
           (match r.published with A.Rejected -> "rejected" | A.Yes -> "yes" | A.Skipped -> "skipped")
           (W.mutation_count resumed.result.world)
           (String.concat "; " r.diagnostics))
  | H.Failed e -> check "m3-policy" false (H.describe e)
  | _ -> check "m3-policy" false "拒绝路径没有完成"

let test_verify () =
  let probe = ref false in
  let session =
    H.run ~profile:H.Eval ~llm_mode:W.Wrong_then_right ~run_id:"m4-verify" ~probe (fun () ->
        A.swe ~probe prompt_fix)
  in
  match session.result.status with
  | H.Done r ->
      let journal = J.slim session.result.journal in
      let pass =
        r.ok && r.attempts = 2
        && W.file session.result.world W.math_path = W.fixed_add
        && P.contains journal "仍不是加法"
      in
      check "m4-verify" pass
        (if pass then "第一次 lint 失败只附加诊断，agent 自己重试。handler 没有改写补丁。"
         else Printf.sprintf "ok=%b attempts=%d" r.ok r.attempts)
  | H.Failed e -> check "m4-verify" false (H.describe e)
  | _ -> check "m4-verify" false "没有完成"

let test_budget () =
  let session =
    H.run ~profile:H.Eval ~budget_max:2 ~run_id:"m4-budget" (fun () ->
        for _ = 1 to 5 do
          ignore
            (Effect.perform
               (P.Llm { purpose = "plan"; messages = [ { role = "user"; content = "x" } ] }))
        done)
  in
  match session.result.status with
  | H.Failed (H.Budget { used; max }) when used = 3 && max = 2 ->
      check "m4-budget" true "第 3 次 Llm 被 budget discontinue，没有静默截断。"
  | H.Failed e -> check "m4-budget" false (H.describe e)
  | _ -> check "m4-budget" false "预算没有生效"

let test_compact () =
  let session =
    H.run ~profile:H.Prod ~compact_threshold:2 ~run_id:"m4-compact" (fun () ->
        ignore
          (Effect.perform
             (P.Llm
                {
                  purpose = "plan";
                  messages =
                    [
                      { role = "user"; content = "一" };
                      { role = "user"; content = "二" };
                      { role = "user"; content = "三" };
                    ];
                })))
  in
  match session.result.status with
  | H.Done () ->
      let text = J.to_jsonl session.result.journal in
      let pass = P.contains text "compact" in
      check "m4-compact" pass
        (if pass then "超长上下文先 perform 一次 compact Llm，摘要进日志，不改 agent。"
         else "日志里没有 compact")
  | H.Failed e -> check "m4-compact" false (H.describe e)
  | _ -> check "m4-compact" false "没有完成"

let () =
  Printexc.record_backtrace true;
  test_marshal ();
  test_strict ();
  test_fiber ();
  test_oneshot ();
  test_r1 ();
  test_coverage ();
  test_determinism ();
  test_crash ();
  test_jsonl ();
  test_version ();
  test_human ();
  test_reject ();
  test_verify ();
  test_budget ();
  test_compact ();
  if !failed = 0 then Printf.printf "\n全部通过。\n"
  else (
    Printf.printf "\n%d 项失败。\n" !failed;
    exit 1)
