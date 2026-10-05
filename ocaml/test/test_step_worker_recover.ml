(** Cross-process step recovery. A waits, an approve process decides, B replays, C only reads. *)

module C = Ocagent_harness.Step_compile
module R = Ocagent_harness.Step_runtime
module S = Ocagent_harness.Store
module J = Ocagent_harness.Journal
module Json = Ocagent_harness.Json

let fail fmt = Printf.ksprintf failwith fmt

let snapshot dir = Filename.concat dir "snapshot.json"
let port_path dir = Filename.concat dir "port"
let http_path dir = Filename.concat dir "http.count"
let worker_path dir = Filename.concat dir "worker.log"
let compile_path dir = Filename.concat dir "compile.log"

let lines path =
  if not (Sys.file_exists path) then 0
  else
    let text = In_channel.with_open_bin path In_channel.input_all in
    let n = ref 0 in
    String.iter (fun c -> if c = '\n' then incr n) text;
    !n

let note path name =
  let fd = Unix.openfile path [ Unix.O_WRONLY; Unix.O_APPEND; Unix.O_CREAT; Unix.O_CLOEXEC ] 0o644 in
  Fun.protect
    ~finally:(fun () -> Unix.close fd)
    (fun () ->
      let line = name ^ "\n" in
      ignore (Unix.write_substring fd line 0 (String.length line));
      Unix.fsync fd)

let fresh name =
  let dir = Filename.concat (Filename.get_temp_dir_name ()) (Printf.sprintf "ocagent-%s-%d-%d" name (Unix.getpid ()) (Random.bits ())) in
  Unix.mkdir dir 0o755;
  dir

let step url_unused =
  ignore url_unused;
  {|open Step_api
module Step : STEP = struct
  let run () =
    match Input.get "material", Input.get "fetch_url" with
    | Some material, Some url ->
        Trace.note material;
        (match Net.get url with
        | Ok resp -> if Helper.check resp.status resp.body then Done "validated" else Done ("bad:" ^ resp.body)
        | Error (Net.Approval_rejected reason) -> Done ("rejected:" ^ reason)
        | Error (Net.Denied reason) -> Done ("denied:" ^ reason))
    | _ -> Done "missing"
end
|}

let pure =
  {|open Step_api
module Step : STEP = struct
  let run () = Done "pure"
end
|}

let helper = "let check status body = status = 200 && String.equal body \"spec-body\"\n"
let helper_mli = "val check : int -> string -> bool\n"

let bridge_bad =
  {|open Step_api
module Step : STEP = struct
  let run () = Step_bridge.input_get "x" |> ignore; Done "no"
end
|}

let modules = [ { C.name = "Helper"; source = helper; interface_ = helper_mli } ]

let serve dir =
  let sock = Unix.socket Unix.PF_INET Unix.SOCK_STREAM 0 in
  Unix.setsockopt sock Unix.SO_REUSEADDR true;
  Unix.bind sock (Unix.ADDR_INET (Unix.inet_addr_loopback, 0));
  Unix.listen sock 16;
  let port = match Unix.getsockname sock with Unix.ADDR_INET (_, port) -> port | _ -> fail "port" in
  let oc = open_out (port_path dir) in
  output_string oc (string_of_int port);
  close_out oc;
  let body = "spec-body" in
  let resp = Printf.sprintf "HTTP/1.1 200 OK\r\nContent-Length: %d\r\nConnection: close\r\n\r\n%s" (String.length body) body in
  while true do
    let client, _ = Unix.accept sock in
    let tmp = Bytes.create 1024 in
    let n = try Unix.read client tmp 0 1024 with _ -> 0 in
    let request = if n > 0 then Bytes.sub_string tmp 0 n else "" in
    if String.starts_with ~prefix:"GET /spec " request then note (http_path dir) "hit";
    let rec write_all off len =
      if len > 0 then
        let wrote = Unix.write_substring client resp off len in
        write_all (off + wrote) (len - wrote)
    in
    (try write_all 0 (String.length resp) with _ -> ());
    Unix.close client
  done

