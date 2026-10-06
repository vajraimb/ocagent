(** Phase-1 fixed Step: durable identity, approval, and restart. No model. *)

module A = Ocagent_harness.Workbench_adapter
module Json = Ocagent_harness.Json
module SM = Step_manifest

let gateway = Sys.argv.(1)
let fail_stage stage fmt = Printf.ksprintf (fun msg -> failwith (stage ^ " " ^ msg)) fmt

let fresh () =
  let dir =
    Filename.concat (Filename.get_temp_dir_name ())
      (Printf.sprintf "ocagent-wb-%d-%d" (Unix.getpid ()) (Random.bits ()))
  in
  Unix.mkdir dir 0o700;
  dir

let read_file path = In_channel.with_open_bin path In_channel.input_all

let write_file path text =
  let oc = open_out path in
  output_string oc text;
  close_out oc

let lines path =
  if not (Sys.file_exists path) then 0
  else
    let text = read_file path in
    let n = ref 0 in
    String.iter (fun c -> if c = '\n' then incr n) text;
    !n

let sha path = if Sys.file_exists path then SM.sha256 (read_file path) else ""

let must stage answer =
  if not answer.A.ok then
    match answer.error with
    | Some error -> fail_stage stage "%s %s" error.code error.message
    | None -> fail_stage stage "not ok"
  else match answer.projection with Some projection -> projection | None -> fail_stage stage "no projection"

let code answer = match answer.A.error with Some error -> error.code | None -> ""

let snapshot root run_id = Filename.concat (Filename.concat (Filename.concat root "runs") run_id) "step/snapshot.json"

let env_with pairs =
  let base = Array.to_list (Unix.environment ()) in
  let base =
    List.filter
      (fun item -> not (List.exists (fun (key, _) -> String.starts_with ~prefix:(key ^ "=") item) pairs))
      base
  in
  Array.of_list (List.map (fun (key, value) -> key ^ "=" ^ value) pairs @ base)

let frame text =
  let n = String.length text in
  let buf = Bytes.create (4 + n) in
  Bytes.set buf 0 (Char.chr ((n lsr 24) land 255));
  Bytes.set buf 1 (Char.chr ((n lsr 16) land 255));
  Bytes.set buf 2 (Char.chr ((n lsr 8) land 255));
  Bytes.set buf 3 (Char.chr (n land 255));
  Bytes.blit_string text 0 buf 4 n;
  buf

let read_frame fd =
  let lenb = Bytes.create 4 in
  let rec read off len =
    if len = 0 then ()
    else
      match Unix.read fd lenb off len with
      | 0 -> fail_stage "protocol" "no final frame"
      | n -> read (off + n) (len - n)
      | exception Unix.Unix_error (Unix.EINTR, _, _) -> read off len
  in
  read 0 4;
  let n =
    (Char.code (Bytes.get lenb 0) lsl 24)
    lor (Char.code (Bytes.get lenb 1) lsl 16)
    lor (Char.code (Bytes.get lenb 2) lsl 8)
    lor Char.code (Bytes.get lenb 3)
  in
  if n <= 0 || n > 262144 then fail_stage "protocol" "frame %d" n;
  let body = Bytes.create n in
  let rec read off len =
    if len = 0 then ()
    else
      match Unix.read fd body off len with
      | 0 -> fail_stage "protocol" "short frame"
      | k -> read (off + k) (len - k)
      | exception Unix.Unix_error (Unix.EINTR, _, _) -> read off len
  in
  read 0 n;
  Bytes.to_string body

let call_gateway ~root ~url ?(extra = []) body =
  let in_r, in_w = Unix.pipe () in
  let out_r, out_w = Unix.pipe () in
  let env = env_with ([ ("OCAGENT_DURABLE_ROOT", root); ("OCAGENT_FETCH_URL", url) ] @ extra) in
  let pid = Unix.create_process_env gateway [| gateway |] env in_r out_w Unix.stderr in
  Unix.close in_r;
  Unix.close out_w;
  let bytes = frame (Json.canonical body) in
  ignore (Unix.write in_w bytes 0 (Bytes.length bytes));
  Unix.close in_w;
  let text = read_frame out_r in
  Unix.close out_r;
  let _, status = Unix.waitpid [] pid in
  (status, Json.parse text)

