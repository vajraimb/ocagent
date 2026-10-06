(** Production-path counters for review 4f43b62. Each negative used to pass on the old runtime. *)

module C = Ocagent_harness.Step_compile
module R = Ocagent_harness.Step_runtime
module S = Ocagent_harness.Store
module J = Ocagent_harness.Journal
module D = Ocagent_harness.Durable_dispatch
module X = Ocagent_harness.Step_sandbox
module G = Ocagent_harness.Journal
module Json = Ocagent_harness.Json

exception Boom

let fail fmt = Printf.ksprintf failwith fmt

let fresh name =
  let dir =
    Filename.concat (Filename.get_temp_dir_name ())
      (Printf.sprintf "ocagent-def-%s-%d-%d" name (Unix.getpid ()) (Random.bits ()))
  in
  Unix.mkdir dir 0o755;
  dir

let snapshot dir = Filename.concat dir "snapshot.json"

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
            fail "watchdog %.1fs" seconds
        | 0, _ ->
            Unix.sleepf 0.05;
            wait ()
        | _, Unix.WEXITED 0 -> ()
        | _, Unix.WEXITED n -> fail "child exit %d" n
        | _, Unix.WSIGNALED n -> fail "child signal %d" n
        | _, _ -> fail "child status"
      in
      wait ()

let alive pid =
  match Unix.kill pid 0 with
  | () -> true
  | exception Unix.Unix_error (Unix.ESRCH, _, _) -> false
  | exception Unix.Unix_error _ -> true

let assert_dead dir =
  let path = Filename.concat dir "worker.pid" in
  if Sys.file_exists path then
    let pid = int_of_string (String.trim (In_channel.with_open_text path In_channel.input_all)) in
    let rec gone n =
      if not (alive pid) then ()
      else if n = 0 then fail "worker %d 仍在" pid
      else (
        Unix.sleepf 0.05;
        gone (n - 1))
    in
    gone 40

let state path =
  match S.read_snapshot path with
  | Ok { step = Some record; _ } -> record.Step_manifest.state
  | Ok _ -> fail "没有 step"
  | Error err -> fail "%s" (S.describe err)

let epoch path =
  match S.read_snapshot path with
  | Ok snap -> snap.epoch
  | Error err -> fail "%s" (S.describe err)

let run_step ?timeout_s dir hash url =
  let pidfile = Filename.concat dir "worker.pid" in
  Unix.putenv "OCAGENT_WORKER_PID" pidfile;
  Fun.protect
    ~finally:(fun () -> Unix.putenv "OCAGENT_WORKER_PID" "")
    (fun () ->
      let path = snapshot dir in
      match timeout_s with
      | None -> R.run ~path ~execution_hash:hash ~allowed_url:url
      | Some timeout_s -> R.run_within ~timeout_s ~path ~execution_hash:hash ~allowed_url:url)

let pure =
  {|open Step_api
module Step : STEP = struct
  let run () = Done "pure"
end
|}

let net =
  {|open Step_api
module Step : STEP = struct
  let run () =
    match Input.get "material", Input.get "fetch_url" with
    | Some _, Some url ->
        (match Net.get url with
        | Ok resp -> if resp.status = 200 && resp.body = "spec-body" then Done "validated" else Done "bad"
        | Error (Net.Approval_rejected _) -> Done "rejected"
        | Error (Net.Denied reason) -> Done ("denied:" ^ reason))
    | _ -> Done "missing"
end
|}

let spin =
  {|open Step_api
module Step : STEP = struct
  let rec loop () = loop ()
  let run () = loop ()
end
|}

let finally_src =
  {|open Step_api
module Step : STEP = struct
  let run () =
    let url = match Input.get "fetch_url" with Some url -> url | None -> "" in
    Fun.protect ~finally:(fun () -> Trace.note "finally") (fun () ->
        match Net.get url with
        | Ok _ -> Done "ok"
        | Error _ -> Done "err")
end
|}

let fetch_params url =
  Json.Assoc
    [
      ("body", Json.String "");
      ("headers", Json.List []);
      ("method", Json.String "GET");
      ("redirect", Json.String "error");
      ("timeout_s", Json.Int 20);
      ("url", Json.String url);
    ]

let params_hash url = Step_manifest.sha256 (Json.canonical (fetch_params url))

let compile tools dir source input =
  match C.compile_with ~setup_fault:None ~hang:false ~deadline:(Unix.gettimeofday () +. 90.) tools ~source ~modules:[] ~input with
  | Error err -> fail "compile %s" (C.describe err)
  | Ok artifact -> (
      match C.admit ~path:(snapshot dir) ~run_id:"run" ~agent_version:"step-v3" ~admission_key:"main" artifact with
      | Error err -> fail "admit %s" (C.describe err)
      | Ok manifest -> (artifact, manifest))

