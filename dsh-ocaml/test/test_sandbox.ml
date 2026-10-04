(** Capability sandbox: path policy, Eio subtree, and a loopback HTTP parse. *)

open Core.Types

let fail fmt = Printf.ksprintf failwith fmt

let check name cond =
  if not cond then fail "FAIL %s" name

let test_policy () =
  let open Harness.Sandbox in
  check "rel" (safe_relative "note.txt" = Ok "note.txt");
  check "nested" (safe_relative "a/b.txt" = Ok "a/b.txt");
  check "abs" (safe_relative "/etc/passwd" = Error "path escape");
  check "dot" (safe_relative "../note.txt" = Error "path escape");
  check "empty" (safe_relative "" = Error "path escape");
  check "dot-seg" (safe_relative "a/../../b" = Error "path escape");
  check "cmd-ok" (not (escapes "echo hello"));
  check "cmd-dot" (escapes "cat ../note.txt");
  check "cmd-abs" (escapes "cat /etc/passwd")

let test_tree env =
  let fs = Eio.Stdenv.fs env in
  let work = Eio.Path.(fs / "/tmp/dsh-ocaml-sandbox") in
  Eio.Path.mkdirs ~perm:0o700 ~exists_ok:true work;
  Eio.Path.with_subtree work (fun root ->
      Eio.Path.save ~create:(`Or_truncate 0o644) Eio.Path.(root / "note.txt") "inside";
      check "load" (Eio.Path.load Eio.Path.(root / "note.txt") = "inside");
      let blocked =
        try
          ignore (Eio.Path.load Eio.Path.(root / ".." / "note.txt"));
          false
        with _ -> true
      in
      check "subtree .." blocked;
      let files = Harness.Sandbox.eio_fs root in
      check "fs read" (files.read "note.txt" = Ok "inside");
      check "fs abs" (files.read "/etc/passwd" = Error "path escape");
      check "fs dot" (files.read "../note.txt" = Error "path escape");
      check "fs write" (files.write "out.txt\nxyz" = Ok "wrote out.txt");
      check "fs wrote" (files.read "out.txt" = Ok "xyz");
      let clock = Eio.Stdenv.clock env in
      let mgr = Eio.Stdenv.process_mgr env in
      let exec cmd =
        Harness.Trajectory.with_trajectory ~on_event:(fun _ -> ()) (fun () ->
            Harness.Sandbox.with_eio_sandbox ~clock ~cwd:root ~mgr (fun () ->
                Effect.perform (Core.Effects.SandboxExec { cmd; timeout_sec = 2. })))
      in
      (match exec "echo hello" with
      | Ok text -> check "echo" (String.trim text = "hello")
      | Error text -> fail "echo failed: %s" text);
      (match exec "cat ../note.txt" with
      | Error "path escape" -> ()
      | Ok text -> fail "dotdot escaped: %s" text
      | Error text -> fail "dotdot: %s" text);
      match exec "cat /etc/passwd" with
      | Error "path escape" -> ()
      | Ok text -> fail "abs escaped: %s" (String.sub text 0 (min 40 (String.length text)))
      | Error text -> fail "abs: %s" text)

let content_length headers =
  match
    List.find_map
      (fun line ->
        let key = "Content-Length:" in
        if String.starts_with ~prefix:key line then
          Some (int_of_string (String.trim (String.sub line (String.length key) (String.length line - String.length key))))
        else None)
      headers
  with
  | Some n -> n
  | None -> fail "no content-length"

let read_request flow =
  let reader = Eio.Buf_read.of_flow ~max_size:1_000_000 flow in
  let request = Eio.Buf_read.line reader in
  let rec headers acc =
    match Eio.Buf_read.line reader with
    | "" -> List.rev acc
    | line -> headers (line :: acc)
  in
  let headers = headers [] in
  let body = Eio.Buf_read.take (content_length headers) reader in
  (request, headers, body)

let test_http env =
  Eio.Switch.run @@ fun sw ->
  let net = Eio.Stdenv.net env in
  let sock =
    Eio.Net.listen ~sw ~backlog:1 ~reuse_addr:true net
      (`Tcp (Eio.Net.Ipaddr.V4.loopback, 0))
  in
  let port =
    match Eio.Net.listening_addr sock with
    | `Tcp (_, port) -> port
    | `Unix _ -> fail "expected tcp"
  in
  let serve () =
    let flow, _addr = Eio.Net.accept ~sw sock in
    let request, headers, body = read_request flow in
    check "post" (request = "POST /chat/completions HTTP/1.1");
    check "auth" (List.mem "Authorization: Bearer test-key" headers);
    check "saw prompt" (let n = String.length body in
                        let rec has i =
                          if i + 4 > n then false
                          else if String.sub body i 4 = "ping" then true
                          else has (i + 1)
                        in
                        has 0);
    check "saw stream" (let n = String.length body in
                        let needle = "\"stream\":false" in
                        let m = String.length needle in
                        let rec has i =
                          if i + m > n then false else if String.sub body i m = needle then true else has (i + 1)
                        in
                        has 0);
    let payload =
      String.concat "\n"
        [
          "data: {\"choices\":[{\"delta\":{\"content\":\"he\"}}]}";
          "data: {\"choices\":[{\"delta\":{\"content\":\"llo\"}}]}";
          "data: [DONE]";
          "";
        ]
    in
    let response =
      Printf.sprintf "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: %d\r\nConnection: close\r\n\r\n%s"
        (String.length payload) payload
    in
    Eio.Flow.copy_string response flow;
    Eio.Flow.shutdown flow `All
  in
  let ask () =
    Harness.Llm_provider.with_deepseek_http ~net ~model:"deepseek-v4" ~host:"127.0.0.1" ~port
      ~path:"/chat/completions" ~api_key:"test-key" (fun () ->
        Effect.perform
          (Core.Effects.AskLLM
             { messages = [ { role = User; content = "ping" } ]; model = "deepseek-v4" }))
  in
  let answer = ref None in
  Eio.Fiber.both serve (fun () -> answer := Some (ask ()));
  match !answer with
  | Some (TextResponse "hello") -> ()
  | Some (TextResponse text) -> fail "http text %s" text
  | Some (ToolCallResponse _) -> fail "http tool"
  | None -> fail "http no answer"

let () =
  test_policy ();
  Eio_main.run @@ fun env ->
  test_tree env;
  test_http env;
  print_endline "sandbox ok"