let wait_port dir =
  let rec loop n =
    if n = 0 then fail "HTTP 没有起来"
    else if Sys.file_exists (port_path dir) then int_of_string (String.trim (In_channel.with_open_text (port_path dir) In_channel.input_all))
    else (
      Unix.sleepf 0.05;
      loop (n - 1))
  in
  loop 100

let copy_tree src dst =
  if not (Sys.file_exists dst) then Unix.mkdir dst 0o755;
  let rec walk rel =
    let dir = if rel = "" then src else Filename.concat src rel in
    Array.iter
      (fun name ->
        let child = if rel = "" then name else Filename.concat rel name in
        let from = Filename.concat src child in
        let into = Filename.concat dst child in
        if Sys.is_directory from then (
          Unix.mkdir into 0o755;
          walk child)
        else
          let text = In_channel.with_open_bin from In_channel.input_all in
          let oc = open_out_bin into in
          output_string oc text;
          close_out oc)
      (Sys.readdir dir)
  in
  walk ""

let spawn args =
  let pid = Unix.create_process Sys.argv.(0) (Array.of_list (Sys.argv.(0) :: args)) Unix.stdin Unix.stdout Unix.stderr in
  match Unix.waitpid [] pid with
  | _, Unix.WEXITED 0 -> ()
  | _, Unix.WEXITED code -> fail "子进程退出 %d (%s)" code (String.concat " " args)
  | _, Unix.WSIGNALED signal -> fail "子进程信号 %d (%s)" signal (String.concat " " args)
  | _, _ -> fail "子进程结束"

let spawn_kill args =
  let pid = Unix.create_process Sys.argv.(0) (Array.of_list (Sys.argv.(0) :: args)) Unix.stdin Unix.stdout Unix.stderr in
  match Unix.waitpid [] pid with
  | _, Unix.WSIGNALED signal when signal = Sys.sigkill -> ()
  | _, status -> fail "应被 SIGKILL，实际 %s" (match status with Unix.WEXITED n -> string_of_int n | _ -> "其他")

let ask path =
  match S.read_snapshot path with
  | Error err -> fail "snapshot %s" (S.describe err)
  | Ok snap -> (
      match List.find_opt (fun e -> e.J.kind = "Ask_human") !(snap.journal.entries) with
      | Some entry -> entry
      | None -> fail "没有审批")

let run_mode dir hash url expect =
  Unix.putenv "OCAGENT_WORKER_LOG" (worker_path dir);
  Unix.putenv "OCAGENT_WORKER_PID" (Filename.concat dir "worker.pid");
  let done_text = function
    | "validated" -> Some "validated"
    | "pure" -> Some "pure"
    | "continue" -> None
    | _ -> None
  in
  match R.run ~path:(snapshot dir) ~execution_hash:hash ~allowed_url:url with
  | Ok R.Awaiting_approval when expect = "await" -> exit 0
  | Ok (R.Completed { reply = Step_manifest.Done text; _ }) when done_text expect = Some text -> exit 0
  | Ok (R.Completed { reply = Step_manifest.Done text; _ }) when expect = "rejected" && String.starts_with ~prefix:"rejected:" text -> exit 0
  | Ok (R.Completed { reply = Step_manifest.Continue "continued"; _ }) when expect = "continue" -> exit 0
  | Ok (R.Completed { reply = Step_manifest.Ask "asked"; _ }) when expect = "ask" -> exit 0
  | Ok (R.Completed { reply = Step_manifest.Partial "part"; _ }) when expect = "partial" -> exit 0
  | Ok R.Awaiting_approval -> fail "意外等待"
  | Ok (R.Completed { reply; _ }) -> fail "完成 %s" (match reply with Step_manifest.Done t -> "done:" ^ t | Step_manifest.Continue t -> "cont:" ^ t | Step_manifest.Ask t -> "ask:" ^ t | Step_manifest.Partial t -> "part:" ^ t)
  | Error err -> fail "%s" (R.describe err)

