(** Run one admitted step from its saved bytecode. A completed record is returned
    without a compiler, a toolchain snapshot, or a worker. *)

type outcome =
  | Completed of { reply : Step_manifest.reply; workspace : string }
  | Awaiting_approval

type error =
  | Unavailable of string
  | Rejected of string
  | Store of Store.error
  | Blocked of string

let describe = function
  | Unavailable msg -> msg
  | Rejected msg -> msg
  | Store err -> Store.describe err
  | Blocked msg -> msg

let barrier path phase =
  let file = Filename.concat (Filename.dirname path) "barrier" in
  if Sys.file_exists file then
    let text = String.trim (In_channel.with_open_bin file In_channel.input_all) in
    if text = phase then Unix.kill (Unix.getpid ()) Sys.sigkill
    else if text = "pause:" ^ phase then
      let until = Step_sandbox.monotonic () +. 12. in
      let rec wait () =
        if Step_sandbox.monotonic () >= until then ()
        else
          let now = try String.trim (In_channel.with_open_bin file In_channel.input_all) with _ -> "" in
          if now <> "pause:" ^ phase then ()
          else (
            Unix.sleepf 0.02;
            wait ())
      in
      wait ()

let note_worker () =
  match Sys.getenv_opt "OCAGENT_WORKER_LOG" with
  | None -> ()
  | Some path ->
      let fd = Unix.openfile path [ Unix.O_WRONLY; Unix.O_APPEND; Unix.O_CREAT; Unix.O_CLOEXEC ] 0o644 in
      Fun.protect
        ~finally:(fun () -> Unix.close fd)
        (fun () ->
          let line = "worker\n" in
          ignore (Unix.write_substring fd line 0 (String.length line));
          Unix.fsync fd)

let note_pid pid =
  match Sys.getenv_opt "OCAGENT_WORKER_PID" with
  | None | Some "" -> ()
  | Some file ->
      let oc = open_out file in
      output_string oc (string_of_int pid);
      close_out oc

let note_stop line =
  match Sys.getenv_opt "OCAGENT_STOP_FILE" with
  | None | Some "" -> ()
  | Some path ->
      let fd = Unix.openfile path [ Unix.O_WRONLY; Unix.O_APPEND; Unix.O_CREAT; Unix.O_CLOEXEC ] 0o644 in
      Fun.protect
        ~finally:(fun () -> Unix.close fd)
        (fun () ->
          let line = line ^ "\n" in
          ignore (Unix.write_substring fd line 0 (String.length line));
          Unix.fsync fd)

let fetch_params url =
  Json.Assoc
    [
      ("body", Json.String "");
      ("headers", Json.List []);
      ("method", Json.String "GET");
      ("redirect", Json.String "error");
      ("timeout_s", Json.Int Step_ipc.worker_limits.timeout_s);
      ("url", Json.String url);
    ]

let params_hash url = Step_manifest.sha256 (Json.canonical (fetch_params url))

let decision_of json =
  match json with
  | Json.Assoc fields -> (
      match (List.assoc_opt "tag" fields, List.assoc_opt "reason" fields) with
      | Some (Json.String "Approved"), None when List.length fields = 1 -> Ok `Approved
      | Some (Json.String "Rejected"), Some (Json.String reason) when reason <> "" && List.length fields = 2 -> Ok (`Rejected reason)
      | _ -> Error (Store.Protocol "decision"))
  | _ -> Error (Store.Protocol "decision")

let manifest_reply = function
  | Step_ipc.Continue text -> Step_manifest.Continue text
  | Step_ipc.Done text -> Step_manifest.Done text
  | Step_ipc.Ask text -> Step_manifest.Ask text
  | Step_ipc.Partial text -> Step_manifest.Partial text

(* Validate the complete message before committing an external result. A result
   fitting in the journal may still overflow its IPC envelope or fail its codec. *)
let checked_return request_id result =
  let frame = Step_ipc.Return { version = 1; request_id; result } in
  match Step_ipc.encode_frame frame with
  | Error _ as err -> err
  | Ok text -> (
      match Step_ipc.decode_frame text with
      | Ok decoded when decoded = frame -> Ok frame
      | Ok _ -> Error "return round trip"
      | Error _ as err -> err)

