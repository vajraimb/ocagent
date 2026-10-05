(** Length-prefixed canonical JSON for one step worker. The same source is
    compiled into the saved bytecode and into the harness. *)

let version = 1
let max_frame = 262144
let max_depth = 32

type limits = { timeout_s : int; as_bytes : int; log_bytes : int; tmp_bytes : int }

let worker_limits = { timeout_s = 20; as_bytes = 268435456; log_bytes = 1048576; tmp_bytes = 1048576 }

type reply =
  | Continue of string
  | Done of string
  | Ask of string
  | Partial of string

type net_result =
  | Http of { status : int; body : string }
  | Rejected of string
  | Denied of string

type frame =
  | Init of { version : int; execution_hash : string; bound_input : (string * string) list; limits : limits }
  | Ready of { version : int }
  | Call of { version : int; request_id : int; method_ : string; url : string }
  | Return of { version : int; request_id : int; result : net_result }
  | Trace of { version : int; message : string }
  | Stop of { version : int; code : string }
  | Finished of { version : int; reply : reply }

type json =
  | Null
  | Bool of bool
  | Int of int
  | String of string
  | List of json list
  | Obj of (string * json) list

let utf8_ok s =
  let n = String.length s in
  let rec go i =
    if i >= n then true
    else
      let c = Char.code s.[i] in
      if c <= 0x7F then go (i + 1)
      else
        let need, min_cp =
          if c land 0xE0 = 0xC0 then (2, 0x80)
          else if c land 0xF0 = 0xE0 then (3, 0x800)
          else if c land 0xF8 = 0xF0 then (4, 0x10000)
          else (0, 0)
        in
        if need = 0 || i + need > n then false
        else
          let rec cont j acc =
            if j = i + need then if acc < min_cp || acc > 0x10FFFF || (acc >= 0xD800 && acc <= 0xDFFF) then false else go j
            else
              let d = Char.code s.[j] in
              if d land 0xC0 <> 0x80 then false else cont (j + 1) ((acc lsl 6) lor (d land 0x3F))
          in
          let first = c land ((1 lsl (8 - need)) - 1) in
          cont (i + 1) first
  in
  go 0

let escape s =
  let buf = Buffer.create (String.length s + 8) in
  String.iter
    (fun c ->
      match c with
      | '"' -> Buffer.add_string buf "\\\""
      | '\\' -> Buffer.add_string buf "\\\\"
      | '\n' -> Buffer.add_string buf "\\n"
      | '\r' -> Buffer.add_string buf "\\r"
      | '\t' -> Buffer.add_string buf "\\t"
      | c when Char.code c < 32 -> Buffer.add_string buf (Printf.sprintf "\\u%04x" (Char.code c))
      | c -> Buffer.add_char buf c)
    s;
  Buffer.contents buf

let rec encode = function
  | Null -> "null"
  | Bool true -> "true"
  | Bool false -> "false"
  | Int n -> string_of_int n
  | String s -> "\"" ^ escape s ^ "\""
  | List xs -> "[" ^ String.concat "," (List.map encode xs) ^ "]"
  | Obj fields ->
      let fields = List.sort (fun (a, _) (b, _) -> String.compare a b) fields in
      let body = String.concat "," (List.map (fun (k, v) -> encode (String k) ^ ":" ^ encode v) fields) in
      "{" ^ body ^ "}"

type parser = { s : string; mutable i : int }

let fail msg = Error msg