let query_mode dir hash expect =
  let before = lines (worker_path dir) in
  match R.query ~path:(snapshot dir) ~execution_hash:hash with
  | Ok (reply, _) ->
      let ok =
        match (expect, reply) with
        | "validated", Step_manifest.Done "validated" -> true
        | "continue", Step_manifest.Continue "continued" -> true
        | "ask", Step_manifest.Ask "asked" -> true
        | "partial", Step_manifest.Partial "part" -> true
        | _ -> false
      in
      if not ok then fail "query reply";
      if lines (worker_path dir) <> before then fail "query started a worker" else exit 0
  | Error err -> fail "query %s" (R.describe err)

let approve_mode dir hash decision =
  let path = snapshot dir in
  let entry = ask path in
  match
    S.approve_step ~path ~execution_hash:hash ~seq:entry.seq ~callback_id:"cb-step" ~expected_request_hash:entry.req_hash
      ~decision_json:decision
  with
  | Ok () -> exit 0
  | Error err -> fail "approve %s" (S.describe err)

let alive pid =
  match Unix.kill pid 0 with
  | () -> true
  | exception Unix.Unix_error (Unix.ESRCH, _, _) -> false
  | exception Unix.Unix_error _ -> true

let assert_dead dir =
  let path = Filename.concat dir "worker.pid" in
  if not (Sys.file_exists path) then fail "没有 worker pid"
  else
    let pid = int_of_string (String.trim (In_channel.with_open_text path In_channel.input_all)) in
    if alive pid then fail "worker %d 仍在" pid

let blob dir hash = Filename.concat (Filename.concat dir "step-blobs") hash

let reply_source ctor text =
  Printf.sprintf "open Step_api\nmodule Step : STEP = struct\n  let run () = %s %S\nend\n" ctor text

