(** Three OS processes share only a journal file and a local HTTP counter.
    A suspends on approval and exits. The approve process writes the decision
    through [Store.commit_decision]. B loads the file and performs Fetch against
    the counter. C replays; the counter must not move. *)

module H = Ocagent_harness.Harness
module J = Ocagent_harness.Journal
module P = Ocagent_harness.Proto
module S = Ocagent_harness.Store
module W = Ocagent_harness.World
module Json = Ocagent_harness.Json

let fail fmt = Printf.ksprintf failwith fmt

let journal_path dir = Filename.concat dir "journal.jsonl"
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

let record_executes dir world =
  List.iter
    (fun (side : W.side) -> if not side.duplicate then note (effect_path dir) side.name)
    world.W.log

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
    let rec write_all off len =
      if len > 0 then
        let n = Unix.write_substring client resp off len in
        write_all (off + n) (len - n)
    in
    write_all 0 (String.length resp);
    Unix.close client;
    note (http_path dir) "hit"
  done

let worker_a dir url =
  let world = W.create () in
  let session = H.run ~profile:H.Prod ~run_id:"proc" ~world (agent url) in
  if session.result.status <> H.Suspended then fail "A 应在审批处挂起";
  let exited = session.exit_process () in
  S.save (journal_path dir) exited.result.journal;
  record_executes dir world;
  exit 0

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
  let again = S.load path in
  (match J.nth again seq with
  | Some entry when entry.status = J.Done -> ()
  | _ -> fail "审批没有落盘");
  exit 0

let run_loaded dir url =
  let world = W.create () in
  world.fetch <- Some http_get;
  let session =
    H.run ~profile:H.Prod ~run_id:"proc" ~journal:(S.load (journal_path dir)) ~world (agent url)
  in
  record_executes dir world;
  (session, world)

let worker_b dir url =
  let session, _ = run_loaded dir url in
  (match session.result.status with
  | H.Done "done" -> ()
  | H.Done text -> fail "B 结果 %s" text
  | H.Failed e -> fail "B 失败：%s" (H.describe e)
  | H.Suspended -> fail "B 仍挂起"
  | H.Crashed { seq; window } -> fail "B 崩溃 %d %s" seq window);
  S.save (journal_path dir) session.result.journal;
  exit 0

let worker_c dir url =
  let session, world = run_loaded dir url in
  (match session.result.status with
  | H.Done "done" -> ()
  | H.Failed e -> fail "C 失败：%s" (H.describe e)
  | _ -> fail "C 没有完成");
  if world.log <> [] then fail "C 又执行了 world";
  if world.sandbox_execs <> 0 then fail "C 又进了沙箱";
  exit 0

let worker_uncertain dir =
  let path = journal_path dir in
  let journal = S.load path in
  (match List.find_opt (fun entry -> entry.J.kind = "Fetch") !(journal.entries) with
  | None -> fail "没有 Fetch 记录"
  | Some entry ->
      entry.status <- J.Pending;
      entry.idempotent <- false;
      entry.result <- Json.Null);
  S.save path journal;
  ignore (S.refuse_uncertain path);
  (match List.find_opt (fun entry -> entry.J.kind = "Fetch") !((S.load path).J.entries) with
  | Some entry when entry.status = J.Unknown -> ()
  | _ -> fail "非幂等 Pending 应标成 Unknown");
  exit 0

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
      spawn [ "uncertain"; dir ];
      let world = W.create () in
      world.fetch <- Some http_get;
      let refused =
        H.run ~profile:H.Prod ~run_id:"proc" ~journal:(S.load (journal_path dir)) ~world (agent url)
      in
      (match refused.result.status with
      | H.Failed (H.Harness msg) when P.contains msg "结果未知" -> ()
      | H.Failed e -> fail "Unknown 恢复：%s" (H.describe e)
      | _ -> fail "非幂等 Pending 被重做了");
      if count_lines (http_path dir) <> 1 then fail "拒绝重做之后 HTTP 又增加了";
      let good = S.load (journal_path dir) in
      let tmp = journal_path dir ^ ".tmp" in
      let oc = open_out tmp in
      output_string oc "{";
      close_out oc;
      ignore (S.load (journal_path dir));
      Sys.remove tmp;
      if J.slim good <> J.slim (S.load (journal_path dir)) then fail "未改名的半截文件覆盖了日志");
  print_endline "process recover ok"

let () =
  Printexc.record_backtrace true;
  match Array.to_list Sys.argv with
  | _ :: "serve" :: dir :: _ -> serve dir
  | _ :: "a" :: dir :: url :: _ -> worker_a dir url
  | _ :: "approve" :: dir :: _ -> worker_approve dir
  | _ :: "b" :: dir :: url :: _ -> worker_b dir url
  | _ :: "c" :: dir :: url :: _ -> worker_c dir url
  | _ :: "stale" :: dir :: _ -> worker_stale dir
  | _ :: "uncertain" :: dir :: _ -> worker_uncertain dir
  | _ -> parent ()
