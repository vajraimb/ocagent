(** Fiber actors. A child fiber does not see the parent's handlers, so a
    successful AskLLM / CallTool from a child is the proof the stack was
    reinstalled. Supervision restarts siblings without a clock. *)

open Core.Types
open Core.Effects

let fail fmt = Printf.ksprintf failwith fmt

let check name cond =
  if not cond then fail "FAIL %s" name

let contains hay needle =
  let n = String.length hay and m = String.length needle in
  let rec loop i = i + m <= n && (String.sub hay i m = needle || loop (i + 1)) in
  m = 0 || loop 0

let run env ?responses ?approvals body =
  Dsh_ocaml.Runtime.run_actors ~env ?responses ?approvals ~agent_entry:body ()

let test_reinstall env =
  let responses =
    [
      ToolCallResponse [ { id = "1"; name = "shell"; args_json = "echo child" } ];
      TextResponse "child-done";
    ]
  in
  let report, mock =
    run env ~responses (fun () ->
        let id =
          Effect.perform
            (Spawn
               {
                 name = "worker";
                 max_restarts = 0;
                 body =
                   (fun () ->
                     let who = Effect.perform Self in
                     let text =
                       Core.Agent.react ~model:"deepseek-v4"
                         ~messages:[ { role = User; content = "work " ^ who } ]
                         ()
                     in
                     Effect.perform (Send { to_ = "root"; body = text }));
               })
        in
        check "spawn id" (id = "worker");
        let msg = Effect.perform Receive in
        msg.body)
  in
  check "child reply" (report.value = "child-done");
  check "child shell" (List.mem "echo child" mock.commands);
  check "spawn event" (List.exists (function ActorSpawn "worker" -> true | _ -> false) report.events);
  check "no crash" (report.crashes = []);
  let again, _ = run env ~responses (fun () ->
      ignore
        (Effect.perform
           (Spawn
              {
                name = "worker";
                max_restarts = 0;
                body =
                  (fun () ->
                    let text =
                      Core.Agent.react ~model:"deepseek-v4"
                        ~messages:[ { role = User; content = "work worker" } ]
                        ()
                    in
                    Effect.perform (Send { to_ = "root"; body = text }));
              }));
      (Effect.perform Receive).body)
  in
  check "stable trace" (Harness.Trajectory.events_json report.events = Harness.Trajectory.events_json again.events)

let test_one_for_one env =
  let runs = ref 0 in
  let report, mock =
    run env (fun () ->
        ignore
          (Effect.perform
             (Spawn
                {
                  name = "worker";
                  max_restarts = 1;
                  body =
                    (fun () ->
                      incr runs;
                      if !runs = 1 then failwith "boom";
                      let msg = Effect.perform Receive in
                      Effect.perform (Send { to_ = "root"; body = "pong:" ^ msg.body }));
                }));
        Effect.perform (Send { to_ = "worker"; body = "ping" });
        (Effect.perform Receive).body)
  in
  check "pong" (report.value = "pong:ping");
  check "retried" (!runs = 2);
  check "one crash" (List.length report.crashes = 1 && fst (List.hd report.crashes) = "worker");
  check "crash text" (contains (snd (List.hd report.crashes)) "boom");
  check "restarted" (List.exists (function ActorRestart "worker" -> true | _ -> false) report.events);
  check "no shell" (mock.commands = [])

let test_one_for_all env =
  let a_runs = ref 0 in
  let b_runs = ref 0 in
  let got = ref "" in
  let report, _ =
    run env (fun () ->
        Effect.perform
          (Supervise
             {
               strategy = One_for_all;
               max_restarts = 1;
               children =
                 [
                   {
                     name = "b";
                     body =
                       (fun () ->
                         incr b_runs;
                         let msg = Effect.perform Receive in
                         got := msg.body);
                   };
                   {
                     name = "a";
                     body =
                       (fun () ->
                         incr a_runs;
                         if !a_runs = 1 then (
                           while !b_runs = 0 do
                             Eio.Fiber.yield ()
                           done;
                           failwith "a-boom");
                         Effect.perform (Send { to_ = "b"; body = "go" }));
                   };
                 ];
             });
        !got)
  in
  check "a restarted" (!a_runs = 2);
  check "b restarted" (!b_runs = 2);
  check "delivered" (!got = "go" && report.value = "go");
  check "a crashed" (List.exists (fun (name, err) -> name = "a" && contains err "a-boom") report.crashes)

