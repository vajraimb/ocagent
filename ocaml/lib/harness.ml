(** Handler stack. Inner handlers see an effect first and re-perform it to
    pass it outward. The journal is outside the agent and inside the world:
    a recorded answer is returned without touching the world again.

    Ask_human does not store [k] in the journal. The fast path keeps the
    one-shot continuation in memory. The durable path discontinues it, writes
    the decision into the pending row, and reruns the agent. *)

module Deep = Effect.Deep

type profile =
  | Dev
  | Eval
  | Prod

type crash_window =
  | After_pending
  | Before_done
  | After_done

type error =
  | Unhandled of string
  | Harness of string
  | Budget of { used : int; max : int }
  | Nondeterminism of { seq : int; expected : string; actual : string; label : string }
  | Version_mismatch of { expected : string; actual : string }
  | Crash of { seq : int; window : string }
  | Continuation_already_resumed
  | No_continuation

type continuation_state =
  | Held
  | Discontinued
  | Gone

type trace_event = {
  handler : string;
  effect_name : string;
  phase : string;
  detail : string;
}

type 'a status =
  | Done of 'a
  | Suspended
  | Failed of error
  | Crashed of { seq : int; window : string }

type 'a run_result = {
  status : 'a status;
  journal : Journal.t;
  world : World.t;
  trace : trace_event list;
  protect_released : bool;
  continuation : continuation_state;
  stack : string list;
  suspend_seq : int option;
  approval : Proto.approval option;
  llm_used : int;
}

type 'a session = {
  result : 'a run_result;
  exit_process : unit -> 'a session;
  resume_fast : Proto.decision -> 'a session;
}

exception Suspend_abort
exception Crash_abort of { seq : int; window : string }
exception Exit_process

let anchors : Obj.t list ref = ref []
let anchor value = anchors := Obj.repr value :: !anchors

let window_name = function
  | After_pending -> "after-pending"
  | Before_done -> "before-done"
  | After_done -> "after-done"

type flags = {
  verify : bool;
  policy : bool;
  compact_on : bool;
  sandbox : bool;
  budget_max : int;
  compact_threshold : int;
  trace_name : string;
}

let profile_flags = function
  | Eval ->
      {
        verify = true;
        policy = false;
        compact_on = false;
        sandbox = false;
        budget_max = 10;
        compact_threshold = 99;
        trace_name = "eval_logger";
      }
  | Prod ->
      {
        verify = true;
        policy = true;
        compact_on = true;
        sandbox = true;
        budget_max = 20;
        compact_threshold = 4;
        trace_name = "otel";
      }
  | Dev ->
      {
        verify = true;
        policy = true;
        compact_on = true;
        sandbox = false;
        budget_max = 30;
        compact_threshold = 8;
        trace_name = "trace";
      }

let stack_names profile =
  let flags = profile_flags profile in
  let names = [ flags.trace_name ] in
  let names = if flags.verify then names @ [ "verify" ] else names in
  let names = names @ [ "budget" ] in
  let names = if flags.policy then names @ [ "policy" ] else names in
  let names = if flags.compact_on then names @ [ "compact" ] else names in
  names @ [ "journal"; "world"; "strict" ]

type ctx = {
  journal : Journal.t;
  world : World.t;
  trace : trace_event list ref;
  llm_mode : World.llm_mode;
  budget_max : int;
  llm_used : int ref;
  compact_threshold : int;
  sandbox : bool;
  verify_on : bool;
  policy_on : bool;
  compact_on : bool;
  verify_counts : (string, int) Hashtbl.t;
  replay_stamp : int ref;
  cursor : int ref;
  current_key : string ref;
  crash : (int * crash_window) option;
  fiber_abort : (exn -> unit) option ref;
  approval : Proto.approval option ref;
  suspend_seq : int option ref;
  trace_name : string;
  stack : string list;
}