let wait_fd sock mode deadline =
  if Step_sandbox.monotonic () >= deadline then failwith "deadline"
  else
    let timeout = max 0. (deadline -. Step_sandbox.monotonic ()) in
    let read = if mode = `Read then [ sock ] else [] in
    let write = if mode = `Write then [ sock ] else [] in
    match Unix.select read write [] timeout with
    | [], [], _ -> failwith "deadline"
    | _ -> (
        match Unix.getsockopt_error sock with
        | None -> ()
        | Some err -> raise (Unix.Unix_error (err, "socket", "")))

let http_get ~deadline url =
  if Step_sandbox.monotonic () >= deadline then failwith "deadline";
  let rest = String.sub url 7 (String.length url - 7) in
  let colon = String.index rest ':' in
  let slash = String.index rest '/' in
  let port = int_of_string (String.sub rest (colon + 1) (slash - colon - 1)) in
  let path = String.sub rest slash (String.length rest - slash) in
  if path <> "/spec" then failwith "target"
  else
    let sock = Unix.socket Unix.PF_INET Unix.SOCK_STREAM 0 in
    Unix.set_nonblock sock;
    Fun.protect
      ~finally:(fun () -> Unix.close sock)
      (fun () ->
        (try Unix.connect sock (Unix.ADDR_INET (Unix.inet_addr_loopback, port)) with
        | Unix.Unix_error ((Unix.EINPROGRESS | Unix.EAGAIN | Unix.EWOULDBLOCK), _, _) -> wait_fd sock `Write deadline
        | Unix.Unix_error (Unix.EISCONN, _, _) -> ());
        let req = Printf.sprintf "GET %s HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n" path in
        let rec write_all off len =
          if len > 0 then
            match Unix.write_substring sock req off len with
            | exception Unix.Unix_error (Unix.EINTR, _, _) -> write_all off len
            | exception Unix.Unix_error ((Unix.EAGAIN | Unix.EWOULDBLOCK), _, _) ->
                wait_fd sock `Write deadline;
                write_all off len
            | n -> write_all (off + n) (len - n)
        in
        write_all 0 (String.length req);
        let buf = Buffer.create 128 in
        let tmp = Bytes.create 512 in
        let rec read () =
          if Buffer.length buf > Step_ipc.max_frame then failwith "response";
          match Unix.read sock tmp 0 512 with
          | exception Unix.Unix_error (Unix.EINTR, _, _) -> read ()
          | exception Unix.Unix_error ((Unix.EAGAIN | Unix.EWOULDBLOCK), _, _) ->
              wait_fd sock `Read deadline;
              read ()
          | exception Unix.Unix_error (Unix.ECONNRESET, _, _) -> ()
          | 0 -> ()
          | n ->
              Buffer.add_subbytes buf tmp 0 n;
              if Buffer.length buf > Step_ipc.max_frame then failwith "response";
              read ()
        in
        read ();
        let raw = Buffer.contents buf in
        let marker = "\r\n\r\n" in
        let body =
          let rec find i =
            if i + 4 > String.length raw then raw
            else if String.sub raw i 4 = marker then String.sub raw (i + 4) (String.length raw - i - 4)
            else find (i + 1)
          in
          find 0
        in
        let status = try int_of_string (String.sub raw (String.index raw ' ' + 1) 3) with _ -> 0 in
        (status, body))

let stored record =
  match (record.Step_manifest.reply, record.final_workspace) with
  | Some reply, Some workspace -> Ok (Completed { reply; workspace })
  | _ -> Error (Store (Store.Corrupt_snapshot "completion"))

let private_artifact bytecode =
  let root = Filename.temp_dir "ocagent-run" "" in
  let art = Filename.concat root "artifact" in
  Unix.mkdir art 0o755;
  let path = Filename.concat art "worker" in
  let fd = Unix.openfile path [ Unix.O_WRONLY; Unix.O_CREAT; Unix.O_EXCL ] 0o444 in
  Fun.protect
    ~finally:(fun () -> Unix.close fd)
    (fun () ->
      let rec go off =
        if off < String.length bytecode then
          let n = Unix.write_substring fd bytecode off (String.length bytecode - off) in
          go (off + n)
      in
      go 0);
  Unix.chmod path 0o444;
  (root, art, path)

let remove_tree root =
  let rec walk dir =
    Array.iter
      (fun name ->
        let path = Filename.concat dir name in
        if Sys.is_directory path then walk path else (try Sys.remove path with _ -> ()))
      (Sys.readdir dir);
    (try Unix.rmdir dir with _ -> ())
  in
  if Sys.file_exists root then walk root

let drive ~deadline ~path ~execution_hash ~allowed_url ~workspace_hash ~input ~tools ~art ~binary ~root executor =
  let attempt_deadline = deadline in
  let now = Step_sandbox.monotonic in
  let stop_grace = ref 0. in
  let stdout_path = Filename.concat root "stdout" in
  let stderr_path = Filename.concat root "stderr" in
  let argv, env = Step_compile.runtime_argv tools ~bytecode:binary in
  let marker = Filename.concat root ".exec-marker" in
  let diag msg =
    let tail path =
      if not (Sys.file_exists path) then ""
      else
        let text = String.trim (In_channel.with_open_bin path In_channel.input_all) in
        if String.length text > 400 then String.sub text (String.length text - 400) 400 else text
    in
    let err = tail stderr_path in
    let out = tail stdout_path in
    match (err, out) with
    | "", "" -> msg
    | _, _ -> msg ^ " stderr=" ^ err ^ " stdout=" ^ out
  in
  let give_up msg =
    let reason = diag msg in
    match Store.fail_step executor ~reason with
    | Ok () -> Error (Store.Protocol reason)
    | Error Store.Unknown_result -> Error Store.Unknown_result
    | Error err -> Error err
  in
  match
    Step_sandbox.spawn ~deadline:attempt_deadline ~snap:(Step_compile.toolchain_root tools) ~artifact:art ~stdout_path ~stderr_path
      (Step_sandbox.Exec { argv; env; marker })
  with
  | Error (Step_sandbox.Unavailable msg) -> give_up msg
  | Error (Step_sandbox.Rejected msg) -> give_up msg
  | Ok launch ->
      note_pid launch.worker;
      Fun.protect
        ~finally:(fun () ->
          let messages, how = Step_sandbox.release ~grace:!stop_grace launch in
          List.iter note_stop messages;
          if !stop_grace > 0. then
            let status =
              match how with
              | `Exited code -> "exit " ^ string_of_int code
              | `Signaled signal -> "signal " ^ string_of_int signal
              | `Killed -> "killed"
            in
            note_stop status)
        (fun () ->
          let ipc = launch.ipc in
          let write_msg frame = Step_ipc.write_frame ~now ipc frame attempt_deadline in
          let read_msg () = Step_ipc.read_frame ~now ipc attempt_deadline in
          let session = ref Step_ipc.session_start in
          let traced = ref 0 in
          let cursor = ref 0 in
          let take () =
            let n = !cursor in
            incr cursor;
            n
          in
          let over_log () =
            let logs =
              (try (Unix.stat stdout_path).st_size with _ -> 0)
              + (try (Unix.stat stderr_path).st_size with _ -> 0)
              + !traced
            in
            logs > Step_ipc.worker_limits.log_bytes
          in
          let fail_closed reason =
            ignore (write_msg (Step_ipc.Stop { version = 1; code = reason }));
            give_up reason
          in
          let rec loop () =
            if now () >= attempt_deadline then fail_closed "timeout"
            else if over_log () then fail_closed "log"
            else
              match read_msg () with
              | Error msg -> fail_closed msg
              | Ok frame -> (
                  match Step_ipc.on_worker !session frame with
                  | Error _ -> fail_closed "protocol"
                  | Ok next ->
                      session := next;
                      match frame with
                      | Step_ipc.Ready _ ->
                          note_worker ();
                          loop ()
                      | Step_ipc.Trace { message; _ } ->
                          traced := !traced + String.length message;
                          loop ()
                      | Step_ipc.Call { request_id; url; _ } -> call request_id url
                      | Step_ipc.Finished { reply; _ } -> finish reply
                      | _ -> fail_closed "protocol")
          and call request_id url =
            if url <> allowed_url then fail_closed "url"
            else
              let req = fetch_params url in
              let hash = params_hash url in
              match
                Durable_dispatch.dispatch ~path executor
                  {
                    Store.seq = take ();
                    kind = "Ask_human";
                    label = "Net.get";
                    req_hash = hash;
                    req;
                    recovery = "AwaitingApproval";
                    approval = true;
                  }
                  ~after_prepare:(fun () -> ())
                  ~provider:(fun () -> failwith "approval")
              with
              | Error (Durable_dispatch.Store err) -> Error err
              | Error Durable_dispatch.In_flight -> Error Store.Unknown_result
              | Error (Durable_dispatch.Raised _) -> Error (Store.Protocol "approval")
              | Ok Durable_dispatch.Suspended ->
                  barrier path "after-approval-save";
                  barrier path "before-stop";
                  (match write_msg (Step_ipc.Stop { version = 1; code = "approval" }) with
                  | Ok () ->
                      stop_grace := min 1. (max 0. (attempt_deadline -. now ()));
                      Ok Awaiting_approval
                  | Error _ -> Error (Store.Protocol "stop"))
              | Ok (Durable_dispatch.Value decision) -> (
                  match decision_of decision with
                  | Error err -> Error err
                  | Ok `Approved -> fetch request_id url hash
                  | Ok (`Rejected reason) -> reply request_id (Step_ipc.Rejected reason))
          and fetch request_id url hash =
            match
              Durable_dispatch.dispatch ~path executor
                {
                  Store.seq = take ();
                  kind = "Fetch";
                  label = "Net.get";
                  req_hash = hash;
                  req = fetch_params url;
                  recovery = "Manual_only";
                  approval = false;
                }
                ~after_prepare:(fun () -> barrier path "after-dispatch")
                ~provider:(fun () ->
                  let status, body = http_get ~deadline:attempt_deadline url in
                  barrier path "after-provider";
                  let json = Json.Assoc [ ("body", Json.String body); ("status", Json.Int status) ] in
                  if String.length (Json.canonical json) > Step_ipc.max_frame then failwith "response";
                  (match checked_return request_id (Step_ipc.Http { status; body }) with
                  | Ok _ -> ()
                  | Error msg -> failwith ("return " ^ msg));
                  json)
            with
            | Error Durable_dispatch.In_flight -> Error Store.Unknown_result
            | Error (Durable_dispatch.Store err) -> Error err
            | Error (Durable_dispatch.Raised _) -> Error Store.Unknown_result
            | Ok Durable_dispatch.Suspended -> Error (Store.Protocol "fetch")
            | Ok (Durable_dispatch.Value json) -> (
                barrier path "after-done";
                match json with
                | Json.Assoc fields -> (
                    match (List.assoc_opt "status" fields, List.assoc_opt "body" fields) with
                    | Some (Json.Int status), Some (Json.String body) -> reply request_id (Step_ipc.Http { status; body })
                    | _ -> fail_closed "codec")
                | _ -> fail_closed "codec")
          and reply request_id result =
            barrier path "before-return";
            match
              match checked_return request_id result with
              | Error _ as err -> err
              | Ok frame -> write_msg frame
            with
            | Error _ -> Error (Store.Protocol "return")
            | Ok () -> (
                match Step_ipc.after_return !session request_id with
                | Error _ -> fail_closed "protocol"
                | Ok next ->
                    session := next;
                    loop ())
          and finish reply =
            barrier path "before-complete";
            match Store.complete_step executor ~cursor:!cursor ~reply:(manifest_reply reply) ~workspace_hash with
            | Error err -> Error err
            | Ok () ->
                barrier path "after-complete";
                Ok (Completed { reply = manifest_reply reply; workspace = workspace_hash })
          in
          match write_msg
              (Step_ipc.Init
                 { version = 1; execution_hash; bound_input = input; limits = Step_ipc.worker_limits })
          with
          | Error msg -> fail_closed msg
          | Ok () -> loop ())