let parse text =
  let n = String.length text in
  let p = { s = text; i = 0 } in
  let peek () = if p.i >= n then '\000' else p.s.[p.i] in
  let bump () = p.i <- p.i + 1 in
  let ws () = () in
  let rec parse_value depth () =
    if depth > max_depth then fail "depth"
    else (
      ws ();
      match peek () with
      | 'n' ->
          if p.i + 4 > n || String.sub text p.i 4 <> "null" then fail "null" else (p.i <- p.i + 4; Ok Null)
      | 't' ->
          if p.i + 4 > n || String.sub text p.i 4 <> "true" then fail "bool" else (p.i <- p.i + 4; Ok (Bool true))
      | 'f' ->
          if p.i + 5 > n || String.sub text p.i 5 <> "false" then fail "bool" else (p.i <- p.i + 5; Ok (Bool false))
      | '"' -> parse_string ()
      | '[' -> parse_array depth ()
      | '{' -> parse_object depth ()
      | '0' .. '9' -> parse_number ()
      | _ -> fail "value")
  and parse_string () =
    bump ();
    let buf = Buffer.create 16 in
    let rec loop () =
      if p.i >= n then fail "string"
      else
        match text.[p.i] with
        | '"' ->
            bump ();
            let s = Buffer.contents buf in
            if utf8_ok s then Ok (String s) else fail "utf8"
        | '\\' -> (
            bump ();
            if p.i >= n then fail "escape"
            else
              match text.[p.i] with
              | '"' -> Buffer.add_char buf '"'; bump (); loop ()
              | '\\' -> Buffer.add_char buf '\\'; bump (); loop ()
              | '/' -> Buffer.add_char buf '/'; bump (); loop ()
              | 'n' -> Buffer.add_char buf '\n'; bump (); loop ()
              | 'r' -> Buffer.add_char buf '\r'; bump (); loop ()
              | 't' -> Buffer.add_char buf '\t'; bump (); loop ()
              | 'u' ->
                  if p.i + 4 >= n then fail "escape"
                  else
                    let hex = String.sub text (p.i + 1) 4 in
                    (match int_of_string_opt ("0x" ^ hex) with
                    | None -> fail "escape"
                    | Some code when code >= 0 && code <= 255 ->
                        Buffer.add_char buf (Char.chr code);
                        p.i <- p.i + 5;
                        loop ()
                    | Some _ -> fail "escape")
              | _ -> fail "escape")
        | c when Char.code c < 32 -> fail "control"
        | c ->
            Buffer.add_char buf c;
            bump ();
            loop ()
    in
    loop ()
  and parse_number () =
    let start = p.i in
    let rec digits () =
      match peek () with
      | '0' .. '9' -> bump (); digits ()
      | _ -> ()
    in
    digits ();
    let raw = String.sub text start (p.i - start) in
    if raw = "" || (String.length raw > 1 && raw.[0] = '0') || String.contains raw '.' || String.contains raw 'e' then fail "number"
    else
      match int_of_string_opt raw with
      | Some n when n >= 0 -> Ok (Int n)
      | _ -> fail "number"
  and parse_array depth () =
    bump ();
    ws ();
    if peek () = ']' then (bump (); Ok (List []))
    else
      let rec items acc =
        match parse_value (depth + 1) () with
        | Error _ as e -> e
        | Ok item -> (
            ws ();
            match peek () with
            | ',' -> bump (); items (item :: acc)
            | ']' -> bump (); Ok (List (List.rev (item :: acc)))
            | _ -> fail "array")
      in
      items []
  and parse_object depth () =
    bump ();
    ws ();
    if peek () = '}' then (bump (); Ok (Obj []))
    else
      let rec fields acc =
        ws ();
        match parse_string () with
        | Error _ as e -> e
        | Ok (String key) ->
            let ordered = match acc with (prev, _) :: _ -> String.compare prev key < 0 | [] -> true in
            if not ordered then fail "order"
            else if List.exists (fun (k, _) -> k = key) acc then fail "duplicate"
            else (
              ws ();
              if peek () <> ':' then fail "object"
              else (
                bump ();
                match parse_value (depth + 1) () with
                | Error _ as e -> e
                | Ok value -> (
                    ws ();
                    match peek () with
                    | ',' -> bump (); fields ((key, value) :: acc)
                    | '}' -> bump (); Ok (Obj (List.rev ((key, value) :: acc)))
                    | _ -> fail "object")))
        | Ok _ -> fail "key"
      in
      fields []
  in
  match parse_value 1 () with
  | Error _ as e -> e
  | Ok json ->
      ws ();
      if p.i <> n then fail "trailer" else Ok json

let field (fields : (string * json) list) (name : string) : (json, string) result =
  match List.assoc_opt name fields with
  | Some value -> Ok value
  | None -> fail ("missing " ^ name)

let exact fields names =
  let got = List.map fst fields |> List.sort String.compare in
  let expect = List.sort String.compare names in
  if got = expect then Ok () else fail "fields"

let as_string = function
  | String s -> Ok s
  | _ -> fail "type"

let as_int = function
  | Int n -> Ok n
  | _ -> fail "type"

let input_of = function
  | Obj fields ->
      let rec take acc = function
        | [] -> Ok (List.rev acc)
        | (key, value) :: rest -> (
            match as_string value with
            | Error _ as e -> e
            | Ok value -> take ((key, value) :: acc) rest)
      in
      take [] fields
  | _ -> fail "input"

