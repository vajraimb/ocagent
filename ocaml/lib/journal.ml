(** Append-only effect journal. Pending is written before the side effect.
    Done is the recorded answer used on replay. There is no continuation in
    this file. *)

type status =
  | Pending
  | Done
  | Unknown

type hit =
  | Execute
  | Replay
  | Suspend

type entry = {
  run_id : string;
  seq : int;
  kind : string;
  label : string;
  req_hash : string;
  req : Json.t;
  mutable status : status;
  mutable result : Json.t;
  idempotency_key : string;
  mutable attempt : int;
  mutable idempotent : bool;
  ts : int;
  mutable last_hit : hit;
}

type t = {
  run_id : string;
  mutable agent_version : string;
  entries : entry list ref;
}

let create ~run_id ~agent_version = { run_id; agent_version; entries = ref [] }

let copy_entry (e : entry) =
  {
    e with
    status = e.status;
    result = e.result;
    last_hit = e.last_hit;
  }

let copy j =
  { run_id = j.run_id; agent_version = j.agent_version; entries = ref (List.map copy_entry !(j.entries)) }

let status_json = function
  | Pending -> Json.String "Pending"
  | Done -> Json.String "Done"
  | Unknown -> Json.String "Unknown"

let status_of = function
  | "Pending" -> Pending
  | "Done" -> Done
  | "Unknown" -> Unknown
  | other -> raise (Json.Parse ("status " ^ other))

let hit_json = function
  | Execute -> Json.String "execute"
  | Replay -> Json.String "replay"
  | Suspend -> Json.String "suspend"

let hit_of = function
  | "execute" -> Execute
  | "replay" -> Replay
  | "suspend" -> Suspend
  | other -> raise (Json.Parse ("hit " ^ other))

let entry_json (e : entry) =
  Json.Assoc
    [
      ("run_id", Json.String e.run_id);
      ("seq", Json.Int e.seq);
      ("kind", Json.String e.kind);
      ("label", Json.String e.label);
      ("req_hash", Json.String e.req_hash);
      ("req", e.req);
      ("status", status_json e.status);
      ("result", e.result);
      ("idempotency_key", Json.String e.idempotency_key);
      ("attempt", Json.Int e.attempt);
      ("idempotent", Json.Bool e.idempotent);
      ("ts", Json.Int e.ts);
      ("last_hit", hit_json e.last_hit);
    ]

let entry_of_json j =
  let status = status_of (Json.string_field "status" j) in
  let last_hit = hit_of (Json.string_field "last_hit" j) in
  {
    run_id = Json.string_field "run_id" j;
    seq = Json.int_field "seq" j;
    kind = Json.string_field "kind" j;
    label = Json.string_field "label" j;
    req_hash = Json.string_field "req_hash" j;
    req = Json.field "req" j;
    status;
    result = (match Json.field_opt "result" j with Some v -> v | None -> Json.Null);
    idempotency_key = Json.string_field "idempotency_key" j;
    attempt = (match Json.field_opt "attempt" j with Some (Json.Int n) -> n | _ -> 1);
    idempotent =
      (match Json.field_opt "idempotent" j with Some (Json.Bool b) -> b | _ -> true);
    ts = Json.int_field "ts" j;
    last_hit;
  }

let to_jsonl j =
  let header =
    Json.canonical
      (Json.Assoc
         [ ("run_id", Json.String j.run_id); ("agent_version", Json.String j.agent_version) ])
  in
  let lines = header :: List.map (fun e -> Json.canonical (entry_json e)) !(j.entries) in
  String.concat "\n" lines ^ "\n"

let of_jsonl text =
  if text = "" || (not (String.ends_with ~suffix:"\n" text)) then
    raise (Json.Parse "journal tail truncated");
  let lines =
    String.split_on_char '\n' text |> List.filter (fun s -> String.trim s <> "")
  in
  match lines with
  | [] -> raise (Json.Parse "empty journal")
  | header :: rest ->
      let h =
        try Json.parse header with
        | Json.Parse _ -> raise (Json.Parse "journal tail truncated")
      in
      let entries =
        List.map
          (fun line ->
            try entry_of_json (Json.parse line) with
            | Json.Parse _ -> raise (Json.Parse "journal tail truncated"))
          rest
      in
      {
        run_id = Json.string_field "run_id" h;
        agent_version = Json.string_field "agent_version" h;
        entries = ref entries;
      }

let commit entry ~attempt result =
  if attempt <> entry.attempt then Error "旧 attempt 没有写入权"
  else
    match entry.status with
    | Done when entry.result = result -> Ok ()
    | Done -> Error "旧 worker 的结果和已记录的不一致"
    | Unknown -> Error "结果未知，不接受写入"
    | Pending ->
        entry.status <- Done;
        entry.result <- result;
        Ok ()

let accept_late entry result =
  match entry.status with
  | Done when entry.result = result -> Ok ()
  | Done -> Error "旧 worker 的结果和已记录的不一致"
  | Unknown -> Error "结果未知，不接受迟到的写入"
  | Pending -> Error "还是 Pending，不接受旧 worker 的迟到结果"

let slim_line (e : entry) =
  Json.canonical
    (Json.Assoc
       [
         ("seq", Json.Int e.seq);
         ("kind", Json.String e.kind);
         ("label", Json.String e.label);
         ("req_hash", Json.String e.req_hash);
         ("req", e.req);
         ("status", status_json e.status);
         ("result", e.result);
         ("idempotency_key", Json.String e.idempotency_key);
         ("attempt", Json.Int e.attempt);
         ("idempotent", Json.Bool e.idempotent);
         ("ts", Json.Int e.ts);
       ])

let slim j = String.concat "\n" (List.map slim_line !(j.entries))

let nth j seq =
  match List.nth_opt !(j.entries) seq with
  | Some e when e.seq = seq -> Some e
  | Some _ -> None
  | None -> None