let json_string name json = match Json.field name json with Json.String s -> s | _ -> fail_stage "protocol" "string %s" name
let json_bool name json = match Json.field name json with Json.Bool b -> b | _ -> fail_stage "protocol" "bool %s" name
let json_int name json =
  match Json.field name json with
  | Json.Int n -> n
  | _ -> fail_stage "protocol" "int %s" name

let obj fields = Json.Assoc fields

let start_spec count_path =
  let sock = Unix.socket Unix.PF_INET Unix.SOCK_STREAM 0 in
  Unix.setsockopt sock Unix.SO_REUSEADDR true;
  Unix.bind sock (Unix.ADDR_INET (Unix.inet_addr_loopback, 0));
  Unix.listen sock 16;
  let port = match Unix.getsockname sock with Unix.ADDR_INET (_, port) -> port | _ -> failwith "addr" in
  match Unix.fork () with
  | 0 ->
      (try
         while true do
           let client, _ = Unix.accept sock in
           (try
              let buf = Bytes.create 2048 in
              let n = Unix.read client buf 0 2048 in
              let text = Bytes.sub_string buf 0 n in
              let spec =
                let rec line i =
                  if i + 10 > String.length text then false
                  else if String.sub text i 10 = "GET /spec " || String.sub text i 10 = "GET /spec\r" then true
                  else line (i + 1)
                in
                line 0
              in
              if spec then (
                let fd = Unix.openfile count_path [ Unix.O_RDWR; Unix.O_CREAT ] 0o644 in
                Unix.lockf fd Unix.F_LOCK 0;
                let buf = Bytes.create 64 in
                let nread = Unix.read fd buf 0 64 in
                let n = try int_of_string (String.trim (Bytes.sub_string buf 0 nread)) with _ -> 0 in
                ignore (Unix.lseek fd 0 Unix.SEEK_SET);
                let next = string_of_int (n + 1) in
                ignore (Unix.write_substring fd next 0 (String.length next));
                Unix.ftruncate fd (String.length next);
                Unix.lockf fd Unix.F_ULOCK 0;
                Unix.close fd);
              let body = "spec-body" in
              let status = if spec then "200 OK" else "404 Not Found" in
              let resp =
                Printf.sprintf "HTTP/1.1 %s\r\nContent-Length: %d\r\nConnection: close\r\n\r\n%s" status (String.length body) body
              in
              ignore (Unix.write_substring client resp 0 (String.length resp))
            with _ -> ());
           (try Unix.close client with _ -> ())
         done
       with _ -> exit 0);
      exit 0
  | pid ->
      Unix.close sock;
      (pid, Printf.sprintf "http://127.0.0.1:%d/spec" port)

let gets path = if not (Sys.file_exists path) then 0 else try int_of_string (String.trim (read_file path)) with _ -> 0

let alive pid =
  match Unix.kill pid 0 with
  | () -> true
  | exception Unix.Unix_error (Unix.ESRCH, _, _) -> false
  | exception Unix.Unix_error _ -> true

let wait_dead pid =
  let rec loop n =
    if not (alive pid) then ()
    else if n = 0 then fail_stage "UI14" "worker %d still alive" pid
    else (
      Unix.sleepf 0.05;
      loop (n - 1))
  in
  loop 40

