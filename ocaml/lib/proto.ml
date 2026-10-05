(** Effect protocol. Capabilities live here. Environments live in handlers.
    Continuations are one-shot and are not serialisable: durable recovery
    replays the journal instead of restoring [k]. *)

type json = Json.t

type risk = [ `Low | `High ]

type tool_call = {
  call_id : string;
  name : string;
  args : json;
}

type tool_result = {
  ok : bool;
  output : string;
  diagnostics : string list;
}

type approval = {
  action : string;
  risk : risk;
  payload : json;
}

type decision =
  | Approved
  | Rejected of string

type msg = {
  role : string;
  content : string;
}

type llm_request = {
  purpose : string;
  messages : msg list;
}

type llm_response = {
  text : string;
  tool : (string * json) option;
}

type fetch_request = { url : string }

type fetch_reply = {
  status : int;
  body : string;
}

type _ Effect.t +=
  | Llm : llm_request -> llm_response Effect.t
  | Tool : tool_call -> tool_result Effect.t
  | Ask_human : approval -> decision Effect.t
  | Checkpoint : string -> unit Effect.t
  | Compact : msg list -> msg list Effect.t
  | Now : float Effect.t
  | Fresh_id : string Effect.t
  | Fetch : fetch_request -> fetch_reply Effect.t

exception Budget_exceeded of { used : int; max : int }
exception Nondeterminism of { seq : int; expected : string; actual : string; label : string }
exception Harness_error of string
exception Version_mismatch of { expected : string; actual : string }

let contains s sub =
  let len_s = String.length s and len_sub = String.length sub in
  let rec loop i =
    if i + len_sub > len_s then false
    else if String.sub s i len_sub = sub then true
    else loop (i + 1)
  in
  loop 0

let name (type a) (e : a Effect.t) =
  match e with
  | Llm r -> "Llm · " ^ r.purpose
  | Tool c -> "Tool · " ^ c.name
  | Ask_human a -> "Ask_human · " ^ a.action
  | Checkpoint label -> "Checkpoint · " ^ label
  | Compact _ -> "Compact"
  | Now -> "Now"
  | Fresh_id -> "Fresh_id"
  | Fetch r -> "Fetch · " ^ r.url
  | _ -> "unknown"

let kind (type a) (e : a Effect.t) =
  match e with
  | Llm _ -> "Llm"
  | Tool _ -> "Tool"
  | Ask_human _ -> "Ask_human"
  | Checkpoint _ -> "Checkpoint"
  | Compact _ -> "Compact"
  | Now -> "Now"
  | Fresh_id -> "Fresh_id"
  | Fetch _ -> "Fetch"
  | _ -> "unknown"

let msg_json m = Json.Assoc [ ("role", Json.String m.role); ("content", Json.String m.content) ]

let msgs_json ms = Json.List (List.map msg_json ms)

let risk_json = function
  | `Low -> Json.String "Low"
  | `High -> Json.String "High"

let request_json (type a) (e : a Effect.t) =
  match e with
  | Llm r ->
      Json.Assoc
        [ ("tag", Json.String "Llm"); ("purpose", Json.String r.purpose); ("messages", msgs_json r.messages) ]
  | Tool c ->
      Json.Assoc
        [
          ("tag", Json.String "Tool");
          ("call_id", Json.String c.call_id);
          ("name", Json.String c.name);
          ("args", c.args);
        ]
  | Ask_human a ->
      Json.Assoc
        [
          ("tag", Json.String "Ask_human");
          ("action", Json.String a.action);
          ("risk", risk_json a.risk);
          ("payload", a.payload);
        ]
  | Checkpoint label -> Json.Assoc [ ("tag", Json.String "Checkpoint"); ("label", Json.String label) ]
  | Compact ms -> Json.Assoc [ ("tag", Json.String "Compact"); ("messages", msgs_json ms) ]
  | Now -> Json.Assoc [ ("tag", Json.String "Now") ]
  | Fresh_id -> Json.Assoc [ ("tag", Json.String "Fresh_id") ]
  | Fetch r -> Json.parse (Adapt.fetch_wire r.url)
  | _ -> Json.Assoc [ ("tag", Json.String "unknown") ]