let host_bytecode source =
  let dir = Filename.temp_dir "ocagent-bc" "" in
  let src = Filename.concat dir "stall.ml" in
  let out = Filename.concat dir "worker" in
  let oc = open_out src in
  output_string oc source;
  close_out oc;
  let cmd = Printf.sprintf "ocamlc -I +unix unix.cma -o %s %s" (Filename.quote out) (Filename.quote src) in
  if Sys.command cmd <> 0 then fail "host ocamlc";
  In_channel.with_open_bin out In_channel.input_all

let admit_forged dir artifact ~compiler_id ~runtime_id bytecode =
  let forged = C.forge artifact ~compiler_id ~runtime_id ~bytecode in
  match C.admit ~path:(snapshot dir) ~run_id:"run" ~agent_version:"step-v3" ~admission_key:"forged" forged with
  | Error err -> fail "forge admit %s" (C.describe err)
  | Ok manifest -> manifest

let plant_unconsumed path hash =
  match
    S.with_step_executor ~path ~execution_hash:hash (fun ex ->
        match
          S.prepare_operation ex
            {
              seq = 0;
              kind = "Fetch";
              label = "Net.get";
              req_hash = "plant";
              req = Json.Assoc [ ("k", Json.String "v") ];
              recovery = "Manual_only";
              approval = false;
            }
        with
        | Ok (S.Execute issued) ->
            S.commit_result path issued (Json.Assoc [ ("body", Json.String "x"); ("status", Json.Int 200) ])
        | Ok _ -> Error (S.Protocol "plant")
        | Error _ as err -> err)
  with
  | Ok (S.Resumed ()) -> ()
  | Ok _ -> fail "plant completion"
  | Error err -> fail "plant %s" (S.describe err)

let plant_replay path hash url =
  let req kind approval recovery seq =
    {
      S.seq;
      kind;
      label = "Net.get";
      req_hash = params_hash url;
      req = fetch_params url;
      recovery;
      approval;
    }
  in
  (match
     S.with_step_executor ~path ~execution_hash:hash (fun ex ->
         match S.prepare_operation ex (req "Ask_human" true "AwaitingApproval" 0) with
         | Ok S.Awaiting_approval -> Ok ()
         | Ok _ -> Error (S.Protocol "ask")
         | Error _ as err -> err)
   with
  | Ok _ -> ()
  | Error err -> fail "plant ask %s" (S.describe err));
  let stored =
    match S.read_snapshot path with
    | Ok snap -> (
        match !(snap.journal.entries) with
        | entry :: _ -> entry.req_hash
        | [] -> fail "no ask")
    | Error err -> fail "%s" (S.describe err)
  in
  (match
     S.approve_step ~path ~execution_hash:hash ~seq:0 ~callback_id:"plant" ~expected_request_hash:stored
       ~decision_json:(Json.Assoc [ ("tag", Json.String "Approved") ])
   with
  | Ok () -> ()
  | Error err -> fail "plant approve %s" (S.describe err));
  match
    S.with_step_executor ~path ~execution_hash:hash (fun ex ->
        match S.prepare_operation ex (req "Ask_human" true "AwaitingApproval" 0) with
        | Ok (S.Replay _) -> (
            match S.prepare_operation ex (req "Fetch" false "Manual_only" 1) with
            | Ok (S.Execute issued) ->
                S.commit_result path issued (Json.Assoc [ ("body", Json.String "spec-body"); ("status", Json.Int 200) ])
            | Ok _ -> Error (S.Protocol "fetch")
            | Error _ as err -> err)
        | Ok _ -> Error (S.Protocol "replay")
        | Error _ as err -> err)
  with
  | Ok _ -> ()
  | Error err -> fail "plant fetch %s" (S.describe err)

let contains text needle =
  let n = String.length needle in
  let rec go i =
    if i + n > String.length text then false else if String.sub text i n = needle then true else go (i + 1)
  in
  go 0

let interrupted msg = contains msg "deadline" || contains msg "timeout" || contains msg "eof"

let lines path =
  if not (Sys.file_exists path) then 0
  else
    let text = In_channel.with_open_bin path In_channel.input_all in
    let n = ref 0 in
    String.iter (fun c -> if c = '\n' then incr n) text;
    !n