let parent () =
  let root = fresh "step-root" in
  let server = Unix.create_process Sys.argv.(0) [| Sys.argv.(0); "serve"; root |] Unix.stdin Unix.stdout Unix.stderr in
  Fun.protect
    ~finally:(fun () ->
      (try Unix.kill server Sys.sigterm with Unix.Unix_error _ -> ());
      ignore (Unix.waitpid [] server))
    (fun () ->
      let port = wait_port root in
      let url = Printf.sprintf "http://127.0.0.1:%d/spec" port in
      let tools =
        match C.hold_toolchain ~deadline:(Unix.gettimeofday () +. 60.) with
        | Ok tools -> tools
        | Error err -> fail "toolchain %s" (C.describe err)
      in
      Fun.protect
        ~finally:(fun () -> C.release tools)
        (fun () ->
          let compile_one dir source modules input =
            match
              C.compile_with ~setup_fault:None ~hang:false ~deadline:(Unix.gettimeofday () +. 90.) tools ~source ~modules ~input
            with
            | Error err -> fail "compile %s" (C.describe err)
            | Ok artifact -> (
                match C.admit ~path:(snapshot dir) ~run_id:"run" ~agent_version:"step-v3" ~admission_key:"main" artifact with
                | Error err -> fail "admit %s" (C.describe err)
                | Ok manifest -> manifest)
          in
          (match
             C.compile_with ~setup_fault:None ~hang:false ~deadline:(Unix.gettimeofday () +. 60.) tools ~source:bridge_bad ~modules:[] ~input:[]
           with
          | Error (C.Rejected _) -> ()
          | Ok _ -> fail "bridge reference was compiled"
          | Error err -> fail "bridge %s" (C.describe err));
          let compiled = fresh "compiled" in
          let manifest = compile_one compiled (step url) modules [ ("material", "bundle"); ("fetch_url", url) ] in
          note (compile_path root) "compile";
          let hash = manifest.execution_hash in
          let main = fresh "main" in
          copy_tree compiled main;
          let workers0 = lines (worker_path main) in
          let http0 = lines (http_path root) in
          spawn [ "run"; main; hash; url; "await" ];
          assert_dead main;
          if lines (compile_path root) <> 1 then fail "compile=%d" (lines (compile_path root));
          if lines (worker_path main) <> workers0 + 1 then fail "A worker=%d" (lines (worker_path main));
          if lines (http_path root) <> http0 then fail "A 出站了";
          let path = snapshot main in
          let rev0 = match S.read_snapshot path with Ok s -> s.revision | Error err -> fail "%s" (S.describe err) in
          spawn [ "approve"; main; hash; "approved" ];
          let rev1 = match S.read_snapshot path with Ok s -> s.revision | Error err -> fail "%s" (S.describe err) in
          if rev1 <= rev0 then fail "审批没有落账";
          spawn [ "approve"; main; hash; "approved" ];
          let rev2 = match S.read_snapshot path with Ok s -> s.revision | Error err -> fail "%s" (S.describe err) in
          if rev2 <> rev1 then fail "相同审批增加了 revision";
          let entry = ask path in
          (match
             S.approve_step ~path ~execution_hash:hash ~seq:entry.seq ~callback_id:"cb-step" ~expected_request_hash:"not-the-hash"
               ~decision_json:(Json.Assoc [ ("tag", Json.String "Approved") ])
           with
          | Error S.Request_changed -> ()
          | Ok () -> fail "错 hash 被接受"
          | Error err -> fail "错 hash %s" (S.describe err));
          (match
             S.approve_step ~path ~execution_hash:hash ~seq:entry.seq ~callback_id:"cb-other" ~expected_request_hash:entry.req_hash
               ~decision_json:(Json.Assoc [ ("reason", Json.String "no"); ("tag", Json.String "Rejected") ])
           with
          | Error S.Approval_conflict -> ()
          | Ok () -> fail "冲突决定被接受"
          | Error err -> fail "冲突 %s" (S.describe err));
          if lines (http_path root) <> http0 then fail "冲突审批出站";
          spawn [ "run"; main; hash; url; "validated" ];
          assert_dead main;
          if lines (worker_path main) <> workers0 + 2 then fail "B worker";
          if lines (http_path root) <> http0 + 1 then fail "B HTTP=%d" (lines (http_path root));
          if lines (compile_path root) <> 1 then fail "B 重新编译";
          Sys.remove (blob main manifest.artifact_hash);
          let http_c = lines (http_path root) in
          let worker_c = lines (worker_path main) in
          let rev_c = match S.read_snapshot path with Ok s -> s.revision | Error err -> fail "%s" (S.describe err) in
          let epoch_c = match S.read_snapshot path with Ok s -> s.epoch | Error err -> fail "%s" (S.describe err) in
          spawn [ "query"; main; hash; "validated" ];
          let snap_c = match S.read_snapshot path with Ok s -> s | Error err -> fail "%s" (S.describe err) in
          if lines (http_path root) <> http_c || lines (worker_path main) <> worker_c || lines (compile_path root) <> 1 then fail "C 改变了计数";
          if snap_c.revision <> rev_c || snap_c.epoch <> epoch_c then fail "C 改变了 revision/epoch";
          let rejected = fresh "rejected" in
          copy_tree compiled rejected;
          spawn [ "run"; rejected; hash; url; "await" ];
          assert_dead rejected;
          spawn [ "approve"; rejected; hash; "rejected" ];
          let http_r = lines (http_path root) in
          spawn [ "run"; rejected; hash; url; "rejected" ];
          assert_dead rejected;
          if lines (http_path root) <> http_r then fail "拒绝后出站";
          let check_reply name ctor text expect =
            let dir = fresh name in
            let got = compile_one dir (reply_source ctor text) [] [] in
            let http_b = lines (http_path root) in
            spawn [ "run"; dir; got.execution_hash; url; expect ];
            assert_dead dir;
            if lines (http_path root) <> http_b then fail "%s 出站" name;
            Sys.remove (blob dir got.artifact_hash);
            let workers = lines (worker_path dir) in
            spawn [ "query"; dir; got.execution_hash; expect ];
            if lines (worker_path dir) <> workers || lines (http_path root) <> http_b then fail "%s 查询启动了执行" name
          in
          check_reply "cont" "Continue" "continued" "continue";
          check_reply "ask" "Ask" "asked" "ask";
          check_reply "part" "Partial" "part" "partial";
          let pure_dir = fresh "pure" in
          let pure_manifest = compile_one pure_dir pure [] [] in
          let http_p = lines (http_path root) in
          spawn [ "run"; pure_dir; pure_manifest.execution_hash; url; "pure" ];
          assert_dead pure_dir;
          if lines (http_path root) <> http_p then fail "纯计算出站";
          let old = fresh "old" in
          let old_path = snapshot old in
          (match
             S.admit_step ~path:old_path ~run_id:"run" ~agent_version:"step-v3" ~admission_key:"old"
               {
                 Step_manifest.source = "let run () = ()\n";
                 modules = [];
                 compiler_id = manifest.compiler_id;
                 runtime_id = manifest.runtime_id;
                 sdk = "sdk";
                 driver = "exit 2";
                 artifact = "old-bytes";
                 base_workspace = "";
                 input_context = "{}";
                 capability_grant = "{}";
                 policy_version = "p0b-1";
               }
           with
          | Ok old_manifest -> (
              let epoch = match S.read_snapshot old_path with Ok s -> s.epoch | Error err -> fail "%s" (S.describe err) in
              match R.run ~path:old_path ~execution_hash:old_manifest.execution_hash ~allowed_url:url with
              | Error (R.Store S.Version_unavailable) ->
                  let epoch2 = match S.read_snapshot old_path with Ok s -> s.epoch | Error err -> fail "%s" (S.describe err) in
                  if epoch2 <> epoch then fail "旧产物领取了执行者"
              | Ok _ -> fail "旧占位产物被执行"
              | Error err -> fail "旧产物 %s" (R.describe err))
          | Error err -> fail "old admit %s" (S.describe err));
          let kill_resume name phase ~http_delta ~then_expect ~workers_delta =
            let dir = fresh name in
            copy_tree compiled dir;
            spawn [ "run"; dir; hash; url; "await" ];
            spawn [ "approve"; dir; hash; "approved" ];
            let barrier = Filename.concat dir "barrier" in
            let oc = open_out barrier in
            output_string oc phase;
            close_out oc;
            let http_b = lines (http_path root) in
            let workers_b = lines (worker_path dir) in
            spawn_kill [ "run"; dir; hash; url; "validated" ];
            if lines (http_path root) <> http_b + http_delta then
              fail "%s HTTP %d" name (lines (http_path root) - http_b);
            Unix.sleepf 0.5;
            Sys.remove barrier;
            let http_k = lines (http_path root) in
            (match then_expect with
            | `Unknown -> (
                match R.run ~path:(snapshot dir) ~execution_hash:hash ~allowed_url:url with
                | Error (R.Store S.Unknown_result) -> ()
                | Ok _ -> fail "%s 未知结果被完成" name
                | Error err -> fail "%s unknown %s" name (R.describe err))
            | `Validated -> spawn [ "run"; dir; hash; url; "validated" ]
            | `Stored -> (
                let before = lines (worker_path dir) in
                spawn [ "run"; dir; hash; url; "validated" ];
                if lines (worker_path dir) <> before then fail "%s 完成后再启动 worker" name));
            if lines (http_path root) <> http_k then fail "%s 恢复后出站" name;
            if lines (worker_path dir) - workers_b <> workers_delta then
              fail "%s worker delta %d" name (lines (worker_path dir) - workers_b)
          in
          kill_resume "disp" "after-dispatch" ~http_delta:0 ~then_expect:`Unknown ~workers_delta:1;
          kill_resume "prov" "after-provider" ~http_delta:1 ~then_expect:`Unknown ~workers_delta:1;
          kill_resume "done" "after-done" ~http_delta:1 ~then_expect:`Validated ~workers_delta:2;
          kill_resume "ret" "before-return" ~http_delta:1 ~then_expect:`Validated ~workers_delta:2;
          kill_resume "cmp" "before-complete" ~http_delta:1 ~then_expect:`Validated ~workers_delta:2;
          kill_resume "acmp" "after-complete" ~http_delta:1 ~then_expect:`Stored ~workers_delta:1;
          let short = fresh "short" in
          copy_tree compiled short;
          spawn [ "run"; short; hash; url; "await" ];
          spawn [ "approve"; short; hash; "approved" ];
          (match
             S.with_step_executor ~path:(snapshot short) ~execution_hash:hash (fun ex ->
                 S.complete_step ex ~cursor:0 ~reply:(Step_manifest.Done "no") ~workspace_hash:manifest.base_workspace_hash)
           with
          | Error S.Replay_incomplete -> ()
          | Ok _ -> fail "少消费后缀被完成"
          | Error err -> fail "短游标 %s" (S.describe err));
          (match S.read_snapshot (snapshot short) with
          | Ok snap when snap.step <> None && (match snap.step with Some r -> r.Step_manifest.state <> Step_manifest.Completed | None -> false) -> ()
          | _ -> fail "短游标写成了完成");
          let raced = fresh "race" in
          copy_tree compiled raced;
          spawn [ "run"; raced; hash; url; "await" ];
          spawn [ "approve"; raced; hash; "approved" ];
          let http_b = lines (http_path root) in
          let workers_b = lines (worker_path raced) in
          let start args =
            Unix.create_process Sys.argv.(0) (Array.of_list (Sys.argv.(0) :: args)) Unix.stdin Unix.stdout Unix.stderr
          in
          let left = start [ "run"; raced; hash; url; "validated" ] in
          let right = start [ "run"; raced; hash; url; "validated" ] in
          let code pid =
            match Unix.waitpid [] pid with
            | _, Unix.WEXITED n -> n
            | _, Unix.WSIGNALED signal -> 128 + signal
            | _, _ -> 255
          in
          let c1, c2 = (code left, code right) in
          if c1 <> 0 && c2 <> 0 then fail "双恢复都失败 %d %d" c1 c2;
          if lines (http_path root) <> http_b + 1 then fail "双恢复 HTTP=%d" (lines (http_path root) - http_b);
          if lines (worker_path raced) <> workers_b + 1 then fail "双恢复 worker=%d" (lines (worker_path raced) - workers_b);
          Printf.printf "identity policy=%s compiler=%s runtime=%s artifact=%s driver=%s\n" manifest.policy_version manifest.compiler_id
            manifest.runtime_id manifest.artifact_hash manifest.driver_hash;
          print_endline "step worker recover ok"))

let () =
  Printexc.record_backtrace true;
  match Array.to_list Sys.argv with
  | _ :: "serve" :: dir :: _ -> serve dir
  | _ :: "run" :: dir :: hash :: url :: expect :: _ -> run_mode dir hash url expect
  | _ :: "query" :: dir :: hash :: expect :: _ -> query_mode dir hash expect
  | _ :: "approve" :: dir :: hash :: "approved" :: _ -> approve_mode dir hash (Json.Assoc [ ("tag", Json.String "Approved") ])
  | _ :: "approve" :: dir :: hash :: "rejected" :: _ ->
      approve_mode dir hash (Json.Assoc [ ("reason", Json.String "no"); ("tag", Json.String "Rejected") ])
  | _ -> parent ()
