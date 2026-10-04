(** HTTPS and HTTP. The agent [perform]s [Fetch]. This handler runs curl,
    because the switch has no TLS stack. The API key stays in a 0600 config
    file, not in the process arguments. *)

open Effect.Deep
open Core.Effects
open Core.Types

let meth_name = function
  | GET -> "GET"
  | POST -> "POST"

let validate_url url =
  if url = "" then Error "空 URL"
  else if String.exists (fun c -> c = '\n' || c = '\r' || c = ' ' || c = '\t') url then
    Error "URL 里不能有空白"
  else if String.length url > 2000 then Error "URL 太长"
  else
    let lower = String.lowercase_ascii url in
    let scheme_len =
      if String.starts_with ~prefix:"https://" lower then 8
      else if String.starts_with ~prefix:"http://" lower then 7
      else 0
    in
    if scheme_len = 0 then Error "只允许 http 和 https"
    else
      let rest = String.sub url scheme_len (String.length url - scheme_len) in
      if String.contains rest '@' then Error "不允许把凭据写进 URL"
      else
        let cut_at c s = match String.index_opt s c with None -> s | Some i -> String.sub s 0 i in
        let hostport = cut_at '#' (cut_at '?' (cut_at '/' rest)) in
        let host =
          if hostport <> "" && hostport.[0] = '[' then
            match String.index_opt hostport ']' with
            | Some i -> String.sub hostport 0 (i + 1)
            | None -> hostport
          else
            match String.rindex_opt hostport ':' with
            | Some i -> String.sub hostport 0 i
            | None -> hostport
        in
        let host = String.lowercase_ascii host in
        if host = "" then Error "缺少主机"
        else if host = "169.254.169.254" || String.starts_with ~prefix:"169.254." host then
          Error "拒绝链路本地地址"
        else Ok host

let header_ok (key, value) =
  key <> ""
  && not (String.exists (fun c -> c = '\n' || c = '\r' || c = '"' || c = '\\') key)
  && not (String.exists (fun c -> c = '\n' || c = '\r' || c = '"' || c = '\\') value)

let next_id =
  let n = ref 0 in
  fun () ->
    incr n;
    !n

let write_headers path headers =
  let fd = Unix.openfile path [ Unix.O_WRONLY; Unix.O_CREAT; Unix.O_TRUNC ] 0o600 in
  let oc = Unix.out_channel_of_descr fd in
  Fun.protect ~finally:(fun () -> close_out_noerr oc) (fun () ->
      List.iter (fun (key, value) -> Printf.fprintf oc "header = \"%s: %s\"\n" key value) headers)

let split_status raw =
  let marker = "\n__OCAGENT_HTTP_" in
  let n = String.length raw and m = String.length marker in
  let rec find i =
    if i < 0 then None
    else if raw.[i] = '\n' && i + m <= n && String.sub raw i m = marker then Some i
    else find (i - 1)
  in
  match find (n - 1) with
  | None -> Error "HTTP 客户端没有返回状态"
  | Some i ->
      let body = String.sub raw 0 i in
      let code_text = String.sub raw (i + m) (n - i - m) in
      let code_text = String.trim code_text in
      (match int_of_string_opt code_text with
      | Some status -> Ok { status; body }
      | None -> Error "HTTP 状态读不出来")