let serve mode log =
  let sock = Unix.socket Unix.PF_INET Unix.SOCK_STREAM 0 in
  Unix.setsockopt sock Unix.SO_REUSEADDR true;
  Unix.set_close_on_exec sock;
  Unix.bind sock (Unix.ADDR_INET (Unix.inet_addr_loopback, 0));
  Unix.listen sock 8;
  let port = match Unix.getsockname sock with Unix.ADDR_INET (_, port) -> port | _ -> fail "port" in
  match Unix.fork () with
  | 0 ->
      let note () =
        let fd = Unix.openfile log [ Unix.O_WRONLY; Unix.O_APPEND; Unix.O_CREAT ] 0o644 in
        ignore (Unix.write_substring fd "hit\n" 0 4);
        Unix.close fd
      in
      while true do
        let client, _ = Unix.accept sock in
        Unix.set_nonblock client;
        let tmp = Bytes.create 1024 in
        let n =
          let rec spin left =
            match Unix.read client tmp 0 1024 with
            | exception Unix.Unix_error ((Unix.EAGAIN | Unix.EWOULDBLOCK), _, _) when left > 0 ->
                ignore (Unix.select [ client ] [] [] 0.05);
                spin (left - 1)
            | exception Unix.Unix_error _ -> 0
            | n -> n
          in
          spin 20
        in
        let req = if n > 0 then Bytes.sub_string tmp 0 n else "" in
        if not (String.starts_with ~prefix:"GET /spec" req) then Unix.close client
        else (
          note ();
          (try Unix.clear_nonblock client with Unix.Unix_error _ -> ());
          match mode with
          | `Hang -> ()
          | `Flood ->
              let headers = "HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n" in
              ignore (try Unix.write_substring client headers 0 (String.length headers) with _ -> 0);
              let chunk = String.make 65536 'a' in
              let rec go n =
                if n > 0 then (
                  ignore (try Unix.write_substring client chunk 0 (String.length chunk) with _ -> 0);
                  go (n - 1))
              in
              go 20;
              Unix.close client)
      done
  | pid -> (pid, port)