let limits_of = function
  | Obj fields -> (
      match exact fields [ "as_bytes"; "log_bytes"; "timeout_s"; "tmp_bytes" ] with
      | Error _ as e -> e
      | Ok () -> (
          match (field fields "timeout_s", field fields "as_bytes", field fields "log_bytes", field fields "tmp_bytes") with
          | Ok t, Ok a, Ok l, Ok w -> (
              match (as_int t, as_int a, as_int l, as_int w) with
              | Ok timeout_s, Ok as_bytes, Ok log_bytes, Ok tmp_bytes -> Ok { timeout_s; as_bytes; log_bytes; tmp_bytes }
              | Error _ as e, _, _, _ | _, (Error _ as e), _, _ | _, _, (Error _ as e), _ | _, _, _, (Error _ as e) -> e)
          | Error _ as e, _, _, _ | _, (Error _ as e), _, _ | _, _, (Error _ as e), _ | _, _, _, (Error _ as e) -> e))
  | _ -> fail "limits"

let reply_of = function
  | Obj fields -> (
      match exact fields [ "tag"; "text" ] with
      | Error _ as e -> e
      | Ok () -> (
          match (field fields "tag", field fields "text") with
          | Ok (String "Continue"), Ok (String text) -> Ok (Continue text)
          | Ok (String "Done"), Ok (String text) -> Ok (Done text)
          | Ok (String "Ask"), Ok (String text) -> Ok (Ask text)
          | Ok (String "Partial"), Ok (String text) -> Ok (Partial text)
          | Ok (String _), Ok (String _) -> fail "reply"
          | _ -> fail "reply"))
  | _ -> fail "reply"

let result_of = function
  | Obj fields -> (
      match field fields "tag" with
      | Ok (String "Ok") -> (
          match exact fields [ "body"; "status"; "tag" ] with
          | Error _ as e -> e
          | Ok () -> (
              match (field fields "status", field fields "body") with
              | Ok (Int status), Ok (String body) when status >= 0 && status <= 999 -> Ok (Http { status; body })
              | _ -> fail "result"))
      | Ok (String "Rejected") -> (
          match exact fields [ "reason"; "tag" ] with
          | Error _ as e -> e
          | Ok () -> (
              match field fields "reason" with
              | Ok (String reason) when reason <> "" -> Ok (Rejected reason)
              | _ -> fail "result"))
      | Ok (String "Denied") -> (
          match exact fields [ "reason"; "tag" ] with
          | Error _ as e -> e
          | Ok () -> (
              match field fields "reason" with
              | Ok (String reason) when reason <> "" -> Ok (Denied reason)
              | _ -> fail "result"))
      | _ -> fail "result")
  | _ -> fail "result"