let log ctx handler effect_name phase detail =
  ctx.trace := { handler; effect_name; phase; detail } :: !(ctx.trace)

let hit_crash ctx seq window =
  match ctx.crash with
  | Some (at, w) when at = seq && w = window -> true
  | _ -> false

let pin_fiber ctx =
  match !(ctx.fiber_abort) with
  | None -> ()
  | Some abort -> anchor abort

let high_risk = function
  | "shell" | "delete_file" | "network" -> true
  | _ -> false

let write_tool = function
  | "apply_patch" | "write_file" -> true
  | _ -> false

let verify_cap = 3

let with_trace ctx f =
  Deep.try_with f ()
    {
      effc =
        (fun (type a) (e : a Effect.t) ->
          match e with
          | Proto.Llm _ | Proto.Tool _ | Proto.Ask_human _ | Proto.Checkpoint _ | Proto.Compact _
          | Proto.Now | Proto.Fresh_id ->
              Some
                (fun (k : (a, _) Deep.continuation) ->
                  let label = Proto.name e in
                  log ctx ctx.trace_name label "see"
                    (if ctx.trace_name = "otel" then "span open" else "log");
                  ctx.fiber_abort := Some (fun exn -> ignore (Deep.discontinue k exn));
                  let stamp = !(ctx.replay_stamp) in
                  let value = Effect.perform e in
                  ctx.fiber_abort := None;
                  let replayed = !(ctx.replay_stamp) <> stamp in
                  log ctx ctx.trace_name label "return"
                    (if replayed then "replayed=true" else "replayed=false");
                  Deep.continue k value)
          | _ -> None);
    }

let with_verify ctx f =
  if not ctx.verify_on then f ()
  else
    Deep.try_with f ()
      {
        effc =
          (fun (type a) (e : a Effect.t) ->
            match e with
            | Proto.Tool call when write_tool call.name ->
                Some
                  (fun (k : (a, _) Deep.continuation) ->
                    let wrote = Effect.perform (Proto.Tool call) in
                    let seen =
                      match Hashtbl.find_opt ctx.verify_counts call.call_id with
                      | Some n -> n
                      | None -> 0
                    in
                    if seen >= verify_cap then
                      Deep.continue k
                        {
                          wrote with
                          Proto.ok = false;
                          diagnostics =
                            wrote.diagnostics @ [ "verify: 同一 call_id 已达 3 次上限" ];
                        }
                    else begin
                      Hashtbl.replace ctx.verify_counts call.call_id (seen + 1);
                      let path =
                        let raw = Json.assoc_string "path" call.args in
                        if raw = "" then World.math_path else raw
                      in
                      let lint =
                        Effect.perform
                          (Proto.Tool
                             {
                               call_id = call.call_id ^ ":lint";
                               name = "lint";
                               args =
                                 Json.Assoc
                                   [
                                     ("path", Json.String path);
                                     ("source", Json.String call.call_id);
                                   ];
                             })
                      in
                      log ctx "verify" (Proto.name e)
                        (if lint.ok then "return" else "reject")
                        (if lint.ok then "lint clean" else String.concat " " lint.diagnostics);
                      Deep.continue k
                        {
                          Proto.ok = lint.ok;
                          output = wrote.output;
                          diagnostics = wrote.diagnostics @ lint.diagnostics;
                        }
                    end)
            | _ -> None);
      }

let with_budget ctx f =
  Deep.try_with f ()
    {
      effc =
        (fun (type a) (e : a Effect.t) ->
          match e with
          | Proto.Llm req ->
              Some
                (fun (k : (a, _) Deep.continuation) ->
                  incr ctx.llm_used;
                  if !(ctx.llm_used) > ctx.budget_max then begin
                    log ctx "budget" (Proto.name e) "reject"
                      (Printf.sprintf "%d/%d" !(ctx.llm_used) ctx.budget_max);
                    Deep.discontinue k
                      (Proto.Budget_exceeded { used = !(ctx.llm_used); max = ctx.budget_max })
                  end
                  else Deep.continue k (Effect.perform (Proto.Llm req)))
          | _ -> None);
    }

