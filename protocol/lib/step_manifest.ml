(** Immutable step identity. The execution hash is SHA-256 of the canonical
    manifest with that field left out. Key order does not change it. *)

type json =
  | Null
  | Bool of bool
  | Int of int
  | String of string
  | Arr of json list
  | Obj of (string * json) list

type error =
  | Duplicate_key of string
  | Bad_number
  | Bad_utf8
  | Bad_json of string
  | Unknown_version
  | Missing_field of string
  | Bad_module of string

let describe = function
  | Duplicate_key k -> "duplicate key " ^ k
  | Bad_number -> "bad number"
  | Bad_utf8 -> "bad utf8"
  | Bad_json msg -> "bad json " ^ msg
  | Unknown_version -> "unknown version"
  | Missing_field f -> "missing " ^ f
  | Bad_module msg -> "bad module " ^ msg

let sha256 s = Digestif.SHA256.to_hex (Digestif.SHA256.digest_string s)

let hash_ok s =
  String.length s = 64
  && String.for_all (fun c -> (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f')) s

let max_safe = 9007199254740991
let max_depth = 32
let max_bytes = 262144

let utf8_ok s =
  let n = String.length s in
  let rec cont s j stop =
    if j = stop then true
    else
      let b = Char.code s.[j] in
      b land 0xC0 = 0x80 && cont s (j + 1) stop
  in
  let rec loop i =
    if i >= n then true
    else
      let c = Char.code s.[i] in
      if c < 0x80 then loop (i + 1)
      else if c < 0xC2 || c > 0xF4 then false
      else
        let len, lo, hi =
          if c <= 0xDF then (2, 0x80, 0xBF)
          else if c = 0xE0 then (3, 0xA0, 0xBF)
          else if c = 0xED then (3, 0x80, 0x9F)
          else if c <= 0xEF then (3, 0x80, 0xBF)
          else if c = 0xF0 then (4, 0x90, 0xBF)
          else if c <= 0xF3 then (4, 0x80, 0xBF)
          else (4, 0x80, 0x8F)
        in
        if i + len > n then false
        else
          let second = Char.code s.[i + 1] in
          second >= lo && second <= hi && cont s (i + 2) (i + len) && loop (i + len)
  in
  loop 0

let add_utf8 buf code =
  if code < 0x80 then Buffer.add_char buf (Char.chr code)
  else if code < 0x800 then (
    Buffer.add_char buf (Char.chr (0xC0 lor (code lsr 6)));
    Buffer.add_char buf (Char.chr (0x80 lor (code land 0x3F))))
  else if code < 0x10000 then (
    Buffer.add_char buf (Char.chr (0xE0 lor (code lsr 12)));
    Buffer.add_char buf (Char.chr (0x80 lor ((code lsr 6) land 0x3F)));
    Buffer.add_char buf (Char.chr (0x80 lor (code land 0x3F))))
  else (
    Buffer.add_char buf (Char.chr (0xF0 lor (code lsr 18)));
    Buffer.add_char buf (Char.chr (0x80 lor ((code lsr 12) land 0x3F)));
    Buffer.add_char buf (Char.chr (0x80 lor ((code lsr 6) land 0x3F)));
    Buffer.add_char buf (Char.chr (0x80 lor (code land 0x3F))))

let escape buf s =
  String.iter
    (fun c ->
      match c with
      | '"' -> Buffer.add_string buf "\\\""
      | '\\' -> Buffer.add_string buf "\\\\"
      | c when Char.code c < 32 -> Printf.bprintf buf "\\u%04x" (Char.code c)
      | c -> Buffer.add_char buf c)
    s

let rec encode buf = function
  | Null -> Buffer.add_string buf "null"
  | Bool true -> Buffer.add_string buf "true"
  | Bool false -> Buffer.add_string buf "false"
  | Int n -> Buffer.add_string buf (string_of_int n)
  | String s ->
      Buffer.add_char buf '"';
      escape buf s;
      Buffer.add_char buf '"'
  | Arr xs ->
      Buffer.add_char buf '[';
      List.iteri
        (fun i x ->
          if i > 0 then Buffer.add_char buf ',';
          encode buf x)
        xs;
      Buffer.add_char buf ']'
  | Obj fields ->
      let fields = List.sort (fun (a, _) (b, _) -> String.compare a b) fields in
      Buffer.add_char buf '{';
      List.iteri
        (fun i (k, v) ->
          if i > 0 then Buffer.add_char buf ',';
          Buffer.add_char buf '"';
          escape buf k;
          Buffer.add_string buf "\":";
          encode buf v)
        fields;
      Buffer.add_char buf '}'

let rec check depth = function
  | _ when depth > max_depth -> Error (Bad_json "depth")
  | Null | Bool _ -> Ok ()
  | Int n when n > max_safe || n < -max_safe -> Error Bad_number
  | Int _ -> Ok ()
  | String s when String.length s > max_bytes -> Error (Bad_json "size")
  | String s -> if utf8_ok s then Ok () else Error Bad_utf8
  | Arr xs ->
      let rec go = function
        | [] -> Ok ()
        | item :: rest -> (
            match check (depth + 1) item with
            | Error _ as err -> err
            | Ok () -> go rest)
      in
      go xs
  | Obj fields ->
      let rec go seen = function
        | [] -> Ok ()
        | (key, value) :: rest ->
            if List.mem key seen then Error (Duplicate_key key)
            else if String.length key > max_bytes then Error (Bad_json "size")
            else if not (utf8_ok key) then Error Bad_utf8
            else
              match check (depth + 1) value with
              | Error _ as err -> err
              | Ok () -> go (key :: seen) rest
      in
      go [] fields

let canonical json =
  match check 0 json with
  | Error _ as err -> err
  | Ok () ->
      let buf = Buffer.create 128 in
      encode buf json;
      let text = Buffer.contents buf in
      if String.length text > max_bytes then Error (Bad_json "size") else Ok text

let canonical_text json =
  match canonical json with
  | Ok text -> text
  | Error err -> invalid_arg (describe err)

type parser = { s : string; mutable i : int }

let peek p = if p.i >= String.length p.s then '\000' else p.s.[p.i]

let bump p =
  let c = peek p in
  p.i <- p.i + 1;
  c

let skip p =
  while
    match peek p with
    | ' ' | '\n' | '\r' | '\t' -> true
    | _ -> false
  do
    p.i <- p.i + 1
  done

let fail msg = Error (Bad_json msg)

let parse_string p =
  if bump p <> '"' then fail "string"
  else
    let buf = Buffer.create 16 in
    let rec loop () =
      if p.i >= String.length p.s then fail "string"
      else
        match bump p with
        | '"' ->
            let s = Buffer.contents buf in
            if utf8_ok s then Ok s else Error Bad_utf8
        | '\\' -> (
            match bump p with
            | '"' ->
                Buffer.add_char buf '"';
                loop ()
            | '\\' ->
                Buffer.add_char buf '\\';
                loop ()
            | 'n' ->
                Buffer.add_char buf '\n';
                loop ()
            | 'r' ->
                Buffer.add_char buf '\r';
                loop ()
            | 't' ->
                Buffer.add_char buf '\t';
                loop ()
            | 'b' ->
                Buffer.add_char buf '\b';
                loop ()
            | 'f' ->
                Buffer.add_char buf '\012';
                loop ()
            | '/' ->
                Buffer.add_char buf '/';
                loop ()
            | 'u' -> (
                let hex_ok s =
                  String.length s = 4
                  && String.for_all
                       (fun c -> (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F'))
                       s
                in
                let read_unit () =
                  if p.i + 4 > String.length p.s then None
                  else
                    let hex = String.sub p.s p.i 4 in
                    if hex_ok hex then (
                      p.i <- p.i + 4;
                      int_of_string_opt ("0x" ^ hex))
                    else None
                in
                match read_unit () with
                | Some hi when hi >= 0xD800 && hi <= 0xDBFF ->
                    if p.i + 6 <= String.length p.s && p.s.[p.i] = '\\' && p.s.[p.i + 1] = 'u' then (
                      p.i <- p.i + 2;
                      match read_unit () with
                      | Some lo when lo >= 0xDC00 && lo <= 0xDFFF ->
                          let code = 0x10000 + ((hi - 0xD800) lsl 10) + (lo - 0xDC00) in
                          add_utf8 buf code;
                          loop ()
                      | _ -> fail "escape")
                    else fail "escape"
                | Some code when code >= 0 && code <= 0xFFFF && not (code >= 0xDC00 && code <= 0xDFFF) ->
                    add_utf8 buf code;
                    loop ()
                | _ -> fail "escape")
            | _ -> fail "escape")
        | c when Char.code c < 32 -> fail "raw control"
        | c ->
            Buffer.add_char buf c;
            loop ()
    in
    loop ()

let parse_number p =
  let start = p.i in
  if peek p = '-' then p.i <- p.i + 1;
  let digits = p.i in
  while peek p >= '0' && peek p <= '9' do
    p.i <- p.i + 1
  done;
  if p.i = digits then Error Bad_number
  else if peek p = '.' || peek p = 'e' || peek p = 'E' then Error Bad_number
  else
    let raw = String.sub p.s start (p.i - start) in
    let body = if raw.[0] = '-' then String.sub raw 1 (String.length raw - 1) else raw in
    if body = "" || (String.length body > 1 && body.[0] = '0') then Error Bad_number
    else if String.length body > 16 then Error Bad_number
    else
      match int_of_string_opt raw with
      | None -> Error Bad_number
      | Some n when n > max_safe || n < -max_safe -> Error Bad_number
      | Some n -> Ok (Int n)

let starts p lit =
  let n = String.length lit in
  p.i + n <= String.length p.s && String.sub p.s p.i n = lit

let rec parse_value p depth =
  if depth > max_depth then fail "depth"
  else (
    skip p;
    match peek p with
    | 'n' -> if starts p "null" then (p.i <- p.i + 4; Ok Null) else fail "null"
    | 't' -> if starts p "true" then (p.i <- p.i + 4; Ok (Bool true)) else fail "bool"
    | 'f' -> if starts p "false" then (p.i <- p.i + 5; Ok (Bool false)) else fail "bool"
    | '"' -> (
        match parse_string p with
        | Ok s -> Ok (String s)
        | Error _ as e -> e)
    | '[' -> parse_array p depth
    | '{' -> parse_object p depth
    | '-' | '0' .. '9' -> parse_number p
    | _ -> fail "value")

and parse_array p depth =
  ignore (bump p);
  skip p;
  if peek p = ']' then (
    p.i <- p.i + 1;
    Ok (Arr []))
  else
    let rec elts acc =
      match parse_value p (depth + 1) with
      | Error _ as e -> e
      | Ok v ->
          let acc = v :: acc in
          skip p;
          match peek p with
          | ',' ->
              p.i <- p.i + 1;
              elts acc
          | ']' ->
              p.i <- p.i + 1;
              Ok (Arr (List.rev acc))
          | _ -> fail "array"
    in
    elts []

and parse_object p depth =
  ignore (bump p);
  skip p;
  if peek p = '}' then (
    p.i <- p.i + 1;
    Ok (Obj []))
  else
    let rec fields acc =
      skip p;
      match parse_string p with
      | Error _ as e -> e
      | Ok key ->
          if List.mem_assoc key acc then Error (Duplicate_key key)
          else (
            skip p;
            if bump p <> ':' then fail "colon"
            else
              match parse_value p (depth + 1) with
              | Error _ as e -> e
              | Ok v ->
                  let acc = (key, v) :: acc in
                  skip p;
                  match peek p with
                  | ',' ->
                      p.i <- p.i + 1;
                      fields acc
                  | '}' ->
                      p.i <- p.i + 1;
                      Ok (Obj (List.rev acc))
                  | _ -> fail "object")
    in
    fields []

let parse text =
  if String.length text > max_bytes then Error (Bad_json "size")
  else
    let p = { s = text; i = 0 } in
    match parse_value p 0 with
  | Error _ as e -> e
  | Ok v ->
      skip p;
      if p.i = String.length p.s then Ok v else fail "trailing"

let field obj name =
  match List.assoc_opt name obj with
  | Some v -> Ok v
  | None -> Error (Missing_field name)

let exact_keys obj expected =
  let keys = List.map fst obj in
  let unknown = List.filter (fun k -> not (List.mem k expected)) keys in
  let missing = List.filter (fun k -> not (List.mem_assoc k obj)) expected in
  match (unknown, missing) with
  | k :: _, _ -> Error (Bad_json ("unknown " ^ k))
  | _, k :: _ -> Error (Missing_field k)
  | [], [] -> Ok ()

let as_string = function
  | String s -> Ok s
  | _ -> fail "string"

let module_name_ok name =
  name <> "" && name <> "." && name <> ".."
  &&
  let rec loop i =
    if i >= String.length name then true
    else
      match name.[i] with
      | '/' | '\\' | '\000' | ':' -> false
      | _ -> loop (i + 1)
  in
  loop 0

type module_desc = {
  name : string;
  source_hash : string;
  interface_hash : string;
  artifact_hash : string;
}

type t = {
  manifest_version : int;
  protocol_version : int;
  step_api_version : int;
  run_id : string;
  step_id : string;
  step_seq : int;
  source_hash : string;
  modules : module_desc list;
  compiler_id : string;
  runtime_id : string;
  sdk_hash : string;
  driver_hash : string;
  artifact_hash : string;
  base_workspace_hash : string;
  input_context_hash : string;
  capability_grant_hash : string;
  policy_version : string;
  execution_hash : string;
}

type state =
  | Prepared
  | Running
  | Awaiting_approval
  | Blocked_unknown
  | Completed
  | Failed

type reply =
  | Continue of string
  | Done of string
  | Ask of string
  | Partial of string

type record = {
  admission_key : string;
  manifest : t;
  state : state;
  reply : reply option;
  final_workspace : string option;
  error : string option;
}

let state_name = function
  | Prepared -> "Prepared"
  | Running -> "Running"
  | Awaiting_approval -> "AwaitingApproval"
  | Blocked_unknown -> "BlockedUnknown"
  | Completed -> "Completed"
  | Failed -> "Failed"

let state_of = function
  | "Prepared" -> Ok Prepared
  | "Running" -> Ok Running
  | "AwaitingApproval" -> Ok Awaiting_approval
  | "BlockedUnknown" -> Ok Blocked_unknown
  | "Completed" -> Ok Completed
  | "Failed" -> Ok Failed
  | _ -> Error Unknown_version

let module_json m =
  Obj
    [
      ("name", String m.name);
      ("source_hash", String m.source_hash);
      ("interface_hash", String m.interface_hash);
      ("artifact_hash", String m.artifact_hash);
    ]

let preimage m =
  Obj
    [
      ("manifest_version", Int m.manifest_version);
      ("protocol_version", Int m.protocol_version);
      ("step_api_version", Int m.step_api_version);
      ("run_id", String m.run_id);
      ("step_id", String m.step_id);
      ("step_seq", Int m.step_seq);
      ("source_hash", String m.source_hash);
      ("modules", Arr (List.map module_json m.modules));
      ("compiler_id", String m.compiler_id);
      ("runtime_id", String m.runtime_id);
      ("sdk_hash", String m.sdk_hash);
      ("driver_hash", String m.driver_hash);
      ("artifact_hash", String m.artifact_hash);
      ("base_workspace_hash", String m.base_workspace_hash);
      ("input_context_hash", String m.input_context_hash);
      ("capability_grant_hash", String m.capability_grant_hash);
      ("policy_version", String m.policy_version);
    ]

let manifest_json m =
  match preimage m with
  | Obj fields -> Obj (("execution_hash", String m.execution_hash) :: fields)
  | other -> other

let seal m = { m with execution_hash = sha256 (canonical_text (preimage m)) }

let reply_json = function
  | Continue text -> Obj [ ("tag", String "Continue"); ("text", String text) ]
  | Done text -> Obj [ ("tag", String "Done"); ("text", String text) ]
  | Ask text -> Obj [ ("tag", String "Ask"); ("text", String text) ]
  | Partial text -> Obj [ ("tag", String "Partial"); ("text", String text) ]

let reply_of_json = function
  | Obj fields -> (
      match exact_keys fields [ "tag"; "text" ] with
      | Error _ as e -> e
      | Ok () -> (
          match (field fields "tag", field fields "text") with
          | Ok (String "Continue"), Ok (String text) -> Ok (Continue text)
          | Ok (String "Done"), Ok (String text) -> Ok (Done text)
          | Ok (String "Ask"), Ok (String text) -> Ok (Ask text)
          | Ok (String "Partial"), Ok (String text) -> Ok (Partial text)
          | Ok (String _), Ok (String _) -> Error Unknown_version
          | _ -> fail "reply"))
  | _ -> fail "reply"

let record_json r =
  let workspace = function
    | None -> Null
    | Some s -> String s
  in
  let err = function
    | None -> Null
    | Some s -> String s
  in
  Obj
    [
      ("admission_key", String r.admission_key);
      ("manifest", manifest_json r.manifest);
      ("state", String (state_name r.state));
      ("reply", (match r.reply with None -> Null | Some reply -> reply_json reply));
      ("final_workspace", workspace r.final_workspace);
      ("error", err r.error);
    ]

let canonical_record r = canonical (record_json r)

let module_of_json = function
  | Obj fields -> (
      match exact_keys fields [ "name"; "source_hash"; "interface_hash"; "artifact_hash" ] with
      | Error _ as e -> e
      | Ok () -> (
          match (field fields "name", field fields "source_hash", field fields "interface_hash", field fields "artifact_hash") with
          | Ok name, Ok source_hash, Ok interface_hash, Ok artifact_hash -> (
              match (as_string name, as_string source_hash, as_string interface_hash, as_string artifact_hash) with
              | Ok name, Ok source_hash, Ok interface_hash, Ok artifact_hash ->
                  if not (module_name_ok name) then Error (Bad_module name)
                  else if not (hash_ok source_hash && hash_ok interface_hash && hash_ok artifact_hash) then
                    Error (Bad_json "hash")
                  else Ok { name; source_hash; interface_hash; artifact_hash }
              | Error _ as e, _, _, _ | _, (Error _ as e), _, _ | _, _, (Error _ as e), _ | _, _, _, (Error _ as e) -> e)
          | Error _ as e, _, _, _ | _, (Error _ as e), _, _ | _, _, (Error _ as e), _ | _, _, _, (Error _ as e) -> e))
  | _ -> fail "module"

let manifest_keys =
  [
    "manifest_version";
    "protocol_version";
    "step_api_version";
    "run_id";
    "step_id";
    "step_seq";
    "source_hash";
    "modules";
    "compiler_id";
    "runtime_id";
    "sdk_hash";
    "driver_hash";
    "artifact_hash";
    "base_workspace_hash";
    "input_context_hash";
    "capability_grant_hash";
    "policy_version";
    "execution_hash";
  ]

let manifest_of_json = function
  | Obj fields -> (
      match exact_keys fields manifest_keys with
      | Error _ as e -> e
      | Ok () -> (
          let str name =
            match field fields name with
            | Ok (String s) -> Ok s
            | Ok _ -> fail name
            | Error _ as e -> e
          in
          let num name =
            match field fields name with
            | Ok (Int n) -> Ok n
            | Ok _ -> Error Bad_number
            | Error _ as e -> e
          in
          match
            ( num "manifest_version",
              num "protocol_version",
              num "step_api_version",
              str "run_id",
              str "step_id",
              num "step_seq",
              str "source_hash",
              field fields "modules",
              str "compiler_id",
              str "runtime_id",
              str "sdk_hash",
              str "driver_hash",
              str "artifact_hash",
              str "base_workspace_hash",
              str "input_context_hash",
              str "capability_grant_hash",
              str "policy_version",
              str "execution_hash" )
          with
          | Ok manifest_version, Ok protocol_version, Ok step_api_version, Ok run_id, Ok step_id, Ok step_seq, Ok source_hash, Ok (Arr raw_modules), Ok compiler_id, Ok runtime_id, Ok sdk_hash, Ok driver_hash, Ok artifact_hash, Ok base_workspace_hash, Ok input_context_hash, Ok capability_grant_hash, Ok policy_version, Ok execution_hash -> (
              if manifest_version <> 1 || protocol_version <> 1 || step_api_version <> 1 then Error Unknown_version
              else if run_id = "" || step_id = "" then fail "identity"
              else if
                not
                  (hash_ok source_hash && hash_ok sdk_hash && hash_ok driver_hash && hash_ok artifact_hash
                 && hash_ok base_workspace_hash && hash_ok input_context_hash && hash_ok capability_grant_hash
                 && hash_ok execution_hash)
              then Error (Bad_json "hash")
              else
                let rec take acc = function
                  | [] -> Ok (List.rev acc)
                  | item :: rest -> (
                      match module_of_json item with
                      | Error _ as e -> e
                      | Ok m -> take (m :: acc) rest)
                in
                match take [] raw_modules with
                | Error _ as e -> e
                | Ok modules ->
                    let names = List.map (fun (m : module_desc) -> m.name) modules in
                    if List.length names <> List.length (List.sort_uniq String.compare names) then Error (Bad_module "duplicate")
                    else
                      let m =
                        {
                          manifest_version;
                          protocol_version;
                          step_api_version;
                          run_id;
                          step_id;
                          step_seq;
                          source_hash;
                          modules;
                          compiler_id;
                          runtime_id;
                          sdk_hash;
                          driver_hash;
                          artifact_hash;
                          base_workspace_hash;
                          input_context_hash;
                          capability_grant_hash;
                          policy_version;
                          execution_hash;
                        }
                      in
                      let expect = sha256 (canonical_text (preimage m)) in
                      if expect <> execution_hash then Error (Bad_json "execution hash") else Ok m)
          | _ -> fail "manifest"))
  | _ -> fail "manifest"

let opt_workspace = function
  | Null -> Ok None
  | String s when hash_ok s -> Ok (Some s)
  | String _ -> Error (Bad_json "hash")
  | _ -> fail "workspace"

let opt_error = function
  | Null -> Ok None
  | String s -> Ok (Some s)
  | _ -> fail "error"

let opt_reply = function
  | Null -> Ok None
  | json -> (
      match reply_of_json json with
      | Ok reply -> Ok (Some reply)
      | Error _ as err -> err)

let completion_ok state reply final_workspace =
  match state with
  | Completed -> (
      match (reply, final_workspace) with
      | Some _, Some _ -> Ok ()
      | _ -> Error (Bad_json "completion"))
  | Failed -> if reply = None && final_workspace = None then Ok () else Error (Bad_json "completion")
  | Prepared | Running | Awaiting_approval | Blocked_unknown ->
      if reply = None && final_workspace = None then Ok () else Error (Bad_json "completion")

let record_of_json = function
  | Obj fields -> (
      match exact_keys fields [ "admission_key"; "manifest"; "state"; "reply"; "final_workspace"; "error" ] with
      | Error _ as e -> e
      | Ok () -> (
          match (field fields "admission_key", field fields "manifest", field fields "state", field fields "reply", field fields "final_workspace", field fields "error") with
          | Ok (String admission_key), Ok manifest, Ok (String state), Ok reply, Ok final_workspace, Ok error -> (
              match (manifest_of_json manifest, state_of state, opt_reply reply, opt_workspace final_workspace, opt_error error) with
              | Ok manifest, Ok state, Ok reply, Ok final_workspace, Ok error -> (
                  match completion_ok state reply final_workspace with
                  | Error _ as err -> err
                  | Ok () -> Ok { admission_key; manifest; state; reply; final_workspace; error })
              | Error _ as e, _, _, _, _ | _, (Error _ as e), _, _, _ | _, _, (Error _ as e), _, _ | _, _, _, (Error _ as e), _ | _, _, _, _, (Error _ as e)
                ->
                  e)
          | _ -> fail "record"))
  | _ -> fail "record"

let parse_record text =
  match parse text with
  | Error _ as e -> e
  | Ok json -> record_of_json json

let operation_hash ~execution_hash ~step_id ~kind ~codec_version ~approval ~params_hash =
  sha256
    (canonical_text
       (Obj
          [
            ("approval", Bool approval);
            ("codec_version", Int codec_version);
            ("execution_hash", String execution_hash);
            ("kind", String kind);
            ("params_hash", String params_hash);
            ("step_id", String step_id);
          ]))

type module_bytes = {
  name : string;
  source : string;
  interface_ : string;
  artifact : string;
}

type bundle = {
  source : string;
  modules : module_bytes list;
  compiler_id : string;
  runtime_id : string;
  sdk : string;
  driver : string;
  artifact : string;
  base_workspace : string;
  input_context : string;
  capability_grant : string;
  policy_version : string;
}

let build ~run_id ~step_id ~step_seq (b : bundle) =
  if not (utf8_ok b.source) then Error Bad_utf8
  else if List.length b.modules > 16 then Error (Bad_module "too many")
  else
    let rec mods acc = function
      | [] -> Ok (List.rev acc)
      | m :: rest ->
          if not (module_name_ok m.name) then Error (Bad_module m.name)
          else if not (utf8_ok m.source && utf8_ok m.interface_) then Error Bad_utf8
          else
            let desc =
              {
                name = m.name;
                source_hash = sha256 m.source;
                interface_hash = sha256 m.interface_;
                artifact_hash = sha256 m.artifact;
              }
            in
            mods (desc :: acc) rest
    in
    match mods [] b.modules with
    | Error _ as e -> e
    | Ok modules ->
        let names = List.map (fun (m : module_desc) -> m.name) modules in
        if List.length names <> List.length (List.sort_uniq String.compare names) then Error (Bad_module "duplicate")
        else if
          not
            (utf8_ok b.compiler_id && utf8_ok b.runtime_id && utf8_ok b.sdk && utf8_ok b.driver
           && utf8_ok b.base_workspace && utf8_ok b.input_context && utf8_ok b.capability_grant && utf8_ok b.policy_version)
        then Error Bad_utf8
        else
          Ok
            (seal
               {
                 manifest_version = 1;
                 protocol_version = 1;
                 step_api_version = 1;
                 run_id;
                 step_id;
                 step_seq;
                 source_hash = sha256 b.source;
                 modules;
                 compiler_id = b.compiler_id;
                 runtime_id = b.runtime_id;
                 sdk_hash = sha256 b.sdk;
                 driver_hash = sha256 b.driver;
                 artifact_hash = sha256 b.artifact;
                 base_workspace_hash = sha256 b.base_workspace;
                 input_context_hash = sha256 b.input_context;
                 capability_grant_hash = sha256 b.capability_grant;
                 policy_version = b.policy_version;
                 execution_hash = "";
               })