let frame_of = function
  | Obj fields -> (
      match field fields "tag" with
      | Error _ as e -> e
      | Ok (String tag) -> (
          match tag with
          | "Init" -> (
              match exact fields [ "bound_input"; "execution_hash"; "limits"; "tag"; "version" ] with
              | Error _ as e -> e
              | Ok () -> (
                  match (field fields "version", field fields "execution_hash", field fields "bound_input", field fields "limits") with
                  | Ok version, Ok hash, Ok input, Ok limits -> (
                      match (as_int version, as_string hash, input_of input, limits_of limits) with
                      | Ok version, Ok execution_hash, Ok bound_input, Ok limits ->
                          if version <> 1 || execution_hash = "" || not (utf8_ok execution_hash) then fail "init"
                          else Ok (Init { version; execution_hash; bound_input; limits })
                      | Error _ as e, _, _, _ | _, (Error _ as e), _, _ | _, _, (Error _ as e), _ | _, _, _, (Error _ as e) -> e)
                  | _ -> fail "init"))
          | "Ready" -> (
              match exact fields [ "tag"; "version" ] with
              | Error _ as e -> e
              | Ok () -> (
                  match as_int (List.assoc "version" fields) with
                  | Ok version when version = 1 -> Ok (Ready { version })
                  | _ -> fail "ready"))
          | "Call" -> (
              match exact fields [ "args"; "method"; "request_id"; "tag"; "version" ] with
              | Error _ as e -> e
              | Ok () -> (
                  match (field fields "version", field fields "request_id", field fields "method", field fields "args") with
                  | Ok (Int version), Ok (Int request_id), Ok (String method_), Ok (Obj args) when version = 1 && request_id > 0 -> (
                      match (exact args [ "url" ], field args "url") with
                      | Ok (), Ok (String url) when method_ = "Net.get" && url <> "" -> Ok (Call { version; request_id; method_; url })
                      | _ -> fail "call")
                  | _ -> fail "call"))
          | "Return" -> (
              match exact fields [ "request_id"; "result"; "tag"; "version" ] with
              | Error _ as e -> e
              | Ok () -> (
                  match (field fields "version", field fields "request_id", field fields "result") with
                  | Ok (Int version), Ok (Int request_id), Ok result when version = 1 && request_id > 0 -> (
                      match result_of result with
                      | Ok result -> Ok (Return { version; request_id; result })
                      | Error _ as e -> e)
                  | _ -> fail "return"))
          | "Trace" -> (
              match exact fields [ "message"; "tag"; "version" ] with
              | Error _ as e -> e
              | Ok () -> (
                  match (field fields "version", field fields "message") with
                  | Ok (Int version), Ok (String message) when version = 1 -> Ok (Trace { version; message })
                  | _ -> fail "trace"))
          | "Stop" -> (
              match exact fields [ "code"; "tag"; "version" ] with
              | Error _ as e -> e
              | Ok () -> (
                  match (field fields "version", field fields "code") with
                  | Ok (Int version), Ok (String code) when version = 1 && code <> "" -> Ok (Stop { version; code })
                  | _ -> fail "stop"))
          | "Finished" -> (
              match exact fields [ "reply"; "tag"; "version" ] with
              | Error _ as e -> e
              | Ok () -> (
                  match (field fields "version", field fields "reply") with
                  | Ok (Int version), Ok reply when version = 1 -> (
                      match reply_of reply with
                      | Ok reply -> Ok (Finished { version; reply })
                      | Error _ as e -> e)
                  | _ -> fail "finished"))
          | _ -> fail "tag")
      | Ok _ -> fail "tag")
  | _ -> fail "frame"

let json_of_reply = function
  | Continue text -> Obj [ ("tag", String "Continue"); ("text", String text) ]
  | Done text -> Obj [ ("tag", String "Done"); ("text", String text) ]
  | Ask text -> Obj [ ("tag", String "Ask"); ("text", String text) ]
  | Partial text -> Obj [ ("tag", String "Partial"); ("text", String text) ]

let json_of_result = function
  | Http { status; body } -> Obj [ ("tag", String "Ok"); ("status", Int status); ("body", String body) ]
  | Rejected reason -> Obj [ ("tag", String "Rejected"); ("reason", String reason) ]
  | Denied reason -> Obj [ ("tag", String "Denied"); ("reason", String reason) ]

let json_of_limits limits =
  Obj
    [
      ("timeout_s", Int limits.timeout_s);
      ("as_bytes", Int limits.as_bytes);
      ("log_bytes", Int limits.log_bytes);
      ("tmp_bytes", Int limits.tmp_bytes);
    ]

let json_of = function
  | Init { version; execution_hash; bound_input; limits } ->
      Obj
        [
          ("tag", String "Init");
          ("version", Int version);
          ("execution_hash", String execution_hash);
          ("bound_input", Obj (List.map (fun (k, v) -> (k, String v)) bound_input));
          ("limits", json_of_limits limits);
        ]
  | Ready { version } -> Obj [ ("tag", String "Ready"); ("version", Int version) ]
  | Call { version; request_id; method_; url } ->
      Obj
        [
          ("tag", String "Call");
          ("version", Int version);
          ("request_id", Int request_id);
          ("method", String method_);
          ("args", Obj [ ("url", String url) ]);
        ]
  | Return { version; request_id; result } ->
      Obj [ ("tag", String "Return"); ("version", Int version); ("request_id", Int request_id); ("result", json_of_result result) ]
  | Trace { version; message } -> Obj [ ("tag", String "Trace"); ("version", Int version); ("message", String message) ]
  | Stop { version; code } -> Obj [ ("tag", String "Stop"); ("version", Int version); ("code", String code) ]
  | Finished { version; reply } -> Obj [ ("tag", String "Finished"); ("version", Int version); ("reply", json_of_reply reply) ]

let encode_frame frame =
  let text = encode (json_of frame) in
  if String.length text > max_frame then Error "frame" else Ok text

let decode_frame text =
  if String.length text > max_frame then fail "frame"
  else match parse text with
  | Error _ as e -> e
  | Ok json -> frame_of json

