(** Three OS processes share only a journal file and a local HTTP counter.
    A suspends on approval and exits. The approve process writes the decision
    through [Store.commit_decision]. B loads the file and performs Fetch against
    the counter. C replays; the counter must not move. *)

module D = Ocagent_harness.Durable
module J = Ocagent_harness.Journal
module P = Ocagent_harness.Proto
module S = Ocagent_harness.Store
module Json = Ocagent_harness.Json

let fail fmt = Printf.ksprintf failwith fmt

let journal_path dir = Filename.concat dir "snapshot.json"
let port_path dir = Filename.concat dir "port"
let http_path dir = Filename.concat dir "http.count"
let effect_path dir = Filename.concat dir "effects.log"

let count_lines path =
  if not (Sys.file_exists path) then 0
  else
    let text = In_channel.with_open_bin path In_channel.input_all in
    let n = ref 0 in
    String.iter (fun c -> if c = '\n' then incr n) text;
    !n

let note path name =
  let oc = open_out_gen [ Open_append; Open_creat ] 0o644 path in
  Fun.protect ~finally:(fun () -> close_out oc) (fun () -> output_string oc (name ^ "\n"))

let http_get (req : P.fetch_request) =
  let url = req.url in
  let rest = String.sub url 7 (String.length url - 7) in
  let colon = String.index rest ':' in
  let slash = String.index rest '/' in
  let port = int_of_string (String.sub rest (colon + 1) (slash - colon - 1)) in
  let path = String.sub rest slash (String.length rest - slash) in
  let sock = Unix.socket Unix.PF_INET Unix.SOCK_STREAM 0 in
  Fun.protect
    ~finally:(fun () -> Unix.close sock)
    (fun () ->
      Unix.connect sock (Unix.ADDR_INET (Unix.inet_addr_loopback, port));
      let req =
        Printf.sprintf "GET %s HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n" path
      in
      ignore (Unix.write_substring sock req 0 (String.length req));
      let buf = Buffer.create 128 in
      let tmp = Bytes.create 512 in
      let rec read () =
        match Unix.read sock tmp 0 512 with
        | 0 -> ()
        | n ->
            Buffer.add_subbytes buf tmp 0 n;
            read ()
        | exception Unix.Unix_error (Unix.ECONNRESET, _, _) -> ()
      in
      read ();
      let raw = Buffer.contents buf in
      let marker = "\r\n\r\n" in
      let body =
        match String.index_opt raw '\r' with
        | None -> raw
        | Some _ ->
            let rec find i =
              if i + 4 > String.length raw then raw
              else if String.sub raw i 4 = marker then String.sub raw (i + 4) (String.length raw - i - 4)
              else find (i + 1)
            in
            find 0
      in
      { P.status = 200; body })

