(** One executor for the life of [run]. Prepare and commit take the store lock
    only around the snapshot. The provider runs after that lock is released. *)

module Deep = Effect.Deep

type stop =
  | Finished of string
  | Suspended
  | Blocked of string

exception Halt of stop

let path_of dir = Filename.concat dir "snapshot.json"
let barrier_of dir = Filename.concat dir "barrier"
let effects_of dir = Filename.concat dir "effects.log"

let note dir name =
  let fd = Unix.openfile (effects_of dir) [ Unix.O_WRONLY; Unix.O_APPEND; Unix.O_CREAT; Unix.O_CLOEXEC ] 0o644 in
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

let manual = Ocagent_protocol.Policy.name Ocagent_protocol.Policy.Manual_only

let exec (type a) (e : a Effect.t) (fetch : Proto.fetch_request -> Proto.fetch_reply) : a =
  match e with
  | Proto.Fetch req -> fetch req
  | Proto.Llm _ -> { Proto.text = "plan"; tool = None }
  | _ -> raise (Halt (Blocked "没有 provider"))

let request (type a) (e : a Effect.t) seq ~approval =
  {
    Store.seq;
    kind = Proto.kind e;
    label = Proto.name e;
    req_hash = Proto.req_hash e;
    req = Proto.request_json e;
    recovery = (if approval then "AwaitingApproval" else manual);
    approval;
  }

let run ~dir ~run_id ~agent_version ~fetch agent =
  let path = path_of dir in
  let outcome =
    Store.with_executor ~path ~run_id ~agent_version (fun executor ->
        let cursor = ref 0 in
        let next () =
          let seq = !cursor in
          incr cursor;
          seq
        in
        let stop =
          match
            Effect.Deep.try_with agent ()
              {
                effc =
                  (fun (type a) (e : a Effect.t) ->
                    match e with
                    | Proto.Llm _ | Proto.Fetch _ ->
                        Some
                          (fun k ->
                            let decision =
                              try
                                let seq = next () in
                                match Store.prepare_operation executor (request e seq ~approval:false) with
                                | Error err -> Error (Blocked (Store.describe err))
                                | Ok (Store.Replay json) -> Ok (Proto.decode_result e json)
                                | Ok Store.Awaiting_approval -> Error (Blocked "不是审批")
                                | Ok Store.In_flight -> Error (Blocked "In_flight")
                                | Ok (Store.Execute issued) ->
                                    kill_if dir "after-dispatch";
                                    note dir (Proto.kind e);
                                    let value = exec e fetch in
                                    kill_if dir "after-provider";
                                    (match Store.commit_result path issued (Proto.encode_result e value) with
                                    | Error err -> Error (Blocked (Store.describe err))
                                    | Ok () -> Ok value)
                              with
                              | Halt stop -> Error stop
                              | exn -> Error (Blocked (Printexc.to_string exn))
                            in
                            match decision with
                            | Error stop -> Deep.discontinue k (Halt stop)
                            | Ok value -> Deep.continue k value)
                    | Proto.Ask_human _ ->
                        Some
                          (fun k ->
                            let decision =
                              try
                                let seq = next () in
                                match Store.prepare_operation executor (request e seq ~approval:true) with
                                | Ok Store.Awaiting_approval -> Error Suspended
                                | Ok (Store.Replay json) -> Ok (Proto.decode_result e json)
                                | Ok (Store.Execute _) | Ok Store.In_flight -> Error (Blocked "审批不能派发")
                                | Error err -> Error (Blocked (Store.describe err))
                              with
                              | Halt stop -> Error stop
                              | exn -> Error (Blocked (Printexc.to_string exn))
                            in
                            match decision with
                            | Error stop -> Deep.discontinue k (Halt stop)
                            | Ok value -> Deep.continue k value)
                    | _ -> None);
              }
          with
          | value -> (
              match Store.tail_check executor !cursor with
              | Ok () -> Finished value
              | Error err -> Blocked (Store.describe err))
          | exception Halt stop -> stop
        in
        Ok stop)
  in
  match outcome with
  | Ok stop -> stop
  | Error err -> Blocked (Store.describe err)