let query ~path ~execution_hash =
  match Store.read_snapshot path with
  | Error err -> Error (Store err)
  | Ok snap -> (
      match snap.step with
      | Some record when record.manifest.execution_hash = execution_hash && record.state = Step_manifest.Completed -> (
          match stored record with
          | Ok (Completed payload) -> Ok (payload.reply, payload.workspace)
          | Ok Awaiting_approval -> Error (Rejected "not completed")
          | Error _ as err -> err)
      | Some record when record.manifest.execution_hash <> execution_hash -> Error (Store Store.Manifest_mismatch)
      | Some _ -> Error (Rejected "not completed")
      | None -> Error (Store Store.Version_unavailable))

let run_within ~timeout_s ~path ~execution_hash ~allowed_url =
  Sys.set_signal Sys.sigpipe Sys.Signal_ignore;
  match Store.read_snapshot path with
  | Error err -> Error (Store err)
  | Ok snap -> (
      match snap.step with
      | None -> Error (Store Store.Version_unavailable)
      | Some record when record.manifest.execution_hash <> execution_hash -> Error (Store Store.Manifest_mismatch)
      | Some record when record.state = Step_manifest.Completed -> stored record
      | Some record when record.manifest.policy_version <> Step_compile.policy_version -> Error (Store Store.Version_unavailable)
      | Some record -> (
          match Store.read_blob ~path ~hash:record.manifest.input_context_hash ~kind:Store.Text with
          | Error err -> Error (Store err)
          | Ok input_text -> (
              match Step_ipc.parse_input input_text with
              | Error _ -> Error (Rejected "input")
              | Ok input -> (
                  match
                    Step_ipc.encode_frame
                      (Step_ipc.Init
                         {
                           version = 1;
                           execution_hash = record.manifest.execution_hash;
                           bound_input = input;
                           limits = Step_ipc.worker_limits;
                         })
                  with
                  | Error _ -> Error (Rejected "init")
                  | Ok _ -> (
                      match Step_compile.hold_toolchain ~deadline:(Unix.gettimeofday () +. 25.) with
                      | Error (Step_compile.Unavailable msg) -> Error (Unavailable msg)
                      | Error (Step_compile.Rejected msg) -> Error (Rejected msg)
                      | Error (Step_compile.Store err) -> Error (Store err)
                      | Ok tools ->
                          Fun.protect
                            ~finally:(fun () -> Step_compile.release tools)
                            (fun () ->
                              let compiler_id, runtime_id = Step_compile.identity tools in
                              match Store.preflight ~path ~execution_hash ~compiler_id ~runtime_id with
                              | Error err -> Error (Store err)
                              | Ok (Store.Stored { reply; workspace }) -> Ok (Completed { reply; workspace })
                              | Ok Store.Ready -> (
                                  match Store.read_blob ~path ~hash:record.manifest.artifact_hash ~kind:Store.Artifact with
                                  | Error err -> Error (Store err)
                                  | Ok bytecode -> (
                                      let deadline = Step_sandbox.monotonic () +. float timeout_s in
                                      let root, art, binary = private_artifact bytecode in
                                      Fun.protect
                                        ~finally:(fun () -> remove_tree root)
                                        (fun () ->
                                          match
                                            Step_sandbox.mount_available ~deadline ~snap:(Step_compile.toolchain_root tools)
                                              ~artifact:art
                                          with
                                          | Error (Step_sandbox.Unavailable msg) -> Error (Unavailable msg)
                                          | Error (Step_sandbox.Rejected msg) -> Error (Rejected msg)
                                          | Ok () -> (
                                              match
                                                Store.with_step_executor ~path ~execution_hash (fun executor ->
                                                    drive ~deadline ~path ~execution_hash ~allowed_url
                                                      ~workspace_hash:record.manifest.base_workspace_hash ~input ~tools ~art
                                                      ~binary ~root executor)
                                              with
                                              | Error err -> Error (Store err)
                                              | Ok (Store.Stored_completion { reply; workspace }) -> Ok (Completed { reply; workspace })
                                              | Ok (Store.Resumed outcome) -> Ok outcome))))))))))

let run ~path ~execution_hash ~allowed_url =
  run_within ~timeout_s:Step_ipc.worker_limits.timeout_s ~path ~execution_hash ~allowed_url

let approve = Store.approve_step