let agent url () =
  let _ =
    Effect.perform
      (P.Llm { purpose = "plan"; messages = [ { role = "user"; content = "stable" } ] })
  in
  let decision =
    Effect.perform
      (P.Ask_human { action = "fetch"; risk = `High; payload = Json.String "v1" })
  in
  match decision with
  | P.Rejected reason -> "no:" ^ reason
  | P.Approved ->
      let page = Effect.perform (P.Fetch { url }) in
      if page.status = 200 && P.contains page.body "spec-body" then "done" else "bad:" ^ page.body

let serve dir =
  let sock = Unix.socket Unix.PF_INET Unix.SOCK_STREAM 0 in
  Unix.setsockopt sock Unix.SO_REUSEADDR true;
  Unix.bind sock (Unix.ADDR_INET (Unix.inet_addr_loopback, 0));
  Unix.listen sock 32;
  let port =
    match Unix.getsockname sock with
    | Unix.ADDR_INET (_, port) -> port
    | _ -> fail "没有端口"
  in
  let oc = open_out (port_path dir) in
  output_string oc (string_of_int port);
  close_out oc;
  let body = "spec-body" in
  let resp =
    Printf.sprintf "HTTP/1.1 200 OK\r\nContent-Length: %d\r\nConnection: close\r\n\r\n%s"
      (String.length body) body
  in
  while true do
    let client, _ = Unix.accept sock in
    let tmp = Bytes.create 1024 in
    let (_ : int) = Unix.read client tmp 0 1024 in
    note (http_path dir) "hit";
    let rec write_all off len =
      if len > 0 then
        let n = Unix.write_substring client resp off len in
        write_all (off + n) (len - n)
    in
    write_all 0 (String.length resp);
    Unix.close client
  done

let worker_a dir url =
  match D.run ~dir ~fetch:http_get (agent url) with
  | D.Suspended -> exit 0
  | D.Finished text -> fail "A 不应完成：%s" text
  | D.Blocked msg -> fail "A 被阻塞：%s" msg

let ask_seq journal =
  match
    List.find_opt
      (fun entry -> entry.J.kind = "Ask_human" && entry.status = J.Pending)
      !(journal.J.entries)
  with
  | Some entry -> entry.seq
  | None -> fail "没有挂起的审批"

let worker_approve dir =
  let path = journal_path dir in
  let seq = ask_seq (S.load path) in
  let decision = P.decision_json P.Approved in
  (match S.commit_decision path seq decision with
  | Ok () -> ()
  | Error msg -> fail "审批写入失败：%s" msg);
  (match S.commit_decision path seq decision with
  | Ok () -> ()
  | Error msg -> fail "重复审批应被接受为同一次：%s" msg);
  (match S.commit_decision path seq (P.decision_json (P.Rejected "no")) with
  | Error _ -> ()
  | Ok () -> fail "冲突的审批决定被接受了");
  (match S.commit_decision path 0 decision with
  | Error _ -> ()
  | Ok () -> fail "非审批记录被批准了");
  (match J.nth (S.load path) seq with
  | Some entry when entry.status = J.Done -> ()
  | _ -> fail "审批没有落盘");
  exit 0

let worker_b dir url =
  match D.run ~dir ~fetch:http_get (agent url) with
  | D.Finished "done" -> exit 0
  | D.Finished text -> fail "B 结果 %s" text
  | D.Suspended -> fail "B 仍挂起"
  | D.Blocked msg -> fail "B 被阻塞：%s" msg

let worker_c dir url =
  match D.run ~dir ~fetch:http_get (agent url) with
  | D.Finished "done" -> exit 0
  | D.Blocked msg -> fail "C 被阻塞：%s" msg
  | D.Suspended -> fail "C 仍挂起"
  | D.Finished text -> fail "C 结果 %s" text

let worker_resume dir url =
  match D.run ~dir ~fetch:http_get (agent url) with
  | D.Blocked msg when P.contains msg "结果未知" -> exit 0
  | D.Blocked msg -> fail "恢复没有停在未知：%s" msg
  | D.Finished _ -> fail "未知结果被重做并完成了"
  | D.Suspended -> fail "未知结果变成了挂起"

let worker_stale dir =
  let path = journal_path dir in
  let journal = S.load path in
  let entry =
    match List.find_opt (fun e -> e.J.kind = "Ask_human") !(journal.entries) with
    | Some entry -> entry
    | None -> fail "没有审批"
  in
  entry.attempt <- 2;
  entry.status <- J.Pending;
  S.save path journal;
  (match S.commit_result path entry.seq ~attempt:1 (Json.String "late") with
  | Error _ -> ()
  | Ok () -> fail "旧 attempt 写进了日志");
  (match J.nth (S.load path) entry.seq with
  | Some kept when kept.status = J.Pending && kept.result = Json.Null -> ()
  | _ -> fail "旧 attempt 改动了记录");
  exit 0

let spawn args =
  let pid =
    Unix.create_process Sys.argv.(0) (Array.of_list (Sys.argv.(0) :: args)) Unix.stdin Unix.stdout Unix.stderr
  in
  match Unix.waitpid [] pid with
  | _, Unix.WEXITED 0 -> ()
  | _, Unix.WEXITED code -> fail "子进程退出 %d (%s)" code (String.concat " " args)
  | _, _ -> fail "子进程被信号结束"

let spawn_kill args =
  let pid =
    Unix.create_process Sys.argv.(0) (Array.of_list (Sys.argv.(0) :: args)) Unix.stdin Unix.stdout Unix.stderr
  in
  match Unix.waitpid [] pid with
  | _, Unix.WSIGNALED _ -> ()
  | _, Unix.WEXITED code -> fail "应被 SIGKILL，实际退出 %d" code
  | _, _ -> fail "子进程没有被 SIGKILL"

let wait_port dir =
  let rec loop n =
    if n = 0 then fail "HTTP 计数服务没有起来"
    else if Sys.file_exists (port_path dir) then int_of_string (In_channel.with_open_text (port_path dir) In_channel.input_all)
    else (
      Unix.sleepf 0.05;
      loop (n - 1))
  in
  loop 100

let effects_of dir name =
  if not (Sys.file_exists (effect_path dir)) then 0
  else
    let text = In_channel.with_open_bin (effect_path dir) In_channel.input_all in
    let lines = String.split_on_char '\n' text in
    List.length (List.filter (fun line -> line = name) lines)

let parent () =
  let dir = Filename.concat (Filename.get_temp_dir_name ()) ("ocagent-proc-" ^ string_of_int (Unix.getpid ())) in
  Unix.mkdir dir 0o755;
  let server =
    Unix.create_process Sys.argv.(0) [| Sys.argv.(0); "serve"; dir |] Unix.stdin Unix.stdout Unix.stderr
  in
  Fun.protect
    ~finally:(fun () ->
      (try Unix.kill server Sys.sigterm with
      | Unix.Unix_error _ -> ());
      ignore (Unix.waitpid [] server))
    (fun () ->
      let port = wait_port dir in
      let url = Printf.sprintf "http://127.0.0.1:%d/spec" port in
      spawn [ "a"; dir; url ];
      if effects_of dir "Llm" <> 1 || effects_of dir "Fetch" <> 0 then fail "A 的执行计数不对";
      spawn [ "stale"; dir ];
      spawn [ "approve"; dir ];
      spawn [ "b"; dir; url ];
      if count_lines (http_path dir) <> 1 then fail "B 之后 HTTP 计数不是 1";
      if effects_of dir "Fetch" <> 1 then fail "Fetch 执行计数不是 1";
      let llm_after_b = effects_of dir "Llm" in
      spawn [ "c"; dir; url ];
      if count_lines (http_path dir) <> 1 then fail "C 又请求了 HTTP";
      if effects_of dir "Llm" <> llm_after_b then fail "C 又执行了 Llm";
      if effects_of dir "Fetch" <> 1 then fail "C 又执行了 Fetch";
      let half = journal_path dir ^ ".half.tmp" in
      let oc = open_out half in
      output_string oc "{";
      close_out oc;
      ignore (S.load (journal_path dir));
      Sys.remove half;
      let kill_dir = Filename.concat dir "kill" in
      Unix.mkdir kill_dir 0o755;
      spawn [ "a"; kill_dir; url ];
      spawn [ "approve"; kill_dir ];
      let barrier = Filename.concat kill_dir "barrier" in
      let oc = open_out barrier in
      output_string oc "after-provider";
      close_out oc;
      let before = count_lines (http_path dir) in
      spawn_kill [ "b"; kill_dir; url ];
      if count_lines (http_path dir) <> before + 1 then fail "SIGKILL 前 fixture 应已计数";
      Sys.remove barrier;
      spawn [ "resume"; kill_dir; url ];
      if count_lines (http_path dir) <> before + 1 then fail "Unknown 之后又请求了 HTTP";
      let oc = open_out (journal_path kill_dir) in
      output_string oc "OCAGENT 1\nrevision 1\nrecords 0\nchecksum 00000000\n";
      close_out oc;
      match S.load (journal_path kill_dir) with
      | _ -> fail "损坏的快照被读入了"
      | exception S.Corrupt _ -> ());
  print_endline "process recover ok"

let () =
  Printexc.record_backtrace true;
  match Array.to_list Sys.argv with
  | _ :: "serve" :: dir :: _ -> serve dir
  | _ :: "a" :: dir :: url :: _ -> worker_a dir url
  | _ :: "approve" :: dir :: _ -> worker_approve dir
  | _ :: "b" :: dir :: url :: _ -> worker_b dir url
  | _ :: "c" :: dir :: url :: _ -> worker_c dir url
  | _ :: "resume" :: dir :: url :: _ -> worker_resume dir url
  | _ :: "stale" :: dir :: _ -> worker_stale dir
  | _ -> parent ()