let test_rest_for_one env =
  let c1 = ref 0 in
  let c2 = ref 0 in
  let c3 = ref 0 in
  let report, _ =
    run env (fun () ->
        Effect.perform
          (Supervise
             {
               strategy = Rest_for_one;
               max_restarts = 1;
               children =
                 [
                   {
                     name = "c1";
                     body =
                       (fun () ->
                         incr c1;
                         ignore (Effect.perform Receive));
                   };
                   {
                     name = "c2";
                     body =
                       (fun () ->
                         incr c2;
                         if !c2 = 1 then (
                           while !c3 = 0 do
                             Eio.Fiber.yield ()
                           done;
                           failwith "c2-boom");
                         Effect.perform (Send { to_ = "c1"; body = "stay" });
                         Effect.perform (Send { to_ = "c3"; body = "again" }));
                   };
                   {
                     name = "c3";
                     body =
                       (fun () ->
                         incr c3;
                         ignore (Effect.perform Receive));
                   };
                 ];
             });
        Printf.sprintf "%d/%d/%d" !c1 !c2 !c3)
  in
  check "counts" (report.value = "1/2/2");
  check "c1 stayed" (!c1 = 1);
  check "c2 retried" (!c2 = 2);
  check "c3 restarted" (!c3 = 2);
  check "only c2 crashed" (List.exists (fun (name, _) -> name = "c2") report.crashes && not (List.exists (fun (name, _) -> name = "c1" || name = "c3") report.crashes))

let test_restart_limit env =
  let runs = ref 0 in
  match
    run env (fun () ->
        Effect.perform
          (Supervise
             {
               strategy = One_for_one;
               max_restarts = 0;
               children =
                 [
                   {
                     name = "bad";
                     body =
                       (fun () ->
                         incr runs;
                         failwith "nope");
                   };
                 ];
             });
        "nope")
  with
  | _ -> fail "restart limit should discontinue"
  | exception Harness.Actor.Restart_limit msg ->
      check "names the actor" (contains msg "bad");
      check "ran once" (!runs = 1)
  | exception exn -> fail "unexpected %s" (Printexc.to_string exn)

let test_duplicate env =
  match
    run env (fun () ->
        ignore
          (Effect.perform (Spawn { name = "root"; max_restarts = 0; body = (fun () -> ()) }));
        "nope")
  with
  | _ -> fail "duplicate root should fail"
  | exception Harness.Actor.Actor_error msg -> check "duplicate" (contains msg "root")
  | exception exn -> fail "unexpected %s" (Printexc.to_string exn)

let test_nested env =
  let sup = ref 0 in
  let leaf = ref 0 in
  let report, _ =
    run env (fun () ->
        Effect.perform
          (Supervise
             {
               strategy = One_for_one;
               max_restarts = 0;
               children =
                 [
                   {
                     name = "sup";
                     body =
                       (fun () ->
                         incr sup;
                         Effect.perform
                           (Supervise
                              {
                                strategy = One_for_one;
                                max_restarts = 1;
                                children =
                                  [
                                    {
                                      name = "leaf";
                                      body =
                                        (fun () ->
                                          incr leaf;
                                          if !leaf = 1 then failwith "leaf-boom");
                                    };
                                  ];
                              }));
                   };
                 ];
             });
        Printf.sprintf "%d/%d" !sup !leaf)
  in
  check "tree" (report.value = "1/2");
  check "inner crash only" (List.exists (fun (name, err) -> name = "leaf" && contains err "leaf-boom") report.crashes);
  check "supervisor stayed" (!sup = 1)

let () =
  Eio_main.run @@ fun env ->
  test_reinstall env;
  test_one_for_one env;
  test_one_for_all env;
  test_rest_for_one env;
  test_restart_limit env;
  test_duplicate env;
  test_nested env;
  print_endline "actors ok"
