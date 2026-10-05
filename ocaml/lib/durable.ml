(** Serial run against the snapshot. External calls are marked dispatched and
    fsynced before the provider runs. The attempt used at commit is the one
    captured before the call, not a fresh read of the entry. *)

module Deep = Effect.Deep

exception Suspend
exception Blocked of string

type stop =
  | Finished of string
  | Suspended
  | Blocked of string

let path_of dir = Filename.concat dir "snapshot.json"
let barrier_of dir = Filename.concat dir "barrier"
let effects_of dir = Filename.concat dir "effects.log"

let note dir name =
  let fd = Unix.openfile (effects_of dir) [ Unix.O_WRONLY; Unix.O_APPEND; Unix.O_CREAT ] 0o644 in
  Fun.protect
    ~finally:(fun () -> Unix.close fd)
    (fun () ->
      let line = name ^ "\n" in
      ignore (Unix.write_substring fd line 0 (String.length line));
      Unix.fsync fd)

let kill_if dir phase =
  let file = barrier_of dir in
  if Sys.file_exists file then
    let text = String.trim (In_channel.with_open_bin file In_channel.input_all) in
    if text = phase then Unix.kill (Unix.getpid ()) Sys.sigkill

let policy = Ocagent_protocol.Policy.name Ocagent_protocol.Policy.Manual_only

let fresh ~run_id seq (type a) (e : a Effect.t) ~recovery ~dispatched =
  let hash = Proto.req_hash e in
  {
    Journal.run_id;
    seq;
    kind = Proto.kind e;
    label = Proto.name e;
    req_hash = hash;
    req = Proto.request_json e;
    status = Journal.Pending;
    result = Json.Null;
    idempotency_key = Printf.sprintf "%s:%d:%s" run_id seq hash;
    attempt = 1;
    idempotent = false;
    dispatched;
    recovery;
    callback_id = "";
    ts = 0;
    last_hit = Journal.Execute;
  }

let append journal entry = journal.Journal.entries := !(journal.entries) @ [ entry ]

type prep =
  | Replay of Json.t
  | Stop of string
  | Call of int

let prepare path dir seq (type a) (e : a Effect.t) =
  let hash = Proto.req_hash e in
  let _, journal = Store.read path in
  match Journal.nth journal seq with
  | Some existing when existing.req_hash <> hash -> Stop (Printf.sprintf "seq %d 请求变了" seq)
  | Some existing when existing.status = Journal.Unknown -> Stop (Printf.sprintf "seq %d 结果未知" seq)
  | Some existing when existing.status = Journal.Done -> Replay existing.result
  | Some existing when existing.dispatched -> Stop (Printf.sprintf "seq %d 结果未知" seq)
  | found ->
      let entry =
        match found with
        | Some existing -> existing
        | None ->
            let created = fresh ~run_id:"proc" seq e ~recovery:policy ~dispatched:true in
            append journal created;
            created
      in
      entry.dispatched <- true;
      entry.recovery <- policy;
      let issued = entry.attempt in
      Store.save path journal;
      kill_if dir "after-dispatch";
      note dir (Proto.kind e);
      Call issued

let commit path dir seq issued json =
  kill_if dir "after-provider";
  match Store.commit_result path seq ~attempt:issued json with
  | Ok () -> ()
  | Error msg -> raise (Blocked msg)

let exec (type a) (e : a Effect.t) (fetch : Proto.fetch_request -> Proto.fetch_reply) : a =
  match e with
  | Proto.Fetch req -> fetch req
  | Proto.Llm _ -> { Proto.text = "plan"; tool = None }
  | _ -> raise (Blocked "没有 provider")

let run ~dir ~fetch agent =
  let path = path_of dir in
  let (_ : Journal.t) = Store.open_run path ~run_id:"proc" ~agent_version:"durable-1" in
  let cursor = ref 0 in
  let next () =
    let seq = !cursor in
    incr cursor;
    seq
  in
  match
    Deep.try_with agent ()
      {
        effc =
          (fun (type a) (e : a Effect.t) ->
            match e with
            | Proto.Llm _ | Proto.Fetch _ ->
                Some
                  (fun k ->
                    let seq = next () in
                    match prepare path dir seq e with
                    | Stop msg -> raise (Blocked msg)
                    | Replay json -> Deep.continue k (Proto.decode_result e json)
                    | Call issued ->
                        let value = exec e fetch in
                        commit path dir seq issued (Proto.encode_result e value);
                        Deep.continue k value)
            | Proto.Ask_human _ ->
                Some
                  (fun k ->
                    let seq = next () in
                    let hash = Proto.req_hash e in
                    let _, journal = Store.read path in
                    match Journal.nth journal seq with
                    | Some existing when existing.req_hash <> hash -> raise (Blocked "审批请求变了")
                    | Some existing when existing.status = Journal.Done ->
                        Deep.continue k (Proto.decode_result e existing.result)
                    | Some existing when existing.status = Journal.Pending -> raise Suspend
                    | Some _ -> raise (Blocked "审批状态不能恢复")
                    | None ->
                        let entry = fresh ~run_id:"proc" seq e ~recovery:"AwaitingApproval" ~dispatched:false in
                        append journal entry;
                        Store.save path journal;
                        raise Suspend)
            | _ -> None);
      }
  with
  | value -> Finished value
  | exception Suspend -> Suspended
  | exception Blocked msg -> Blocked msg
