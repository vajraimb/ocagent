open Effect.Deep
open Core.Effects
open Core.Types

let with_mock_llm (responses : llm_response list) f =
  let queue = ref responses in
  match_with f ()
    {
      retc = (fun x -> x);
      exnc = raise;
      effc =
        (fun (type b) (eff : b Effect.t) ->
          match eff with
          | AskLLM _ ->
              Some
                (fun (k : (b, _) continuation) ->
                  match !queue with
                  | [] -> continue k (TextResponse "（mock 响应耗尽）")
                  | head :: rest ->
                      queue := rest;
                      continue k head)
          | _ -> None);
    }

let json_string s =
  let buf = Buffer.create (String.length s + 8) in
  Buffer.add_char buf '"';
  String.iter
    (function
      | '"' -> Buffer.add_string buf "\\\""
      | '\\' -> Buffer.add_string buf "\\\\"
      | '\n' -> Buffer.add_string buf "\\n"
      | c -> Buffer.add_char buf c)
    s;
  Buffer.add_char buf '"';
  Buffer.contents buf

let role_name = function
  | System -> "system"
  | User -> "user"
  | Assistant -> "assistant"
  | ToolResult _ -> "tool"

let request_body ~model messages =
  let msgs =
    String.concat ","
      (List.map
         (fun m ->
           Printf.sprintf {|{"role":%s,"content":%s}|} (json_string (role_name m.role)) (json_string m.content))
         messages)
  in
  Printf.sprintf {|{"model":%s,"stream":false,"messages":[%s]}|} (json_string model) msgs

let decode_string s i =
  let buf = Buffer.create 16 in
  let n = String.length s in
  let rec loop i =
    if i >= n then None
    else
      match s.[i] with
      | '"' -> Some (Buffer.contents buf, i + 1)
      | '\\' when i + 1 < n ->
          (match s.[i + 1] with
          | '"' -> Buffer.add_char buf '"'
          | '\\' -> Buffer.add_char buf '\\'
          | 'n' -> Buffer.add_char buf '\n'
          | 'r' -> Buffer.add_char buf '\r'
          | 't' -> Buffer.add_char buf '\t'
          | c -> Buffer.add_char buf c);
          loop (i + 2)
      | c ->
          Buffer.add_char buf c;
          loop (i + 1)
  in
  loop i

let extract_string key s =
  let pat = "\"" ^ key ^ "\"" in
  let n = String.length s and pn = String.length pat in
  let rec find i =
    if i + pn > n then None
    else if String.sub s i pn = pat then
      let j = ref (i + pn) in
      while !j < n && (s.[!j] = ' ' || s.[!j] = '\n' || s.[!j] = ':') do
        incr j
      done;
      if !j < n && s.[!j] = '"' then
        match decode_string s (!j + 1) with
        | Some (value, next) -> Some (value, next)
        | None -> find (i + 1)
      else find (i + 1)
    else find (i + 1)
  in
  find 0

let collect key s =
  let rec loop acc rest =
    match extract_string key rest with
    | None -> List.rev acc
    | Some (value, next_index) ->
        let rest = if next_index <= String.length rest then String.sub rest next_index (String.length rest - next_index) else "" in
        loop (value :: acc) rest
  in
  loop [] s

let parse_payload s =
  match collect "arguments" s with
  | args :: _ ->
      let name = match collect "name" s with name :: _ -> name | [] -> "tool" in
      ToolCallResponse [ { id = "call"; name; args_json = args } ]
  | [] -> TextResponse (String.concat "" (collect "content" s))

let parse_body body =
  if not (String.exists (fun c -> c = 'd') body) then parse_payload body
  else if
    String.starts_with ~prefix:"data:" (String.trim body)
    || let n = String.length body in
       let rec has i =
         if i + 5 > n then false else if String.sub body i 5 = "data:" then true else has (i + 1)
       in
       has 0
  then
    let parts = String.split_on_char '\n' body in
    let chunks =
      List.filter_map
        (fun line ->
          let line = String.trim line in
          if String.starts_with ~prefix:"data:" line then
            let data = String.trim (String.sub line 5 (String.length line - 5)) in
            if data = "[DONE]" then None else Some data
          else None)
        parts
    in
    parse_payload (String.concat "\n" chunks)
  else parse_payload body

let http_post ~net ~host ~port ~path ~api_key ~body =
  let request =
    Printf.sprintf
      "POST %s HTTP/1.1\r\nHost: %s\r\nAuthorization: Bearer %s\r\nContent-Type: application/json\r\nContent-Length: %d\r\nConnection: close\r\n\r\n%s"
      path host api_key (String.length body) body
  in
  Eio.Net.with_tcp_connect ~host ~service:(string_of_int port) net (fun flow ->
      Eio.Flow.copy_string request flow;
      Eio.Buf_read.parse_exn ~max_size:1_000_000 Eio.Buf_read.take_all flow)

let split_http response =
  let marker = "\r\n\r\n" in
  let n = String.length marker in
  let rec find i =
    if i + n > String.length response then response
    else if String.sub response i n = marker then String.sub response (i + n) (String.length response - i - n)
    else find (i + 1)
  in
  find 0

let with_deepseek_http ~net ~model ~host ~port ~path ~api_key f =
  match_with f ()
    {
      retc = (fun x -> x);
      exnc = raise;
      effc =
        (fun (type b) (eff : b Effect.t) ->
          match eff with
          | AskLLM { messages; model = requested } ->
              Some
                (fun (k : (b, _) continuation) ->
                  let used = if requested = "" then model else requested in
                  let body = request_body ~model:used messages in
                  let raw = http_post ~net ~host ~port ~path ~api_key ~body in
                  continue k (parse_body (split_http raw)))
          | _ -> None);
    }

let with_https_chat ~mgr ~endpoint ~model ~api_key f =
  match_with f ()
    {
      retc = (fun x -> x);
      exnc = raise;
      effc =
        (fun (type b) (eff : b Effect.t) ->
          match eff with
          | AskLLM { messages; model = requested } ->
              Some
                (fun (k : (b, _) continuation) ->
                  let used = if requested = "" then model else requested in
                  let body = request_body ~model:used messages in
                  let reply =
                    Net.request ~mgr ~timeout:60. ~meth:POST ~url:endpoint
                      ~headers:
                        [ ("Authorization", "Bearer " ^ api_key); ("Content-Type", "application/json") ]
                      ~body ()
                  in
                  let response =
                    match reply with
                    | Error text -> TextResponse ("网络错误：" ^ text)
                    | Ok { status; _ } when status < 200 || status >= 300 ->
                        TextResponse (Printf.sprintf "HTTP %d" status)
                    | Ok { body = raw; _ } -> parse_body raw
                  in
                  continue k response)
          | _ -> None);
    }
