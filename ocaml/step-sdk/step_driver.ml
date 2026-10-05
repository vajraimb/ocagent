(* Trusted entry. The coordinator owns the store; this process only speaks IPC on fd 3. *)

module Deep = Effect.Deep

external fd_of_int : int -> Unix.file_descr = "%identity"

let ipc = fd_of_int 3

let policy =
  {
    Step_ipc.timeout_s = 20;
    as_bytes = 268435456;
    log_bytes = 1048576;
    tmp_bytes = 1048576;
  }

let die msg =
  Printf.eprintf "driver: %s\n%!" msg;
  exit 2

let () =
  ignore policy;
  (try Unix.clear_nonblock ipc with Unix.Unix_error (err, _, _) -> die (Unix.error_message err));
  let deadline = Unix.gettimeofday () +. 20. in
  match Step_ipc.read_frame ipc deadline with
  | Error msg -> die msg
  | Ok (Step_ipc.Init { version = 1; bound_input; _ }) -> (
      Step_bridge.install bound_input;
      Step_bridge.set_trace (fun message ->
          match Step_ipc.write_frame ipc (Step_ipc.Trace { version = 1; message }) deadline with
          | Ok () -> ()
          | Error msg -> die msg);
      if Step_ipc.write_frame ipc (Step_ipc.Ready { version = 1 }) deadline <> Ok () then die "ready";
      let next = ref 1 in
      let stop = ref false in
      let on_net k url =
        if !stop then Deep.discontinue k Exit
        else
          let request_id = !next in
          incr next;
          match
            Step_ipc.write_frame ipc (Step_ipc.Call { version = 1; request_id; method_ = "Net.get"; url }) deadline
          with
          | Error _ ->
              stop := true;
              Deep.discontinue k Exit
          | Ok () -> (
              match Step_ipc.read_frame ipc deadline with
              | Ok (Step_ipc.Return { request_id = id; result; _ }) when id = request_id ->
                  let value =
                    match result with
                    | Step_ipc.Http { status; body } -> Ok { Step_bridge.status; body }
                    | Step_ipc.Rejected reason -> Error (Step_bridge.Approval_rejected reason)
                    | Step_ipc.Denied reason -> Error (Step_bridge.Denied reason)
                  in
                  Deep.continue k value
              | Ok (Step_ipc.Stop _) | Error _ | Ok _ ->
                  stop := true;
                  Deep.discontinue k Exit)
      in
      let effc : type a. a Effect.t -> ((a, Step_api.reply) Deep.continuation -> Step_api.reply) option = function
        | Step_bridge.Net_get url -> Some (fun k -> on_net k url)
        | _ -> None
      in
      let reply = Deep.try_with (fun () -> Step.Step.run ()) () { effc } in
      if !stop then die "stopped";
      let reply =
        match reply with
        | Step_api.Continue text -> Step_ipc.Continue text
        | Step_api.Done text -> Step_ipc.Done text
        | Step_api.Ask text -> Step_ipc.Ask text
        | Step_api.Partial text -> Step_ipc.Partial text
      in
      match Step_ipc.write_frame ipc (Step_ipc.Finished { version = 1; reply }) deadline with
      | Ok () -> exit 0
      | Error _ -> die "finished")
  | Ok _ -> die "handshake"