let with_policy ctx f =
  if not ctx.policy_on then f ()
  else
    Deep.try_with f ()
      {
        effc =
          (fun (type a) (e : a Effect.t) ->
            match e with
            | Proto.Tool call when high_risk call.name ->
                Some
                  (fun (k : (a, _) Deep.continuation) ->
                    let decision =
                      Effect.perform
                        (Proto.Ask_human
                           { action = call.name; risk = `High; payload = call.args })
                    in
                    match decision with
                    | Proto.Approved -> Deep.continue k (Effect.perform (Proto.Tool call))
                    | Proto.Rejected reason ->
                        Deep.continue k
                          {
                            Proto.ok = false;
                            output = reason;
                            diagnostics = [ "policy: 已拒绝，handler 不改写工具参数" ];
                          })
            | _ -> None);
      }

let with_compact ctx f =
  if not ctx.compact_on then f ()
  else
    Deep.try_with f ()
      {
        effc =
          (fun (type a) (e : a Effect.t) ->
            match e with
            | Proto.Compact msgs ->
                Some
                  (fun (k : (a, _) Deep.continuation) ->
                    let summary =
                      Effect.perform (Proto.Llm { purpose = "compact"; messages = msgs })
                    in
                    Deep.continue k
                      [
                        { Proto.role = "system"; content = "compacted" };
                        { Proto.role = "user"; content = summary.text };
                      ])
            | Proto.Llm req
              when req.purpose <> "compact" && List.length req.messages > ctx.compact_threshold ->
                Some
                  (fun (k : (a, _) Deep.continuation) ->
                    let summary =
                      Effect.perform (Proto.Llm { purpose = "compact"; messages = req.messages })
                    in
                    let rewritten =
                      Proto.Llm
                        {
                          purpose = req.purpose;
                          messages =
                            [
                              { Proto.role = "system"; content = "compacted" };
                              { Proto.role = "user"; content = summary.text };
                            ];
                        }
                    in
                    Deep.continue k (Effect.perform rewritten))
            | _ -> None);
      }

let with_world ctx f =
  Deep.try_with f ()
    {
      effc =
        (fun (type a) (e : a Effect.t) ->
          match e with
          | Proto.Llm _ | Proto.Tool _ | Proto.Now | Proto.Fresh_id | Proto.Checkpoint _ ->
              Some
                (fun (k : (a, _) Deep.continuation) ->
                  let key = !(ctx.current_key) in
                  let name =
                    match e with
                    | Proto.Tool call -> call.name
                    | _ -> Proto.kind e
                  in
                  match World.Map.find_opt key ctx.world.cache with
                  | Some json ->
                      ctx.world.log <- ctx.world.log @ [ { key; name; duplicate = true } ];
                      Deep.continue k (Proto.decode_result e json)
                  | None ->
                      let value =
                        World.interpret e ctx.world ~sandbox:ctx.sandbox ~llm_mode:ctx.llm_mode
                      in
                      let json = Proto.encode_result e value in
                      ctx.world.cache <- World.Map.add key json ctx.world.cache;
                      ctx.world.log <- ctx.world.log @ [ { key; name; duplicate = false } ];
                      Deep.continue k value)
          | _ -> None);
    }

let with_strict f =
  try f () with
  | Effect.Unhandled e -> raise (Proto.Harness_error ("未处理的 effect：" ^ Proto.name e))

let make_entry ctx seq (type a) (e : a Effect.t) =
  let hash = Proto.req_hash e in
  {
    Journal.run_id = ctx.journal.run_id;
    seq;
    kind = Proto.kind e;
    label = Proto.name e;
    req_hash = hash;
    req = Proto.request_json e;
    status = Journal.Pending;
    result = Json.Null;
    idempotency_key = Printf.sprintf "%s:%d:%s" ctx.journal.run_id seq hash;
    ts = ctx.world.clock + seq;
    last_hit = Journal.Execute;
  }

type 'a prepare =
  | Replay of 'a
  | Fresh of Journal.entry
  | Still_pending of Journal.entry

let prepare (type a) ctx (e : a Effect.t) : a prepare =
  let seq = !(ctx.cursor) in
  ctx.cursor := seq + 1;
  let hash = Proto.req_hash e in
  let label = Proto.name e in
  match Journal.nth ctx.journal seq with
  | Some existing ->
      if existing.req_hash <> hash then
        raise
          (Proto.Nondeterminism { seq; expected = existing.req_hash; actual = hash; label });
      if existing.status = Journal.Done then begin
        incr ctx.replay_stamp;
        existing.last_hit <- Journal.Replay;
        log ctx "journal" label "replay" (Printf.sprintf "seq %d" seq);
        Replay (Proto.decode_result e existing.result)
      end
      else Still_pending existing
  | None ->
      let len = List.length !(ctx.journal.entries) in
      if seq <> len then
        raise (Proto.Harness_error (Printf.sprintf "日志序号断裂：期望 %d，实际 %d" len seq));
      let entry = make_entry ctx seq e in
      ctx.journal.entries := !(ctx.journal.entries) @ [ entry ];
      Fresh entry

let crash_now ctx seq window k =
  pin_fiber ctx;
  anchor k;
  raise (Crash_abort { seq; window = window_name window })

let finish_pending (type a r) ctx (e : a Effect.t) (entry : Journal.entry)
    (k : (a, r) Deep.continuation) : r =
  ctx.current_key := entry.idempotency_key;
  if hit_crash ctx entry.seq Before_done then begin
    let (_value : a) = Effect.perform e in
    crash_now ctx entry.seq Before_done k
  end
  else begin
    entry.last_hit <- Journal.Execute;
    let value = Effect.perform e in
    entry.status <- Journal.Done;
    entry.result <- Proto.encode_result e value;
    log ctx "journal" entry.label "execute" (Printf.sprintf "seq %d" entry.seq);
    if hit_crash ctx entry.seq After_done then crash_now ctx entry.seq After_done k
    else Deep.continue k value
  end

let with_journal (type r) ctx
    (resume_box : (Proto.decision -> r) option ref)
    (f : unit -> r) : r =
  let suspend approval seq (entry : Journal.entry) k =
    entry.last_hit <- Journal.Suspend;
    ctx.approval := Some approval;
    ctx.suspend_seq := Some seq;
    log ctx "journal" ("Ask_human · " ^ approval.action) "suspend"
      (Printf.sprintf "seq %d pending" seq);
    pin_fiber ctx;
    anchor k;
    resume_box :=
      Some
        (fun decision ->
          entry.status <- Journal.Done;
          entry.result <- Proto.decision_json decision;
          entry.last_hit <- Journal.Execute;
          with_strict (fun () -> with_world ctx (fun () -> Deep.continue k decision)));
    anchor !resume_box;
    raise Suspend_abort
  in
  Deep.try_with f ()
    {
      effc =
        (fun (type a) (e : a Effect.t) ->
          match e with
          | Proto.Ask_human approval ->
              Some
                (fun (k : (a, r) Deep.continuation) ->
                  match prepare ctx (Proto.Ask_human approval) with
                  | Replay decision -> Deep.continue k decision
                  | Fresh entry ->
                      if hit_crash ctx entry.seq After_pending then
                        crash_now ctx entry.seq After_pending k
                      else suspend approval entry.seq entry k
                  | Still_pending entry -> suspend approval entry.seq entry k)
          | Proto.Llm _ | Proto.Tool _ | Proto.Checkpoint _ | Proto.Compact _ | Proto.Now
          | Proto.Fresh_id ->
              Some
                (fun (k : (a, r) Deep.continuation) ->
                  match prepare ctx e with
                  | Replay value -> Deep.continue k value
                  | Fresh entry ->
                      if hit_crash ctx entry.seq After_pending then
                        crash_now ctx entry.seq After_pending k
                      else finish_pending ctx e entry k
                  | Still_pending entry -> finish_pending ctx e entry k)
          | _ -> None);
    }

let inner ctx f =
  with_trace ctx (fun () ->
      with_verify ctx (fun () ->
          with_budget ctx (fun () -> with_policy ctx (fun () -> with_compact ctx f))))

type 'a drive =
  | Value of 'a
  | Suspend
  | Crash of int * string
  | Err of error
  | Exited

let drive f =
  match f () with
  | value -> Value value
  | exception Suspend_abort -> Suspend
  | exception Crash_abort info -> Crash (info.seq, info.window)
  | exception Proto.Budget_exceeded { used; max } -> Err (Budget { used; max })
  | exception Proto.Nondeterminism { seq; expected; actual; label } ->
      Err (Nondeterminism { seq; expected; actual; label })
  | exception Proto.Harness_error msg -> Err (Harness msg)
  | exception Proto.Version_mismatch { expected; actual } ->
      Err (Version_mismatch { expected; actual })
  | exception Effect.Unhandled e -> Err (Unhandled (Proto.name e))
  | exception Effect.Continuation_already_resumed -> Err Continuation_already_resumed
  | exception Exit_process -> Exited

let stack_names_of (flags : flags) =
  let names = [ flags.trace_name ] in
  let names = if flags.verify then names @ [ "verify" ] else names in
  let names = names @ [ "budget" ] in
  let names = if flags.policy then names @ [ "policy" ] else names in
  let names = if flags.compact_on then names @ [ "compact" ] else names in
  names @ [ "journal"; "world"; "strict" ]

let describe = function
  | Unhandled name -> "没有 handler 接住 " ^ name
  | Harness msg -> msg
  | Budget { used; max } -> Printf.sprintf "预算用尽 %d/%d" used max
  | Nondeterminism { seq; label; _ } ->
      Printf.sprintf "seq %d 请求变了（%s），拒绝静默错位" seq label
  | Version_mismatch { expected; actual } ->
      Printf.sprintf "日志属于 %s，当前是 %s" expected actual
  | Crash { seq; window } -> Printf.sprintf "kill -9 于 seq %d · %s" seq window
  | Continuation_already_resumed -> "这条 continuation 只能恢复一次"
  | No_continuation -> "没有可恢复的 continuation"

let run ?(profile = Eval) ?(llm_mode = World.Correct_first) ?(run_id = "local") ?budget_max
    ?compact_threshold ?verify ?policy ?compact ?sandbox ?journal ?world ?crash ?agent_version
    ?(probe = ref false) f =
  let flags = profile_flags profile in
  let flags =
    {
      flags with
      budget_max = Option.value budget_max ~default:flags.budget_max;
      compact_threshold = Option.value compact_threshold ~default:flags.compact_threshold;
      verify = Option.value verify ~default:flags.verify;
      policy = Option.value policy ~default:flags.policy;
      compact_on = Option.value compact ~default:flags.compact_on;
      sandbox = Option.value sandbox ~default:flags.sandbox;
    }
  in
  let version = Option.value agent_version ~default:Agent.version in
  let journal =
    match journal with
    | Some j -> j
    | None -> Journal.create ~run_id ~agent_version:version
  in
  if journal.agent_version <> version && !(journal.entries) <> [] then
    raise (Proto.Version_mismatch { expected = journal.agent_version; actual = version });
  journal.agent_version <- version;
  let world = match world with Some w -> w | None -> World.create () in
  let ctx =
    {
      journal;
      world;
      trace = ref [];
      llm_mode;
      budget_max = flags.budget_max;
      llm_used = ref 0;
      compact_threshold = flags.compact_threshold;
      sandbox = flags.sandbox;
      verify_on = flags.verify;
      policy_on = flags.policy;
      compact_on = flags.compact_on;
      verify_counts = Hashtbl.create 8;
      replay_stamp = ref 0;
      cursor = ref 0;
      current_key = ref "";
      crash;
      fiber_abort = ref None;
      approval = ref None;
      suspend_seq = ref None;
      trace_name = flags.trace_name;
      stack = stack_names profile;
    }
  in
  (* Overrides can change the stack relative to the profile default. *)
  let stack = stack_names_of flags in
  let ctx = { ctx with stack } in
  let resume_box = ref None in
  let consumed = ref false in
  let rec session_of outcome =
    let trace = List.rev !(ctx.trace) in
    let released = !probe in
    let idle extra_status extra_cont extra_released =
      let result =
        {
          status = extra_status;
          journal;
          world;
          trace;
          protect_released = extra_released;
          continuation = extra_cont;
          stack;
          suspend_seq = !(ctx.suspend_seq);
          approval = !(ctx.approval);
          llm_used = !(ctx.llm_used);
        }
      in
      let again () = session_of outcome in
      {
        result;
        exit_process = again;
        resume_fast =
          (fun _ ->
            session_of
              (Err
                 (if !consumed then Continuation_already_resumed else No_continuation)));
      }
    in
    match outcome with
    | Value value -> idle (Done value) Gone released
    | Err error -> idle (Failed error) Gone released
    | Crash (seq, window) -> idle (Crashed { seq; window }) Gone false
    | Exited -> idle Suspended Discontinued true
    | Suspend ->
        let result =
          {
            status = Suspended;
            journal;
            world;
            trace;
            protect_released = false;
            continuation = Held;
            stack;
            suspend_seq = !(ctx.suspend_seq);
            approval = !(ctx.approval);
            llm_used = !(ctx.llm_used);
          }
        in
        let resume_fast decision =
          if !consumed then session_of (Err Continuation_already_resumed)
          else (
            consumed := true;
            match !resume_box with
            | None -> session_of (Err No_continuation)
            | Some resume -> session_of (drive (fun () -> resume decision)))
        in
        let exit_process () =
          if !consumed then session_of (Err Continuation_already_resumed)
          else (
            consumed := true;
            let abort = !(ctx.fiber_abort) in
            ctx.fiber_abort := None;
            (match abort with
            | None -> ()
            | Some abort -> (
                try ignore (abort Exit_process) with
                | Exit_process -> ()
                | _ -> ()));
            session_of Exited)
        in
        { result; exit_process; resume_fast }
  in
  let outcome =
    drive (fun () ->
        with_strict (fun () ->
            with_world ctx (fun () ->
                with_journal ctx resume_box (fun () -> inner ctx (fun () -> f ())))))
  in
  session_of outcome

let strict_only f =
  match with_strict f with
  | value -> Ok value
  | exception Proto.Harness_error msg -> Error msg
  | exception Effect.Unhandled e -> Error ("escaped:" ^ Proto.name e)

type _ Effect.t += Fork : (unit -> unit) -> unit Effect.t

let scheduler f =
  let queue = Queue.create () in
  let handler (type a) (e : a Effect.t) =
    match e with
    | Fork child ->
        Some
          (fun (k : (a, _) Deep.continuation) ->
            Queue.push child queue;
            Deep.continue k ())
    | _ -> None
  in
  let rec drain () =
    match Queue.take_opt queue with
    | None -> ()
    | Some child ->
        Deep.try_with child () { effc = handler };
        drain ()
  in
  Deep.try_with f () { effc = handler };
  drain ()

let spawn profile thunk = Effect.perform (Fork (fun () -> profile thunk))