let () =
  let tools =
    match C.hold_toolchain ~deadline:(Unix.gettimeofday () +. 60.) with
    | Ok tools -> tools
    | Error err -> fail "toolchain %s" (C.describe err)
  in
  Fun.protect
    ~finally:(fun () -> C.release tools)
    (fun () ->
      let compiler_id, runtime_id = C.identity tools in
      let pure_dir = fresh "pure" in
      let artifact, manifest = compile tools pure_dir pure [] in
      let url = "http://127.0.0.1:9/spec" in
      (match run_step pure_dir manifest.execution_hash url with
      | Ok (R.Completed { reply = Step_manifest.Done "pure"; _ }) -> ()
      | other -> fail "pure %s" (match other with Error err -> R.describe err | Ok _ -> "not pure"));
      (match run_step ~timeout_s:0 pure_dir manifest.execution_hash url with
      | Ok (R.Completed { reply = Step_manifest.Done "pure"; _ }) -> ()
      | Error err -> fail "completed looked up a toolchain: %s" (R.describe err)
      | Ok _ -> fail "completed reply");
      let tail = fresh "tail" in
      let _, tail_m = compile tools tail pure [] in
      plant_unconsumed (snapshot tail) tail_m.execution_hash;
      (match run_step tail tail_m.execution_hash url with
      | Error (R.Store S.Replay_incomplete) ->
          if state (snapshot tail) = Step_manifest.Completed then fail "unconsumed Done was completed"
      | Ok _ -> fail "unconsumed Done completed"
      | Error err -> fail "tail %s" (R.describe err));
      let replay = fresh "replay" in
      let _, replay_m =
        compile tools replay net [ ("material", "m"); ("fetch_url", url) ]
      in
      plant_replay (snapshot replay) replay_m.execution_hash url;
      (match run_step replay replay_m.execution_hash url with
      | Ok (R.Completed { reply = Step_manifest.Done "validated"; _ }) -> ()
      | Ok _ -> fail "replay reply"
      | Error err -> fail "replay %s" (R.describe err));
      let artifact_bytes =
        match S.read_blob ~path:(snapshot pure_dir) ~hash:manifest.artifact_hash ~kind:S.Artifact with
        | Ok bytes -> bytes
        | Error err -> fail "artifact %s" (S.describe err)
      in
      let mismatch name ~compiler_id ~runtime_id =
        let dir = fresh name in
        let manifest = admit_forged dir artifact ~compiler_id ~runtime_id artifact_bytes in
        let path = snapshot dir in
        let before = S.file_bytes path in
        let epoch0 = epoch path in
        match run_step dir manifest.execution_hash url with
        | Error (R.Store S.Version_mismatch) ->
            if S.file_bytes path <> before then fail "%s changed snapshot bytes" name;
            if epoch path <> epoch0 then fail "%s claimed" name
        | Ok _ -> fail "%s completed" name
        | Error err -> fail "%s %s" name (R.describe err)
      in
      mismatch "compiler" ~compiler_id:"ocamlc wrong manifest aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        ~runtime_id;
      mismatch "runtime" ~compiler_id ~runtime_id:"ocamlrun wrong manifest bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
      let flipped =
        if runtime_id = "" then fail "runtime id";
        let n = String.length runtime_id in
        let last = if runtime_id.[n - 1] = '0' then '1' else '0' in
        String.sub runtime_id 0 (n - 1) ^ String.make 1 last
      in
      mismatch "manifest" ~compiler_id ~runtime_id:flipped;
      let bad_bytecode ~name source =
        watchdog 20. (fun () ->
            let dir = fresh name in
            let bytes = host_bytecode source in
            let manifest = admit_forged dir artifact ~compiler_id ~runtime_id bytes in
            Unix.putenv "OCAGENT_WORKER_PID" (Filename.concat dir "worker.pid");
            let outcome =
              R.run_within ~timeout_s:8 ~path:(snapshot dir) ~execution_hash:manifest.execution_hash ~allowed_url:url
            in
            assert_dead dir;
            if state (snapshot dir) = Step_manifest.Completed then fail "%s completed" name;
            match outcome with
            | Error err when interrupted (R.describe err) -> ()
            | Ok _ -> fail "%s ok" name
            | Error err -> fail "%s %s" name (R.describe err))
      in
      bad_bytecode ~name:"noready" "let () = Unix.sleep 30\n";
      bad_bytecode ~name:"half"
        "external of_int : int -> Unix.file_descr = \"%identity\"\nlet () =\n  let fd = of_int 3 in\n  let b = Bytes.create 4 in\n  Bytes.set b 3 '\\n';\n  ignore (Unix.write fd b 0 4);\n  Unix.sleep 30\n";
      watchdog 20. (fun () ->
          let dir = fresh "spin" in
          let _, got = compile tools dir spin [] in
          match run_step ~timeout_s:8 dir got.execution_hash url with
          | Error err ->
              assert_dead dir;
              if state (snapshot dir) = Step_manifest.Completed then fail "spin completed";
              if not (interrupted (R.describe err)) then fail "spin %s" (R.describe err)
          | Ok _ -> fail "spin finished");
      let http_case mode name =
        let dir = fresh name in
        let log = Filename.concat dir "http.log" in
        let pid, port = serve mode log in
        Fun.protect
          ~finally:(fun () ->
            (try Unix.kill pid Sys.sigkill with Unix.Unix_error _ -> ());
            ignore (Unix.waitpid [] pid))
          (fun () ->
            let url = Printf.sprintf "http://127.0.0.1:%d/spec" port in
            let dir = fresh name in
            let _, got = compile tools dir net [ ("material", "m"); ("fetch_url", url) ] in
            let before = lines log in
            (match run_step dir got.execution_hash url with
            | Ok R.Awaiting_approval ->
                if lines log <> before then fail "%s fetched before approval (%d)" name (lines log)
            | Error err -> fail "%s await %s" name (R.describe err)
            | Ok _ -> fail "%s not await" name);
            let entry =
              match S.read_snapshot (snapshot dir) with
              | Ok snap -> ( match !(snap.journal.entries) with e :: _ -> e | [] -> fail "no entry")
              | Error err -> fail "%s" (S.describe err)
            in
            (match
               S.approve_step ~path:(snapshot dir) ~execution_hash:got.execution_hash ~seq:entry.seq ~callback_id:"cb"
                 ~expected_request_hash:entry.req_hash
                 ~decision_json:(Json.Assoc [ ("tag", Json.String "Approved") ])
             with
            | Ok () -> ()
            | Error err -> fail "%s approve %s" name (S.describe err));
            let seen = lines log in
            (match run_step ~timeout_s:8 dir got.execution_hash url with
            | Error (R.Store S.Unknown_result) ->
                let st = state (snapshot dir) in
                if st = Step_manifest.Completed || st = Step_manifest.Failed then
                  fail "%s became terminal" name;
                if lines log <> seen + 1 then fail "%s hits seen=%d now=%d" name seen (lines log)
            | Ok (R.Completed { reply = Step_manifest.Done text; _ }) -> fail "%s denied-or-done %s" name text
            | Ok _ -> fail "%s completed unknown" name
            | Error err -> fail "%s %s" name (R.describe err));
            let seen = lines log in
            (match run_step ~timeout_s:8 dir got.execution_hash url with
            | Error (R.Store S.Unknown_result) -> if lines log <> seen then fail "%s retried" name
            | other -> fail "%s retry %s" name (match other with Error err -> R.describe err | Ok _ -> "ok")))
      in
      http_case `Hang "http-hang";
      http_case `Flood "http-flood";
      let stop_dir = fresh "stop" in
      let stop_url = "http://127.0.0.1:9/spec" in
      let _, stop_m = compile tools stop_dir finally_src [ ("fetch_url", stop_url) ] in
      let stop_file = Filename.concat stop_dir "stop" in
      Unix.putenv "OCAGENT_STOP_FILE" stop_file;
      (match run_step stop_dir stop_m.execution_hash stop_url with
      | Ok R.Awaiting_approval ->
          Unix.putenv "OCAGENT_STOP_FILE" "";
          let text = if Sys.file_exists stop_file then In_channel.with_open_bin stop_file In_channel.input_all else "" in
          if not (List.mem "finally" (String.split_on_char '\n' text)) then fail "finally missing: %s" text;
          if not (List.mem "exit 2" (String.split_on_char '\n' text)) then fail "stop status: %s" text
      | Error err -> fail "stop %s" (R.describe err)
      | Ok _ -> fail "stop completed");
      Unix.putenv "OCAGENT_STOP_FILE" "";
      watchdog 15. (fun () ->
          let dir = fresh "pdeath" in
          let art = Filename.concat dir "artifact" in
          Unix.mkdir art 0o755;
          let oc = open_out (Filename.concat art "worker") in
          output_string oc "bytecode";
          close_out oc;
          let pidfile = Filename.concat dir "worker.pid" in
          Unix.putenv "OCAGENT_HOLD_SETUP" "4";
          Unix.putenv "OCAGENT_WORKER_PID" pidfile;
          let child =
            Unix.fork ()
          in
          if child = 0 then (
            ignore
              (X.spawn ~deadline:(X.monotonic () +. 20.) ~snap:(C.toolchain_root tools) ~artifact:art
                 ~stdout_path:(Filename.concat dir "out") ~stderr_path:(Filename.concat dir "err")
                 (X.Exec
                    {
                      argv = [| "/bin/sleep"; "30" |];
                      env = [| "LANG=C" |];
                      marker = Filename.concat dir "marker";
                    }));
            exit 0);
          let rec wait_file n =
            if Sys.file_exists pidfile then int_of_string (String.trim (In_channel.with_open_text pidfile In_channel.input_all))
            else if n = 0 then fail "没有 worker pid"
            else (
              Unix.sleepf 0.05;
              wait_file (n - 1))
          in
          let worker = wait_file 80 in
          (try Unix.kill child Sys.sigkill with Unix.Unix_error _ -> ());
          ignore (Unix.waitpid [] child);
          let rec gone n =
            if not (alive worker) then () else if n = 0 then fail "parent death left worker %d" worker else (Unix.sleepf 0.05; gone (n - 1))
          in
          gone 40;
          Unix.putenv "OCAGENT_HOLD_SETUP" "0";
          Unix.putenv "OCAGENT_WORKER_PID" "");
      let await_dir = fresh "await" in
      let await_url = "http://127.0.0.1:9/spec" in
      let _, await_m = compile tools await_dir net [ ("material", "m"); ("fetch_url", await_url) ] in
      (match run_step await_dir await_m.execution_hash await_url with
      | Ok R.Awaiting_approval ->
          if state (snapshot await_dir) <> Step_manifest.Awaiting_approval then fail "first wait projection"
      | Error err -> fail "await %s" (R.describe err)
      | Ok _ -> fail "await done");
      (match run_step await_dir await_m.execution_hash await_url with
      | Ok R.Awaiting_approval ->
          if state (snapshot await_dir) <> Step_manifest.Awaiting_approval then fail "rewait left Running"
      | Error err -> fail "rewait %s" (R.describe err)
      | Ok _ -> fail "rewait done");
      let race = fresh "race" in
      let race_path = snapshot race in
      let _, race_m = compile tools race net [ ("material", "m"); ("fetch_url", await_url) ] in
      (match run_step race race_m.execution_hash await_url with
      | Ok R.Awaiting_approval -> ()
      | Error err -> fail "race await %s" (R.describe err)
      | Ok _ -> fail "race done");
      let entry =
        match S.read_snapshot race_path with
        | Ok snap -> (match !(snap.journal.entries) with e :: _ -> e | [] -> fail "race entry")
        | Error err -> fail "%s" (S.describe err)
      in
      let approve_child id decision =
        Unix.fork () |> function
        | 0 -> (
            match
              S.approve_step ~path:race_path ~execution_hash:race_m.execution_hash ~seq:entry.seq ~callback_id:id
                ~expected_request_hash:entry.req_hash ~decision_json:decision
            with
            | Ok () -> exit 0
            | Error S.Approval_conflict -> exit 3
            | Error _ -> exit 4)
        | pid -> pid
      in
      let a =
        approve_child "race-a" (Json.Assoc [ ("tag", Json.String "Approved") ])
      in
      let b =
        approve_child "race-b" (Json.Assoc [ ("reason", Json.String "no"); ("tag", Json.String "Rejected") ])
      in
      let status pid =
        match Unix.waitpid [] pid with
        | _, Unix.WEXITED code -> code
        | _, _ -> fail "race signal"
      in
      let codes = List.sort compare [ status a; status b ] in
      if codes <> [ 0; 3 ] && codes <> [ 0; 4 ] then fail "race codes %s" (String.concat "," (List.map string_of_int codes));
      let dispatch_dir = fresh "dispatch" in
      (match
         S.with_executor ~path:(snapshot dispatch_dir) ~run_id:"run" ~agent_version:"v" (fun ex ->
             let req =
               {
                 S.seq = 0;
                 kind = "Fetch";
                 label = "x";
                 req_hash = "h";
                 req = Json.Null;
                 recovery = "Manual_only";
                 approval = false;
               }
             in
             match
               D.dispatch ~path:(snapshot dispatch_dir) ex req
                 ~after_prepare:(fun () -> raise Boom)
                 ~provider:(fun () -> Json.Null)
             with
             | Error (D.Raised Boom) -> Ok ()
             | Error (D.Raised exn) -> Error (S.Protocol (Printexc.to_string exn))
             | Error D.In_flight -> Error (S.Protocol "inflight")
             | Error (D.Store err) -> Error err
             | Ok _ -> Error (S.Protocol "dispatch ok"))
       with
      | Ok () -> ()
      | Error err -> fail "dispatch %s" (S.describe err));
      watchdog 8. (fun () ->
          let dir = fresh "setup-deadline" in
          let art = Filename.concat dir "artifact" in
          Unix.mkdir art 0o755;
          let oc = open_out (Filename.concat art "worker") in
          output_string oc "bytecode";
          close_out oc;
          let pidfile = Filename.concat dir "worker.pid" in
          Unix.putenv "OCAGENT_HOLD_SETUP" "30";
          Unix.putenv "OCAGENT_WORKER_PID" pidfile;
          let started = X.monotonic () in
          let outcome =
            X.spawn ~deadline:(started +. 1.5) ~snap:(C.toolchain_root tools) ~artifact:art
              ~stdout_path:(Filename.concat dir "out") ~stderr_path:(Filename.concat dir "err")
              (X.Exec
                 { argv = [| "/bin/sleep"; "30" |]; env = [| "LANG=C" |]; marker = Filename.concat dir "marker" })
          in
          let elapsed = X.monotonic () -. started in
          Unix.putenv "OCAGENT_HOLD_SETUP" "0";
          Unix.putenv "OCAGENT_WORKER_PID" "";
          if elapsed > 4. then fail "setup deadline %.1fs" elapsed;
          (match outcome with
          | Error (X.Unavailable msg) when interrupted msg -> ()
          | Ok launch ->
              ignore (X.release launch);
              fail "setup stayed up"
          | Error (X.Unavailable msg) -> fail "setup %s" msg
          | Error (X.Rejected msg) -> fail "setup rejected %s" msg);
          if Sys.file_exists pidfile then
            let pid = int_of_string (String.trim (In_channel.with_open_text pidfile In_channel.input_all)) in
            let rec gone n =
              if not (alive pid) then ()
              else if n = 0 then fail "setup left worker %d" pid
              else (
                Unix.sleepf 0.05;
                gone (n - 1))
            in
            gone 40);
      watchdog 20. (fun () ->
          let dir = fresh "supervisor-deadline" in
          let art = Filename.concat dir "artifact" in
          Unix.mkdir art 0o755;
          let bytes = host_bytecode "let () = Unix.sleep 30\n" in
          let worker_path = Filename.concat art "worker" in
          let oc = open_out_bin worker_path in
          output_string oc bytes;
          close_out oc;
          let argv, env = C.runtime_argv tools ~bytecode:worker_path in
          let deadline = X.monotonic () +. 8. in
          match
            X.spawn ~deadline ~snap:(C.toolchain_root tools) ~artifact:art
              ~stdout_path:(Filename.concat dir "out") ~stderr_path:(Filename.concat dir "err")
              (X.Exec { argv; env; marker = Filename.concat dir "marker" })
          with
          | Error (X.Unavailable msg) -> fail "supervisor spawn %s" msg
          | Error (X.Rejected msg) -> fail "supervisor rejected %s" msg
          | Ok launch ->
              Fun.protect
                ~finally:(fun () -> ignore (X.release launch))
                (fun () ->
                  let t0 = X.monotonic () in
                  let rec wait () =
                    if not (alive launch.worker) then X.monotonic () -. t0
                    else if X.monotonic () > deadline +. 1. then fail "liveness pipe stayed open past the monotonic deadline"
                    else (
                      Unix.sleepf 0.05;
                      wait ())
                  in
                  let elapsed = wait () in
                  if elapsed < 0.3 then
                    let err = Filename.concat dir "err" in
                    let text = if Sys.file_exists err then In_channel.with_open_bin err In_channel.input_all else "" in
                    fail "worker exited in %.2fs before the deadline: %s" elapsed text));
      let cache_dir = fresh "cache-bytes" in
      let _, cache_m = compile tools cache_dir pure [] in
      let cache_path = snapshot cache_dir in
      let before_bytes = S.file_bytes cache_path in
      let epoch0 = epoch cache_path in
      let stale_compiler, _ = C.identity tools in
      let ld = Filename.concat (C.toolchain_root tools) "stdlib/ld.conf" in
      let original = In_channel.with_open_bin ld In_channel.input_all in
      let restore () =
        (try Unix.chmod ld 0o644 with Unix.Unix_error _ -> ());
        let oc = open_out ld in
        output_string oc original;
        close_out oc;
        (try Unix.chmod ld 0o555 with Unix.Unix_error _ -> ())
      in
      Unix.chmod ld 0o644;
      let oc = open_out_gen [ Open_wronly; Open_append ] 0o644 ld in
      output_string oc "x";
      close_out oc;
      Unix.chmod ld 0o555;
      Fun.protect ~finally:restore (fun () ->
          (match C.hold_toolchain ~deadline:(Unix.gettimeofday () +. 20.) with
          | Ok again ->
              let live, _ = C.identity again in
              if live = stale_compiler then fail "cached manifest hash reused after byte change";
              C.release again
          | Error err -> fail "live identity %s" (C.describe err));
          match run_step cache_dir cache_m.execution_hash url with
          | Error (R.Store S.Version_mismatch) ->
              if S.file_bytes cache_path <> before_bytes then fail "byte change wrote the snapshot";
              if epoch cache_path <> epoch0 then fail "byte change claimed"
          | Ok _ -> fail "changed toolchain bytes completed"
          | Error err -> fail "cache bytes %s" (R.describe err));
      let old_dir = fresh "old-issued" in
      let _, old_m = compile tools old_dir pure [] in
      let old_path = snapshot old_dir in
      let old_req seq =
        {
          S.seq;
          kind = "Fetch";
          label = "Net.get";
          req_hash = "old";
          req = Json.Assoc [ ("k", Json.String "v") ];
          recovery = "Manual_only";
          approval = false;
        }
      in
      let issued_text =
        match
          S.with_step_executor ~path:old_path ~execution_hash:old_m.execution_hash (fun ex ->
              match S.prepare_operation ex (old_req 0) with
              | Ok (S.Execute issued) -> Ok (S.export_issued issued)
              | Ok _ -> Error (S.Protocol "execute")
              | Error _ as err -> err)
        with
        | Ok (S.Resumed text) -> text
        | Ok _ -> fail "old issued stored"
        | Error err -> fail "old issued %s" (S.describe err)
      in
      let epoch1 = epoch old_path in
      (match S.with_step_executor ~path:old_path ~execution_hash:old_m.execution_hash (fun _ex -> Ok ()) with
      | Error S.Unknown_result -> ()
      | Ok _ -> fail "in-flight fetch was dispatched again"
      | Error err -> fail "reclaim %s" (S.describe err));
      if epoch old_path = epoch1 then fail "new epoch was lost";
      (match S.import_issued issued_text with
      | Error err -> fail "import %s" (S.describe err)
      | Ok issued -> (
          match S.commit_result old_path issued (Json.Assoc [ ("body", Json.String "x"); ("status", Json.Int 200) ]) with
          | Error S.Stale_attempt -> ()
          | Ok () -> fail "old epoch message committed"
          | Error err -> fail "old commit %s" (S.describe err)));
      (match S.read_snapshot old_path with
      | Ok snap -> (
          match !(snap.journal.entries) with
          | [ entry ] when entry.G.status = G.Unknown -> ()
          | [ entry ] ->
              fail "old message status %s"
                (match entry.G.status with G.Pending -> "Pending" | G.Done -> "Done" | G.Unknown -> "Unknown")
          | _ -> fail "old journal shape")
      | Error err -> fail "%s" (S.describe err));
      let win = fresh "stop-win" in
      let win_url = "http://127.0.0.1:9/spec" in
      let _, win_m = compile tools win net [ ("material", "m"); ("fetch_url", win_url) ] in
      let barrier = Filename.concat win "barrier" in
      let oc = open_out barrier in
      output_string oc "pause:before-stop";
      close_out oc;
      let child =
        match Unix.fork () with
        | 0 -> (
            match run_step win win_m.execution_hash win_url with
            | Ok R.Awaiting_approval -> exit 0
            | Error err ->
                Printf.eprintf "stop-win %s\n%!" (R.describe err);
                exit 2
            | Ok _ -> exit 3)
        | pid -> pid
      in
      let win_path = snapshot win in
      let rec wait_entry n =
        match S.read_snapshot win_path with
        | Ok snap -> (
            match !(snap.journal.entries) with
            | entry :: _ when entry.G.kind = "Ask_human" && entry.G.status = G.Pending -> entry
            | _ when n = 0 -> fail "stop window did not save the approval"
            | _ ->
                Unix.sleepf 0.05;
                wait_entry (n - 1))
        | Error _ when n = 0 -> fail "stop window snapshot"
        | Error _ ->
            Unix.sleepf 0.05;
            wait_entry (n - 1)
      in
      let pending = wait_entry 200 in
      (match
         S.approve_step ~path:win_path ~execution_hash:win_m.execution_hash ~seq:pending.G.seq ~callback_id:"stop-win"
           ~expected_request_hash:pending.G.req_hash
           ~decision_json:(Json.Assoc [ ("tag", Json.String "Approved") ])
       with
      | Ok () -> ()
      | Error err -> fail "stop-win approve %s" (S.describe err));
      Sys.remove barrier;
      (match Unix.waitpid [] child with
      | _, Unix.WEXITED 0 -> ()
      | _, Unix.WEXITED n -> fail "stop-win child %d" n
      | _, Unix.WSIGNALED signal -> fail "stop-win signal %d" signal
      | _, _ -> fail "stop-win status");
      let approved =
        match S.read_snapshot win_path with
        | Ok snap -> (
            match !(snap.journal.entries) with
            | entry :: _ -> entry
            | [] -> fail "stop-win lost the decision")
        | Error err -> fail "%s" (S.describe err)
      in
      if approved.G.status <> G.Done || approved.G.callback_id <> "stop-win" then fail "Stop overwrote the approval";
      let ask =
        {
          S.seq = approved.G.seq;
          kind = "Ask_human";
          label = "Net.get";
          req_hash = params_hash win_url;
          req = fetch_params win_url;
          recovery = "AwaitingApproval";
          approval = true;
        }
      in
      let before_epoch = epoch win_path in
      (match
         S.with_step_executor ~path:win_path ~execution_hash:win_m.execution_hash (fun ex ->
             if S.epoch ex <= before_epoch then Error (S.Protocol "no new epoch") else S.prepare_operation ex ask)
       with
      | Ok (S.Resumed (S.Replay _)) ->
          let again =
            match S.read_snapshot win_path with
            | Ok snap -> (
                match !(snap.journal.entries) with
                | entry :: _ -> entry
                | [] -> fail "decision disappeared")
            | Error err -> fail "%s" (S.describe err)
          in
          if again.G.status <> G.Done || again.G.callback_id <> "stop-win" || again.G.result <> approved.G.result then
            fail "waiting state overwrote an approved decision";
          if state win_path = Step_manifest.Awaiting_approval then fail "new epoch was put back to waiting"
      | Ok (S.Resumed S.Awaiting_approval) -> fail "approved ask was dispatched as waiting"
      | Ok _ -> fail "stop-win prepare"
      | Error err -> fail "stop-win replay %s" (S.describe err));
      print_endline "step defenses ok")
