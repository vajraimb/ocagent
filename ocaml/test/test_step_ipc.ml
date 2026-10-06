(** IPC codec and session rules. No worker is started. *)

module I = Ocagent_harness.Step_ipc

let fail fmt = Printf.ksprintf failwith fmt

let limits = I.worker_limits

let round frame =
  match I.encode_frame frame with
  | Error msg -> fail "encode %s" msg
  | Ok text -> (
      match I.decode_frame text with
      | Ok got when got = frame -> ()
      | Ok _ -> fail "round trip changed %s" text
      | Error msg -> fail "decode %s" msg)

let () =
  let input = [ ("fetch_url", "http://127.0.0.1:9/spec"); ("material", "m") ] in
  round (I.Init { version = 1; execution_hash = String.make 64 'a'; bound_input = input; limits });
  round (I.Ready { version = 1 });
  round (I.Call { version = 1; request_id = 1; method_ = "Net.get"; url = "http://127.0.0.1:9/spec" });
  round (I.Return { version = 1; request_id = 1; result = I.Http { status = 200; body = "spec-body" } });
  round (I.Return { version = 1; request_id = 1; result = I.Rejected "no" });
  round (I.Trace { version = 1; message = "m" });
  round (I.Stop { version = 1; code = "approval" });
  round (I.Finished { version = 1; reply = I.Done "validated" });
  let bad = [ "{"; "{\"tag\":\"Nope\"}"; "{\"tag\":\"Ready\",\"version\":1,\"extra\":1}"; "{\"tag\":\"Ready\",\"version\":2}" ] in
  List.iter
    (fun text -> match I.decode_frame text with Ok _ -> fail "accepted %s" text | Error _ -> ())
    bad;
  (match I.decode_frame "{\"tag\":\"Call\",\"version\":1,\"request_id\":1,\"method\":\"Files\",\"args\":{\"url\":\"x\"}}" with
  | Error _ -> ()
  | Ok _ -> fail "unknown method");
  let s = ref I.session_start in
  let take frame =
    match I.on_worker !s frame with
    | Error msg -> fail "session %s" msg
    | Ok next -> s := next
  in
  take (I.Ready { version = 1 });
  take (I.Call { version = 1; request_id = 1; method_ = "Net.get"; url = "u" });
  (match I.on_worker !s (I.Finished { version = 1; reply = I.Done "x" }) with Error _ -> () | Ok _ -> fail "finished during call");
  (match I.after_return !s 1 with Ok next -> s := next | Error _ -> fail "return");
  take (I.Finished { version = 1; reply = I.Done "pure" });
  (match I.on_worker !s (I.Call { version = 1; request_id = 2; method_ = "Net.get"; url = "u" }) with
  | Error _ -> ()
  | Ok _ -> fail "call after finish");
  (match I.decode_frame "{ \"tag\":\"Ready\",\"version\":1}" with Ok _ -> fail "whitespace" | Error _ -> ());
  (match I.decode_frame "{\"version\":1,\"tag\":\"Ready\"}" with Ok _ -> fail "unsorted" | Error _ -> ());
  if I.max_frame <> 262144 then fail "frame cap";
  let watchdog seconds f =
    match Unix.fork () with
    | 0 -> (try f (); exit 0 with e -> Printf.eprintf "child: %s\n%!" (Printexc.to_string e); exit 2)
    | pid ->
        let deadline = Unix.gettimeofday () +. seconds in
        let rec wait () =
          match Unix.waitpid [ Unix.WNOHANG ] pid with
          | 0, _ when Unix.gettimeofday () >= deadline ->
              (try Unix.kill pid Sys.sigkill with Unix.Unix_error _ -> ());
              ignore (Unix.waitpid [] pid);
              fail "watchdog"
          | 0, _ ->
              Unix.sleepf 0.02;
              wait ()
          | _, Unix.WEXITED 0 -> ()
          | _, Unix.WEXITED n -> fail "child exit %d" n
          | _, Unix.WSIGNALED n -> fail "child signal %d" n
          | _, _ -> fail "child status"
        in
        wait ()
  in
  watchdog 1. (fun () ->
      let a, _b = Unix.socketpair Unix.PF_UNIX Unix.SOCK_STREAM 0 in
      let started = Unix.gettimeofday () in
      match I.read_frame a (started +. 0.1) with
      | Error "deadline" when Unix.gettimeofday () -. started < 0.6 -> ()
      | Error msg -> fail "read deadline %s" msg
      | Ok _ -> fail "read returned");
  watchdog 1. (fun () ->
      let a, _b = Unix.socketpair Unix.PF_UNIX Unix.SOCK_STREAM 0 in
      (try Unix.setsockopt_int a Unix.SO_SNDBUF 1024 with Unix.Unix_error _ -> ());
      let started = Unix.gettimeofday () in
      let message = String.make 200000 'x' in
      match I.write_frame a (I.Trace { version = 1; message }) (started +. 0.2) with
      | Error "deadline" when Unix.gettimeofday () -. started < 0.8 -> ()
      | Error msg -> fail "write deadline %s" msg
      | Ok () -> fail "write completed");
  watchdog 1. (fun () ->
      let ticks = ref 0. in
      let now () =
        ticks := !ticks +. 1.;
        !ticks
      in
      let a, _b = Unix.socketpair Unix.PF_UNIX Unix.SOCK_STREAM 0 in
      let started = Unix.gettimeofday () in
      match I.read_frame ~now a 0.5 with
      | Error "deadline" when Unix.gettimeofday () -. started < 0.3 -> ()
      | Error msg -> fail "caller clock %s" msg
      | Ok _ -> fail "caller clock returned");
  print_endline "step ipc ok"
