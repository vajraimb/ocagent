(** Fetch and web search. Policy and parsers stay offline. Loopback proves curl. *)

open Core.Types

let fail fmt = Printf.ksprintf failwith fmt

let check name cond =
  if not cond then fail "FAIL %s" name

let contains s sub =
  let n = String.length s and m = String.length sub in
  let rec loop i =
    if i + m > n then false else if String.sub s i m = sub then true else loop (i + 1)
  in
  loop 0

let test_policy () =
  let ok url = match Harness.Net.validate_url url with Ok _ -> true | Error _ -> false in
  let err url = match Harness.Net.validate_url url with Error _ -> true | Ok _ -> false in
  check "https" (ok "https://ocaml.org/docs");
  check "loop" (ok "http://127.0.0.1:9/x");
  check "file" (err "file:///etc/passwd");
  check "cred" (err "https://user:secret@example.com/");
  check "meta" (err "http://169.254.169.254/latest");
  check "space" (err "https://example.com/a b");
  check "empty" (err "")

let fixture =
  {|{"output":[{"type":"web_search_call","action":{"query":"ocaml","sources":[{"type":"url","url":"https://ocaml.org/"},{"type":"url","url":"https://ocaml.org/"},{"type":"url","url":"https://en.wikipedia.org/wiki/OCaml"}]}},{"type":"message","content":[{"type":"output_text","text":"OCaml is a functional language."}]}]}|}

let test_parse () =
  let answer = Harness.Search.parse fixture ~limit:5 in
  check "text" (answer.text = "OCaml is a functional language.");
  check "two hits" (List.length answer.hits = 2);
  check "first" ((List.hd answer.hits).url = "https://ocaml.org/");
  check "render" (contains (Harness.Search.render answer) "https://ocaml.org/");
  check "query json" (Harness.Search.parse_query {|{"query":"eio"}|} = Ok "eio");
  check "query raw" (Harness.Search.parse_query "eio" = Ok "eio");
  (match Harness.Net.parse_fetch_args {|{"url":"https://ocaml.org/","method":"POST","body":"hi"}|} with
  | Ok (POST, "https://ocaml.org/", "hi") -> ()
  | _ -> fail "json fetch");
  match Harness.Net.parse_fetch_args "https://example.com/a" with
  | Ok (GET, "https://example.com/a", "") -> ()
  | _ -> fail "bare fetch"

let test_offline () =
  let blocked =
    Harness.Net.with_offline (fun () ->
        Effect.perform (Core.Effects.Fetch { meth = GET; url = "https://example.com"; body = "" }))
  in
  check "fetch offline" (blocked = Error Harness.Net.offline_reason);
  let search =
    Harness.Search.with_offline (fun () ->
        Effect.perform (Core.Effects.Web_search { query = "ocaml"; limit = 3 }))
  in
  check "search offline" (search = Error Harness.Net.offline_reason);
  let fs = Harness.Sandbox.mock_fs (Harness.Sandbox.empty_mock ()) in
  let via_tool =
    Harness.Search.with_scripted
      (Ok { text = "找到了"; hits = [ { title = "ocaml.org"; url = "https://ocaml.org/"; snippet = "" } ] })
      (fun () ->
        Harness.Sandbox.with_tools ~fs (fun () ->
            Effect.perform (Core.Effects.CallTool { name = "search"; args_json = "ocaml" })))
  in
  match via_tool with
  | Ok text ->
      check "tool answer" (contains text "找到了");
      check "tool url" (contains text "https://ocaml.org/")
  | Error text -> fail "tool %s" text

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
  | None -> 0

let read_request flow =
  let reader = Eio.Buf_read.of_flow ~max_size:1_000_000 flow in
  let request = Eio.Buf_read.line reader in
  let rec headers acc =
    match Eio.Buf_read.line reader with
    | "" -> List.rev acc
    | line -> headers (line :: acc)
  in
  let headers = headers [] in
  let body =
    let n = content_length headers in
    if n = 0 then "" else Eio.Buf_read.take n reader
  in
  (request, headers, body)

let write_response flow body =
  let response =
    Printf.sprintf "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: %d\r\nConnection: close\r\n\r\n%s"
      (String.length body) body
  in
  Eio.Flow.copy_string response flow;
  Eio.Flow.shutdown flow `All

let test_loopback env =
  Eio.Switch.run @@ fun sw ->
  let net = Eio.Stdenv.net env in
  let sock = Eio.Net.listen ~sw ~backlog:4 ~reuse_addr:true net (`Tcp (Eio.Net.Ipaddr.V4.loopback, 0)) in
  let port =
    match Eio.Net.listening_addr sock with
    | `Tcp (_, port) -> port
    | `Unix _ -> fail "expected tcp"
  in
  let serve ~auth expected =
    let flow, _addr = Eio.Net.accept ~sw sock in
    let request, headers, body = read_request flow in
    if not (contains request expected) then fail "%s request = %S headers = %s" expected request (String.concat " | " headers);
    check "auth" ((not auth) || List.mem "Authorization: Bearer test-key" headers);
    check "saw ping" (contains body "ping");
    write_response flow {|{"choices":[{"message":{"content":"hello"}}]}|}
  in
  let mgr = Eio.Stdenv.process_mgr env in
  let url = Printf.sprintf "http://127.0.0.1:%d/chat/completions" port in
  let chat () =
    Harness.Llm_provider.with_https_chat ~mgr ~endpoint:url ~model:"grok-4.7" ~api_key:"test-key" (fun () ->
        Effect.perform
          (Core.Effects.AskLLM { messages = [ { role = User; content = "ping" } ]; model = "" }))
  in
  let fetch () =
    Harness.Net.with_fetch ~mgr (fun () ->
        Effect.perform
          (Core.Effects.Fetch
             { meth = POST; url; body = {|{"messages":[{"content":"ping"}],"stream":false}|} }))
  in
  let chat_answer = ref None in
  Eio.Fiber.both (fun () -> serve ~auth:true "POST") (fun () -> chat_answer := Some (chat ()));
  (match !chat_answer with
  | Some (TextResponse "hello") -> ()
  | Some (TextResponse text) -> fail "chat %s" text
  | Some (ToolCallResponse _) -> fail "chat tool"
  | None -> fail "chat missing");
  let fetch_answer = ref None in
  Eio.Fiber.both (fun () -> serve ~auth:false "POST") (fun () -> fetch_answer := Some (fetch ()));
  match !fetch_answer with
  | Some (Ok { status = 200; body }) -> check "fetch body" (contains body "hello")
  | Some (Ok { status; _ }) -> fail "fetch status %d" status
  | Some (Error text) -> fail "fetch %s" text
  | None -> fail "fetch missing"

let () =
  test_policy ();
  test_parse ();
  test_offline ();
  Eio_main.run test_loopback;
  print_endline "net ok"