let () =
  Random.self_init ();
  if not (A.url_ok "http://127.0.0.1:9/spec") then fail_stage "UI16" "controlled url rejected";
  if A.url_ok "https://127.0.0.1:9/spec" || A.url_ok "http://127.0.0.1:9/other" || A.url_ok "http://example.com/spec" || A.url_ok "http://127.0.0.1:9/spec/extra" then
    fail_stage "UI16" "public or rewritten url accepted";
  let root = fresh () in
  let url = "http://127.0.0.1:9/spec" in
  let created = A.create_run ~root ~owner:"owner-a" ~fetch_url:url ~dedupe_key:"k1" ~material:"alpha" ~task:"look" in
  let first = must "UI13" created in
  let again = A.create_run ~root ~owner:"owner-a" ~fetch_url:url ~dedupe_key:"k1" ~material:"alpha" ~task:"look" in
  let second = must "UI13" again in
  if first.run_id <> second.run_id then fail_stage "UI13" "same input created %s and %s" first.run_id second.run_id;
  let clash = A.create_run ~root ~owner:"owner-a" ~fetch_url:url ~dedupe_key:"k1" ~material:"beta" ~task:"look" in
  if clash.ok || code clash <> "conflict" then fail_stage "UI13" "conflict -> %s" (code clash);
  let other = A.locate ~root ~owner:"owner-b" first.run_id in
  if other.ok || code other <> "forbidden" then fail_stage "UI13" "cross owner -> %s" (code other);
  if (A.locate ~root ~owner:"owner-a" "../secret").ok then fail_stage "UI13" "traversal accepted";
  let link = Filename.concat (Filename.concat root "runs") "abcdefabcdefabcdefabcdefabcdefab" in
  Unix.symlink "/tmp" link;
  if (A.locate ~root ~owner:"owner-a" "abcdefabcdefabcdefabcdefabcdefab").ok then fail_stage "UI13" "symlink accepted";
  let bad_url =
    call_gateway ~root ~url
      (obj
         [
           ("dedupe_key", Json.String "k2");
           ("fetch_url", Json.String "http://example.com/spec");
           ("id", Json.String "r1");
           ("material", Json.String "alpha");
           ("op", Json.String "createRun");
           ("owner", Json.String "owner-a");
           ("task", Json.String "look");
           ("v", Json.String "workbench_v1");
         ])
  in
  let _, bad_json = bad_url in
  if json_bool "ok" bad_json then fail_stage "UI13" "client url accepted";
  if json_string "code" (Json.field "error" bad_json) <> "schema" then fail_stage "UI13" "client url code";
  let listed = A.list_runs ~root ~owner:"owner-a" in
  if (not listed.ok) || List.length listed.runs <> 1 then fail_stage "UI10" "list %d" (List.length listed.runs);
  let bytes = sha (snapshot root first.run_id) in
  ignore (A.locate ~root ~owner:"owner-a" first.run_id);
  ignore (A.locate ~root ~owner:"owner-a" first.run_id);
  if sha (snapshot root first.run_id) <> bytes then fail_stage "UI10" "readonly changed snapshot";
  Printf.printf "identity ok\n%!";
  let spec_count = Filename.concat root "gets.txt" in
  write_file spec_count "0";
  let spec_pid, spec_url = start_spec spec_count in
  let log_path = Filename.concat root "workers.log" in
  let pid_path = Filename.concat root "worker.pid" in
  Unix.putenv "OCAGENT_WORKER_LOG" log_path;
  Unix.putenv "OCAGENT_WORKER_PID" pid_path;
  let make key material =
    let answer = A.create_run ~root ~owner:"owner-a" ~fetch_url:spec_url ~dedupe_key:key ~material ~task:"fixed" in
    let projection = must "create" answer in
    let prepared = A.prepare_run ~root ~owner:"owner-a" ~run_id:projection.run_id in
    let admitted = must "prepare" prepared in
    let again = A.prepare_run ~root ~owner:"owner-a" ~run_id:projection.run_id in
    let admitted_again = must "prepare-again" again in
    if admitted.compile_count <> 1 || admitted_again.compile_count <> 1 then
      fail_stage "UI09" "compile_count %d/%d" admitted.compile_count admitted_again.compile_count;
    if admitted.execution_hash <> admitted_again.execution_hash then fail_stage "UI09" "execution hash changed";
    admitted
  in
  let happy = make "happy" "alpha" in
  let hash = match happy.execution_hash with Some hash -> hash | None -> fail_stage "UI01" "no hash" in
  let stable = sha (snapshot root happy.run_id) in
  ignore (A.locate ~root ~owner:"owner-a" happy.run_id);
  if sha (snapshot root happy.run_id) <> stable || happy.epoch <> Some 0 then fail_stage "UI10" "prepare query moved store";
  let waiting = must "UI01" (A.start_or_resume ~root ~owner:"owner-a" ~run_id:happy.run_id ~execution_hash:hash) in
  (match waiting.pending_approval with
  | None -> fail_stage "UI01" "no saved approval"
  | Some approval ->
      if not (String.length approval.request_hash = 64) then fail_stage "UI01" "hash not stored";
      if not (String.exists (fun c -> c = ':') approval.params) then fail_stage "UI01" "params empty";
      if approval.params = "" || not (let s = approval.params in let n = String.length spec_url in
           let rec go i = if i + n > String.length s then false else if String.sub s i n = spec_url then true else go (i + 1) in go 0)
      then fail_stage "UI01" "params are not the saved url");
  if waiting.store_state <> Some "AwaitingApproval" then fail_stage "UI01" "state %s" (Option.value waiting.store_state ~default:"none");
  if gets spec_count <> 0 then fail_stage "UI01" "GET %d before approval" (gets spec_count);
  if lines log_path <> 1 then fail_stage "UI01" "worker_start %d" (lines log_path);
  (match read_file pid_path |> String.trim |> int_of_string with pid -> wait_dead pid | exception _ -> fail_stage "UI01" "no worker pid");
  let epoch_wait = waiting.epoch in
  let revision_wait = waiting.revision in
  let viewed = must "UI02" (A.locate ~root ~owner:"owner-a" happy.run_id) in
  if viewed.compile_count <> 1 || lines log_path <> 1 || gets spec_count <> 0 || viewed.execution_hash <> Some hash then
    fail_stage "UI02" "readonly restarted work";
  let approval = match viewed.pending_approval with Some approval -> approval | None -> fail_stage "UI02" "approval lost" in
  let wrong = A.decide_approval ~root ~owner:"owner-a" ~run_id:happy.run_id ~execution_hash:hash ~seq:approval.seq ~callback_id:"cb-1"
      ~request_hash:(String.make 64 'a') ~decision:(obj [ ("tag", Json.String "Approved") ]) in
  if wrong.ok || code wrong <> "Request_changed" then fail_stage "UI04" "bad hash -> %s" (code wrong);
  if gets spec_count <> 0 then fail_stage "UI04" "bad hash fetched";
  let approved = must "UI04" (A.decide_approval ~root ~owner:"owner-a" ~run_id:happy.run_id ~execution_hash:hash ~seq:approval.seq
        ~callback_id:"cb-1" ~request_hash:approval.request_hash ~decision:(obj [ ("tag", Json.String "Approved") ])) in
  let approved_again = must "UI04" (A.decide_approval ~root ~owner:"owner-a" ~run_id:happy.run_id ~execution_hash:hash ~seq:approval.seq
        ~callback_id:"cb-1" ~request_hash:approval.request_hash ~decision:(obj [ ("tag", Json.String "Approved") ])) in
  if approved.store_state = Some "Completed" || approved_again.execution_hash <> Some hash then fail_stage "UI04" "approve started execution";
  let clash = A.decide_approval ~root ~owner:"owner-a" ~run_id:happy.run_id ~execution_hash:hash ~seq:approval.seq ~callback_id:"cb-2"
      ~request_hash:approval.request_hash ~decision:(obj [ ("tag", Json.String "Rejected"); ("reason", Json.String "no") ]) in
  if clash.ok || code clash <> "Approval_conflict" then fail_stage "UI04" "conflict -> %s" (code clash);
  if lines log_path <> 1 || gets spec_count <> 0 then fail_stage "UI04" "approval emitted work";
  let _status, resumed_json =
    call_gateway ~root ~url:spec_url
      (obj
         [
           ("execution_hash", Json.String hash);
           ("id", Json.String "resume");
           ("op", Json.String "startOrResumeRun");
           ("owner", Json.String "owner-a");
           ("run_id", Json.String happy.run_id);
           ("v", Json.String "workbench_v1");
         ])
  in
  if not (json_bool "ok" resumed_json) then fail_stage "UI02" "resume %s" (Json.canonical resumed_json);
  let resumed = Json.field "projection" resumed_json in
  if json_string "store_state" resumed <> "Completed" then fail_stage "UI02" "not completed";
  (match Json.field "reply" resumed with
  | Json.Assoc _ as reply -> if json_string "tag" reply <> "Done" || json_string "text" reply <> "validated:alpha" then fail_stage "UI02" "reply"
  | _ -> fail_stage "UI02" "reply missing");
  if gets spec_count <> 1 || lines log_path <> 2 then fail_stage "UI02" "GET %d workers %d" (gets spec_count) (lines log_path);
  let done_bytes = sha (snapshot root happy.run_id) in
  let done_epoch = json_int "epoch" resumed in
  let again = must "UI03" (A.start_or_resume ~root ~owner:"owner-a" ~run_id:happy.run_id ~execution_hash:hash) in
  ignore (A.locate ~root ~owner:"owner-a" happy.run_id);
  if sha (snapshot root happy.run_id) <> done_bytes || gets spec_count <> 1 || lines log_path <> 2 || again.compile_count <> 1 then
    fail_stage "UI03" "completed view reran";
  if Option.value again.epoch ~default:(-1) <> done_epoch then fail_stage "UI03" "epoch moved";
  let rev = again.revision in
  let same = must "UI04" (A.decide_approval ~root ~owner:"owner-a" ~run_id:happy.run_id ~execution_hash:hash ~seq:approval.seq
        ~callback_id:"cb-1" ~request_hash:approval.request_hash ~decision:(obj [ ("tag", Json.String "Approved") ])) in
  if same.revision <> rev then fail_stage "UI04" "completed callback wrote";
  let late = A.decide_approval ~root ~owner:"owner-a" ~run_id:happy.run_id ~execution_hash:hash ~seq:approval.seq ~callback_id:"cb-3"
      ~request_hash:approval.request_hash ~decision:(obj [ ("tag", Json.String "Rejected"); ("reason", Json.String "late") ]) in
  if late.ok || code late <> "Approval_conflict" || (must "UI04" (A.locate ~root ~owner:"owner-a" happy.run_id)).revision <> rev then
    fail_stage "UI04" "completed conflict wrote";
  let barrier = Filename.concat (Filename.dirname (snapshot root happy.run_id)) "barrier" in
  write_file barrier "before-complete";
  let status =
    match Unix.fork () with
    | 0 ->
        (try
           let answer = A.start_or_resume ~root ~owner:"owner-a" ~run_id:happy.run_id ~execution_hash:hash in
           if (not answer.ok) || (match answer.projection with Some p -> p.store_state <> Some "Completed" | None -> true) then exit 3;
           exit 0
         with _ -> exit 2)
    | pid ->
        let _, status = Unix.waitpid [] pid in
        status
  in
  (match status with Unix.WEXITED 0 -> () | _ -> fail_stage "UI03" "completed start entered worker");
  Sys.remove barrier;
  if epoch_wait = None || revision_wait = None then fail_stage "UI01" "missing counters";
  Printf.printf "UI01 UI02 UI03 UI04 UI10 ok\n%!";
  let denied = make "denied" "alpha" in
  let denied_hash = match denied.execution_hash with Some hash -> hash | None -> fail_stage "UI04" "no denied hash" in
  let saved_url = denied.fetch_url in
  let nopath = Filename.concat root "nopath" in
  Unix.mkdir nopath 0o755;
  let _, tool_json =
    call_gateway ~root ~url:spec_url ~extra:[ ("PATH", nopath) ]
      (obj
         [
           ("execution_hash", Json.String denied_hash);
           ("id", Json.String "notool");
           ("op", Json.String "startOrResumeRun");
           ("owner", Json.String "owner-a");
           ("run_id", Json.String denied.run_id);
           ("v", Json.String "workbench_v1");
         ])
  in
  if json_bool "ok" tool_json then fail_stage "UI12" "missing toolchain still ran";
  let tool_code = json_string "code" (Json.field "error" tool_json) in
  if tool_code <> "Unavailable" && tool_code <> "Version_mismatch" && tool_code <> "Rejected" then fail_stage "UI12" "toolchain code %s" tool_code;
  let after_tool = must "UI12" (A.locate ~root ~owner:"owner-a" denied.run_id) in
  if after_tool.epoch <> Some 0 || after_tool.store_state <> Some "Prepared" then fail_stage "UI12" "preflight claim moved epoch";
  let waiting_no = must "UI04" (A.start_or_resume ~root ~owner:"owner-a" ~run_id:denied.run_id ~execution_hash:denied_hash) in
  let denial = match waiting_no.pending_approval with Some approval -> approval | None -> fail_stage "UI04" "no denial card" in
  ignore
    (must "UI04"
       (A.decide_approval ~root ~owner:"owner-a" ~run_id:denied.run_id ~execution_hash:denied_hash ~seq:denial.seq ~callback_id:"no-1"
          ~request_hash:denial.request_hash
          ~decision:(obj [ ("reason", Json.String "no"); ("tag", Json.String "Rejected") ])));
  let gets_before = gets spec_count in
  let rejected = must "UI04" (A.start_or_resume ~root ~owner:"owner-a" ~run_id:denied.run_id ~execution_hash:denied_hash) in
  (match rejected.reply with Some reply when reply.tag = "Done" && reply.text = "rejected:no" -> () | _ -> fail_stage "UI04" "reject reply");
  if gets spec_count <> gets_before || denied.fetch_url <> saved_url then fail_stage "UI04" "reject fetched or rewrote url";
  Printf.printf "UI04 reject UI12 toolchain ok\n%!";
  let race = make "race" "alpha" in
  let race_hash = match race.execution_hash with Some hash -> hash | None -> fail_stage "UI05" "no hash" in
  let left = Filename.concat root "race-left" in
  let right = Filename.concat root "race-right" in
  let fork_start path =
    match Unix.fork () with
    | 0 ->
        let answer = A.start_or_resume ~root ~owner:"owner-a" ~run_id:race.run_id ~execution_hash:race_hash in
        write_file path (if answer.ok then "ok" else code answer);
        exit 0
    | pid -> pid
  in
  let pid_a = fork_start left in
  let pid_b = fork_start right in
  ignore (Unix.waitpid [] pid_a);
  ignore (Unix.waitpid [] pid_b);
  let results = List.sort String.compare [ String.trim (read_file left); String.trim (read_file right) ] in
  if results <> [ "Already_running"; "ok" ] && results <> [ "ok"; "Already_running" ] then fail_stage "UI05" "race %s" (String.concat "," results);
  if gets spec_count <> gets_before then fail_stage "UI05" "race fetched";
  Printf.printf "UI05 ok\n%!";
  let artifact =
    Filename.concat
      (Filename.concat (Filename.concat (Filename.concat root "runs") race.run_id) "step/step-blobs")
      (Option.get race.artifact_hash)
  in
  let epoch_before = match (must "UI12" (A.locate ~root ~owner:"owner-a" race.run_id)).epoch with Some n -> n | None -> fail_stage "UI12" "no epoch" in
  Sys.remove artifact;
  let missing = A.start_or_resume ~root ~owner:"owner-a" ~run_id:race.run_id ~execution_hash:race_hash in
  if missing.ok || code missing <> "Artifact_missing" then fail_stage "UI12" "missing -> %s" (code missing);
  let raced = must "UI12" (A.locate ~root ~owner:"owner-a" race.run_id) in
  if raced.epoch <> Some epoch_before then fail_stage "UI12" "missing artifact changed epoch";
  if raced.store_state = Some "Completed" then fail_stage "UI12" "missing completed";
  Printf.printf "UI12 artifact ok\n%!";
  let kill_case key phase expect_get =
    let run = make key "alpha" in
    let hash = match run.execution_hash with Some hash -> hash | None -> fail_stage phase "no hash" in
    let waiting = must phase (A.start_or_resume ~root ~owner:"owner-a" ~run_id:run.run_id ~execution_hash:hash) in
    let card = match waiting.pending_approval with Some card -> card | None -> fail_stage phase "no card" in
    ignore
      (must phase
         (A.decide_approval ~root ~owner:"owner-a" ~run_id:run.run_id ~execution_hash:hash ~seq:card.seq ~callback_id:(key ^ "-cb")
            ~request_hash:card.request_hash ~decision:(obj [ ("tag", Json.String "Approved") ])));
    let barrier = Filename.concat (Filename.dirname (snapshot root run.run_id)) "barrier" in
    write_file barrier phase;
    let before = gets spec_count in
    let status =
      match Unix.fork () with
      | 0 ->
          ignore (A.start_or_resume ~root ~owner:"owner-a" ~run_id:run.run_id ~execution_hash:hash);
          exit 0
      | pid ->
          let _, status = Unix.waitpid [] pid in
          status
    in
    (match status with Unix.WSIGNALED _ -> () | Unix.WEXITED n -> fail_stage phase "child exited %d" n | _ -> fail_stage phase "child status");
    Sys.remove barrier;
    let first = A.start_or_resume ~root ~owner:"owner-a" ~run_id:run.run_id ~execution_hash:hash in
    let second = A.start_or_resume ~root ~owner:"owner-a" ~run_id:run.run_id ~execution_hash:hash in
    if code first <> "Unknown_result" && (match first.projection with Some p -> p.store_state <> Some "BlockedUnknown" && p.error = None | None -> true) then
      if phase = "after-dispatch" then fail_stage "UI06" "dispatch recovery %s %s" (code first) (match first.projection with Some p -> Option.value p.store_state ~default:"-" | None -> "-");
    if phase = "after-dispatch" && gets spec_count <> before then fail_stage "UI06" "redispatched GET %d -> %d" before (gets spec_count);
    if phase = "after-done" then (
      if gets spec_count <> before + 1 && gets spec_count <> expect_get then fail_stage "UI06" "done window GET %d from %d" (gets spec_count) before;
      if code second = "Unknown_result" then fail_stage "UI06" "done window stayed unknown";
      match second.projection with Some p when p.store_state = Some "Completed" -> () | _ -> fail_stage "UI06" "done window did not replay")
  in
  kill_case "dispatch" "after-dispatch" 0;
  Printf.printf "UI06 dispatch ok\n%!";
  kill_case "donecase" "after-done" (gets spec_count);
  Printf.printf "UI06 done ok\n%!";
  let pause = make "pause" "alpha" in
  let pause_hash = match pause.execution_hash with Some hash -> hash | None -> fail_stage "UI14" "no hash" in
  let barrier = Filename.concat (Filename.dirname (snapshot root pause.run_id)) "barrier" in
  write_file barrier "pause:before-stop";
  (try Sys.remove pid_path with Sys_error _ -> ());
  let pause_pid =
    match Unix.fork () with
    | 0 ->
        ignore (A.start_or_resume ~root ~owner:"owner-a" ~run_id:pause.run_id ~execution_hash:pause_hash);
        exit 0
    | pid -> pid
  in
  let rec wait_pid n =
    if Sys.file_exists pid_path && String.trim (read_file pid_path) <> "" then int_of_string (String.trim (read_file pid_path))
    else if n = 0 then fail_stage "UI14" "worker pid did not appear"
    else (
      Unix.sleepf 0.05;
      wait_pid (n - 1))
  in
  let worker = wait_pid 200 in
  Unix.kill pause_pid Sys.sigkill;
  ignore (Unix.waitpid [] pause_pid);
  wait_dead worker;
  write_file barrier "released";
  let viewed = must "UI14" (A.locate ~root ~owner:"owner-a" pause.run_id) in
  if viewed.store_state <> Some "AwaitingApproval" || gets spec_count = -1 then fail_stage "UI14" "state %s" (Option.value viewed.store_state ~default:"none");
  if viewed.fetch_url <> spec_url then fail_stage "UI16" "url rewritten";
  Printf.printf "UI14 ok\n%!";
  Unix.kill spec_pid Sys.sigterm;
  ignore (Unix.waitpid [] spec_pid);
  Printf.printf "phase1 fixed step ok\n%!"