let read_full fd buf off len deadline =
  let rec go off len =
    if len = 0 then Ok ()
    else if Unix.gettimeofday () >= deadline then Error "deadline"
    else
      match Unix.read fd buf off len with
      | exception Unix.Unix_error (Unix.EINTR, _, _) -> go off len
      | exception Unix.Unix_error ((Unix.EAGAIN | Unix.EWOULDBLOCK), _, _) -> (
          match Unix.select [ fd ] [] [] (max 0. (deadline -. Unix.gettimeofday ())) with
          | [], _, _ -> Error "deadline"
          | _ -> go off len)
      | exception Unix.Unix_error ((Unix.EPIPE | Unix.ECONNRESET | Unix.EBADF | Unix.ECONNABORTED), _, _) -> Error "eof"
      | 0 -> Error "eof"
      | n -> go (off + n) (len - n)
  in
  go off len

let write_full fd buf off len deadline =
  let rec go off len =
    if len = 0 then Ok ()
    else if Unix.gettimeofday () >= deadline then Error "deadline"
    else
      match Unix.write fd buf off len with
      | exception Unix.Unix_error (Unix.EINTR, _, _) -> go off len
      | exception Unix.Unix_error ((Unix.EAGAIN | Unix.EWOULDBLOCK), _, _) -> (
          match Unix.select [] [ fd ] [] (max 0. (deadline -. Unix.gettimeofday ())) with
          | _, [], _ -> Error "deadline"
          | _ -> go off len)
      | exception Unix.Unix_error ((Unix.EPIPE | Unix.ECONNRESET | Unix.EBADF | Unix.ECONNABORTED), _, _) -> Error "eof"
      | 0 -> Error "eof"
      | n -> go (off + n) (len - n)
  in
  go off len

let read_frame fd deadline =
  let lenb = Bytes.create 4 in
  match read_full fd lenb 0 4 deadline with
  | Error _ as e -> e
  | Ok () ->
      let len =
        (Char.code (Bytes.get lenb 0) lsl 24)
        lor (Char.code (Bytes.get lenb 1) lsl 16)
        lor (Char.code (Bytes.get lenb 2) lsl 8)
        lor Char.code (Bytes.get lenb 3)
      in
      if len <= 0 || len > max_frame then Error "frame"
      else
        let body = Bytes.create len in
        match read_full fd body 0 len deadline with
        | Error _ as e -> e
        | Ok () -> decode_frame (Bytes.to_string body)

let write_frame fd frame deadline =
  match encode_frame frame with
  | Error _ as e -> e
  | Ok text ->
      let len = String.length text in
      let buf = Bytes.create (4 + len) in
      Bytes.set buf 0 (Char.chr ((len lsr 24) land 255));
      Bytes.set buf 1 (Char.chr ((len lsr 16) land 255));
      Bytes.set buf 2 (Char.chr ((len lsr 8) land 255));
      Bytes.set buf 3 (Char.chr (len land 255));
      Bytes.blit_string text 0 buf 4 len;
      write_full fd buf 0 (Bytes.length buf) deadline

let parse_input text =
  match parse text with
  | Error _ as e -> e
  | Ok json -> input_of json

type phase =
  | Need_ready
  | Idle
  | In_call of int
  | Stopping
  | Done_phase

type session = { phase : phase; next_id : int }

let session_start = { phase = Need_ready; next_id = 1 }

let on_worker session = function
  | Ready { version = 1 } when session.phase = Need_ready -> Ok { session with phase = Idle }
  | Call { version = 1; request_id; method_ = "Net.get"; url } when session.phase = Idle && request_id = session.next_id && url <> "" ->
      Ok { session with phase = In_call request_id }
  | Trace { version = 1; _ } when session.phase = Idle || (match session.phase with In_call _ -> true | _ -> false) -> Ok session
  | Finished { version = 1; _ } when session.phase = Idle -> Ok { session with phase = Done_phase }
  | Call _ | Finished _ | Ready _ | Return _ | Init _ | Stop _ | Trace _ -> Error "protocol"

let after_return session request_id =
  match session.phase with
  | In_call id when id = request_id -> Ok { phase = Idle; next_id = session.next_id + 1 }
  | _ -> Error "protocol"

let after_stop session =
  match session.phase with
  | Idle | In_call _ -> Ok { session with phase = Stopping }
  | _ -> Error "protocol"