let req_hash e = Json.hash (request_json e)

let strings_of_json = function
  | Json.List xs ->
      List.map
        (function
          | Json.String s -> s
          | _ -> "")
        xs
  | _ -> []

let msg_of_json = function
  | Json.Assoc _ as j ->
      { role = Json.assoc_string "role" j; content = Json.assoc_string "content" j }
  | _ -> { role = ""; content = "" }

let msgs_of_json = function
  | Json.List xs -> List.map msg_of_json xs
  | _ -> []

let decision_json = function
  | Approved -> Json.Assoc [ ("tag", Json.String "Approved") ]
  | Rejected reason ->
      Json.Assoc [ ("tag", Json.String "Rejected"); ("reason", Json.String reason) ]

let decision_of_json json =
  match Json.assoc_string "tag" json with
  | "Approved" -> Approved
  | "Rejected" -> Rejected (Json.assoc_string "reason" json)
  | tag -> raise (Harness_error ("审批结果无法识别：" ^ tag))

let tool_json r =
  Json.Assoc
    [
      ("ok", Json.Bool r.ok);
      ("output", Json.String r.output);
      ("diagnostics", Json.List (List.map (fun s -> Json.String s) r.diagnostics));
    ]

let tool_of_json json =
  {
    ok = (match Json.field_opt "ok" json with Some (Json.Bool b) -> b | _ -> false);
    output = Json.assoc_string "output" json;
    diagnostics = strings_of_json (match Json.field_opt "diagnostics" json with Some v -> v | None -> Json.List []);
  }

let llm_json r =
  let tool =
    match r.tool with
    | None -> Json.Null
    | Some (name, args) -> Json.Assoc [ ("name", Json.String name); ("args", args) ]
  in
  Json.Assoc [ ("text", Json.String r.text); ("tool", tool) ]

let llm_of_json json =
  let tool =
    match Json.field_opt "tool" json with
    | Some (Json.Assoc _ as t) -> Some (Json.assoc_string "name" t, match Json.field_opt "args" t with Some a -> a | None -> Json.Null)
    | _ -> None
  in
  { text = Json.assoc_string "text" json; tool }

let float_of_json = function
  | Json.Int n -> float_of_int n
  | Json.Float f -> f
  | Json.String s -> float_of_string s
  | _ -> raise (Harness_error "时间记录损坏")

let encode_result (type a) (e : a Effect.t) (v : a) : json =
  match e with
  | Llm _ -> llm_json v
  | Tool _ -> tool_json v
  | Ask_human _ -> decision_json v
  | Checkpoint _ -> Json.Null
  | Compact _ -> msgs_json v
  | Now ->
      let n = v in
      if Float.trunc n = n then Json.Int (int_of_float n) else Json.Float n
  | Fresh_id -> Json.String v
  | Fetch _ -> Json.Assoc [ ("status", Json.Int v.status); ("body", Json.String v.body) ]
  | _ -> raise (Harness_error "无法编码未知 effect")

let decode_result (type a) (e : a Effect.t) (json : json) : a =
  match e with
  | Llm _ -> llm_of_json json
  | Tool _ -> tool_of_json json
  | Ask_human _ -> decision_of_json json
  | Checkpoint _ -> ()
  | Compact _ -> msgs_of_json json
  | Now -> float_of_json json
  | Fresh_id ->
      (match json with
      | Json.String s -> s
      | _ -> raise (Harness_error "id 记录损坏"))
  | Fetch _ ->
      {
        status = Json.int_field "status" json;
        body = Json.assoc_string "body" json;
      }
  | _ -> raise (Harness_error "无法解码未知 effect")