let request ~mgr ?(timeout = 20.) ?(headers = []) ~meth ~url ~body () =
  match validate_url url with
  | Error _ as err -> err
  | Ok _ ->
      if not (List.for_all header_ok headers) then Error "header 不合法"
      else if String.length body > 100_000 then Error "请求体太大"
      else
        let seconds = max 1 (int_of_float timeout) in
        let header_path =
          if headers = [] then None
          else Some (Filename.concat (Filename.get_temp_dir_name ()) (Printf.sprintf "ocagent-%d-%d.hdr" (Unix.getpid ()) (next_id ())))
        in
        Fun.protect
          ~finally:(fun () ->
            match header_path with
            | None -> ()
            | Some path -> (try Sys.remove path with _ -> ()))
          (fun () ->
            (match header_path with None -> () | Some path -> write_headers path headers);
            let args =
              [ "curl"; "-sS"; "-L"; "--max-redirs"; "3"; "--max-time"; string_of_int seconds; "--proto"; "=http,https"; "--proto-redir"; "=http,https"; "--noproxy"; "localhost,127.0.0.1,::1"; "-A"; "ocagent"; "-H"; "Expect:"; "-w"; "\n__OCAGENT_HTTP_%{http_code}"; "-X"; meth_name meth ]
              @ (match header_path with None -> [] | Some path -> [ "-K"; path ])
              @ (if body = "" then [] else [ "--data-binary"; "@-" ])
              @ [ "--"; url ]
            in
            let stderr = Buffer.create 128 in
            try
              let raw =
                Eio.Process.parse_out mgr
                  ~stdin:(Eio.Flow.string_source body)
                  ~stderr:(Eio.Flow.buffer_sink stderr)
                  ~is_success:(fun _ -> true) Eio.Buf_read.take_all args
              in
              match split_status raw with
              | Error _ as err -> err
              | Ok reply when reply.status = 0 ->
                  let detail = String.trim (Buffer.contents stderr) in
                  Error (if detail = "" then "连接失败" else detail)
              | Ok reply ->
                  let limit = 200_000 in
                  if String.length reply.body <= limit then Ok reply
                  else Ok { reply with body = String.sub reply.body 0 limit }
            with exn -> Error (Printexc.to_string exn))

let with_fetch ~mgr f =
  match_with f ()
    {
      retc = (fun x -> x);
      exnc = raise;
      effc =
        (fun (type b) (eff : b Effect.t) ->
          match eff with
          | Fetch { meth; url; body } ->
              Some (fun (k : (b, _) continuation) -> continue k (request ~mgr ~meth ~url ~body ()))
          | _ -> None);
    }

let offline_reason = "评测和 dry-run 不访问网络"

let with_offline f =
  match_with f ()
    {
      retc = (fun x -> x);
      exnc = raise;
      effc =
        (fun (type b) (eff : b Effect.t) ->
          match eff with
          | Fetch _ -> Some (fun (k : (b, _) continuation) -> continue k (Error offline_reason))
          | _ -> None);
    }

let parse_fetch_args args =
  let args = String.trim args in
  if args = "" then Error "fetch 需要 URL"
  else if String.length args >= 1 && args.[0] = '{' then
    let pick key =
      let pat = "\"" ^ key ^ "\"" in
      match String.index_opt args '"' with
      | None -> None
      | Some _ ->
          let n = String.length args and pn = String.length pat in
          let rec find i =
            if i + pn > n then None
            else if String.sub args i pn = pat then
              let j = ref (i + pn) in
              while !j < n && (args.[!j] = ' ' || args.[!j] = ':') do
                incr j
              done;
              if !j < n && args.[!j] = '"' then Some !j else None
            else find (i + 1)
          in
          find 0
    in
    let read_at i =
      let buf = Buffer.create 32 in
      let n = String.length args in
      let rec loop i =
        if i >= n then None
        else
          match args.[i] with
          | '"' -> Some (Buffer.contents buf)
          | '\\' when i + 1 < n ->
              Buffer.add_char buf args.[i + 1];
              loop (i + 2)
          | c ->
              Buffer.add_char buf c;
              loop (i + 1)
      in
      loop (i + 1)
    in
    match pick "url" with
    | None -> Error "fetch 需要 url"
    | Some i -> (
        match read_at i with
        | None -> Error "fetch 的 url 读不出来"
        | Some url ->
            let meth =
              match pick "method" with
              | None -> GET
              | Some j -> (
                  match read_at j with
                  | Some meth when String.uppercase_ascii meth = "POST" -> POST
                  | _ -> GET)
            in
            let body = match pick "body" with Some j -> Option.value (read_at j) ~default:"" | None -> "" in
            Ok (meth, url, body))
  else
    match String.split_on_char '\n' args with
    | [ url ] -> Ok (GET, url, "")
    | meth :: url :: rest ->
        let meth = String.uppercase_ascii (String.trim meth) in
        if meth = "GET" || meth = "POST" then
          Ok ((if meth = "POST" then POST else GET), String.trim url, String.concat "\n" rest)
        else Ok (GET, args, "")
    | [] -> Error "fetch 需要 URL"
