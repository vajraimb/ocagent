(** Snapshot transactions. The executor lock is the life of one [Durable.run].
    The store lock covers a single read, check, and commit. Provider calls sit
    outside both. *)

exception Corrupt of string

type error =
  | Already_running
  | Run_mismatch
  | Version_mismatch
  | Revision_conflict
  | Stale_attempt
  | Unknown_result
  | Request_changed
  | Replay_incomplete
  | Approval_conflict
  | Bad_decision of string
  | Corrupt_snapshot of string
  | Protocol of string
  | Manifest_mismatch
  | Version_unavailable
  | Artifact_missing
  | Artifact_corrupt
  | Admission_conflict
  | Multiple_steps_unsupported
  | Unsupported_capability

let describe = function
  | Already_running -> "Already_running"
  | Run_mismatch -> "Run_mismatch"
  | Version_mismatch -> "Version_mismatch"
  | Revision_conflict -> "Revision_conflict"
  | Stale_attempt -> "Stale_attempt"
  | Unknown_result -> "结果未知"
  | Request_changed -> "Request_changed"
  | Replay_incomplete -> "Replay_incomplete"
  | Approval_conflict -> "Approval_conflict"
  | Bad_decision msg -> "Bad_decision " ^ msg
  | Corrupt_snapshot msg -> "Corrupt_snapshot " ^ msg
  | Protocol msg -> "Protocol " ^ msg
  | Manifest_mismatch -> "Manifest_mismatch"
  | Version_unavailable -> "Version_unavailable"
  | Artifact_missing -> "Artifact_missing"
  | Artifact_corrupt -> "Artifact_corrupt"
  | Admission_conflict -> "Admission_conflict"
  | Multiple_steps_unsupported -> "Multiple_steps_unsupported"
  | Unsupported_capability -> "Unsupported_capability"

type executor = {
  path : string;
  run_id : string;
  agent_version : string;
  epoch : int;
  execution_hash : string option;
  step_id : string option;
}

type issued = {
  run_id : string;
  agent_version : string;
  seq : int;
  request_hash : string;
  issued_attempt : int;
  execution_hash : string option;
  step_id : string option;
}

type operation_request = {
  seq : int;
  kind : string;
  label : string;
  req_hash : string;
  req : Json.t;
  recovery : string;
  approval : bool;
}

type prepare_result =
  | Replay of Json.t
  | Awaiting_approval
  | Execute of issued
  | In_flight

type snapshot = {
  revision : int;
  epoch : int;
  journal : Journal.t;
  step : Step_manifest.record option;
}

let epoch (executor : executor) = executor.epoch

let export_issued issued =
  match (issued.execution_hash, issued.step_id) with
  | None, None ->
      String.concat "\n"
        [
          issued.run_id;
          issued.agent_version;
          string_of_int issued.seq;
          issued.request_hash;
          string_of_int issued.issued_attempt;
        ]
  | Some execution_hash, Some step_id ->
      String.concat "\n"
        [
          issued.run_id;
          issued.agent_version;
          string_of_int issued.seq;
          issued.request_hash;
          string_of_int issued.issued_attempt;
          execution_hash;
          step_id;
        ]
  | _ -> raise (Corrupt "issued scope")

let import_issued text =
  match String.split_on_char '\n' text with
  | [ run_id; agent_version; seq; request_hash; attempt ] -> (
      try
        Ok
          {
            run_id;
            agent_version;
            seq = int_of_string seq;
            request_hash;
            issued_attempt = int_of_string attempt;
            execution_hash = None;
            step_id = None;
          }
      with Failure _ -> Error (Protocol "issued"))
  | [ run_id; agent_version; seq; request_hash; attempt; execution_hash; step_id ] -> (
      try
        Ok
          {
            run_id;
            agent_version;
            seq = int_of_string seq;
            request_hash;
            issued_attempt = int_of_string attempt;
            execution_hash = Some execution_hash;
            step_id = Some step_id;
          }
      with Failure _ -> Error (Protocol "issued"))
  | _ -> Error (Protocol "issued")

let lock_path path = path ^ ".lock"
let executor_path path = path ^ ".executor"

let canonical path =
  let dir = Filename.dirname path in
  let base = Filename.basename path in
  let dir = if Sys.file_exists dir then Unix.realpath dir else dir in
  Filename.concat dir base

let registry_mu = Mutex.create ()
let registry : (string, unit) Hashtbl.t = Hashtbl.create 16
let store_mus_mu = Mutex.create ()
let store_mus : (string, Mutex.t) Hashtbl.t = Hashtbl.create 16

let try_acquire key =
  Mutex.lock registry_mu;
  let free = not (Hashtbl.mem registry key) in
  if free then Hashtbl.add registry key ();
  Mutex.unlock registry_mu;
  free

let release_key key =
  Mutex.lock registry_mu;
  Hashtbl.remove registry key;
  Mutex.unlock registry_mu

let store_mutex path =
  let key = canonical path in
  Mutex.lock store_mus_mu;
  let mu =
    match Hashtbl.find_opt store_mus key with
    | Some mu -> mu
    | None ->
        let mu = Mutex.create () in
        Hashtbl.add store_mus key mu;
        mu
  in
  Mutex.unlock store_mus_mu;
  mu

let read_file path =
  let ic = open_in_bin path in
  Fun.protect ~finally:(fun () -> close_in ic) (fun () -> really_input_string ic (in_channel_length ic))

let checksum text =
  let acc = ref 0 in
  String.iter (fun c -> acc := (!acc * 131 + Char.code c) land 0x3fffffff) text;
  Printf.sprintf "%08x" !acc

let tmp_seq = ref 0

let write_atomic path text =
  incr tmp_seq;
  let tmp = Printf.sprintf "%s.%d.%d.tmp" path (Unix.getpid ()) !tmp_seq in
  let fd = Unix.openfile tmp [ Unix.O_WRONLY; Unix.O_CREAT; Unix.O_EXCL; Unix.O_CLOEXEC ] 0o600 in
  Fun.protect
    ~finally:(fun () -> Unix.close fd)
    (fun () ->
      let rec write_all off =
        if off < String.length text then
          let n = Unix.write_substring fd text off (String.length text - off) in
          if n <= 0 then raise (Corrupt "snapshot write failed") else write_all (off + n)
      in
      write_all 0;
      Unix.fsync fd);
  Unix.rename tmp path;
  let dirfd = Unix.openfile (Filename.dirname path) [ Unix.O_RDONLY; Unix.O_CLOEXEC ] 0 in
  Fun.protect ~finally:(fun () -> Unix.close dirfd) (fun () -> Unix.fsync dirfd)

let render snap =
  let body = Journal.to_jsonl snap.journal in
  let records = List.length !(snap.journal.entries) in
  match snap.step with
  | None ->
      let sum = checksum body in
      Printf.sprintf "OCAGENT 2\nrevision %d\nrecords %d\nepoch %d\nchecksum %s\n%s" snap.revision records snap.epoch sum body
  | Some step ->
      let raw =
        match Step_manifest.canonical_record step with
        | Ok raw -> raw
        | Error err -> raise (Corrupt (Step_manifest.describe err))
      in
      let payload = raw ^ body in
      let sum = checksum payload in
      Printf.sprintf "OCAGENT 3\nrevision %d\nrecords %d\nepoch %d\nstep_bytes %d\nchecksum %s\n%s" snap.revision records snap.epoch
        (String.length raw) sum payload

let header_line text i =
  try
    let j = String.index_from text i '\n' in
    (String.sub text i (j - i), j + 1)
  with Not_found -> raise (Corrupt "snapshot header")

let parse text =
  let magic, i1 = header_line text 0 in
  let rev_line, i2 = header_line text i1 in
  let rec_line, i3 = header_line text i2 in
  let epoch_line, i4 = header_line text i3 in
  let scan fmt line what =
    try Scanf.sscanf line fmt (fun n -> n) with Scanf.Scan_failure _ | End_of_file -> raise (Corrupt what)
  in
  let revision = scan "revision %d" rev_line "revision" in
  let records = scan "records %d" rec_line "records" in
  let epoch = scan "epoch %d" epoch_line "epoch" in
  let finish body step =
    let journal = try Journal.of_jsonl body with Json.Parse msg -> raise (Corrupt msg) in
    if List.length !(journal.entries) <> records then raise (Corrupt "record count");
    (match step with
    | None -> ()
    | Some record ->
        let manifest = record.Step_manifest.manifest in
        let entries = !(journal.entries) in
        let rec seq_ok i = function
          | [] -> true
          | entry :: rest ->
              entry.Journal.seq = i && entry.run_id = journal.run_id && seq_ok (i + 1) rest
        in
        let open_entry entry = entry.Journal.status <> Journal.Done in
        if manifest.run_id <> journal.run_id || manifest.step_id = "" || manifest.step_seq <> 0 then
          raise (Corrupt "step identity")
        else if not (seq_ok 0 entries) then raise (Corrupt "journal seq")
        else if record.state = Step_manifest.Completed && List.exists open_entry entries then
          raise (Corrupt "completion"));
    { revision; epoch; journal; step }
  in
  if magic = "OCAGENT 2" then (
    let sum_line, i5 = header_line text i4 in
    let sum = scan "checksum %s" sum_line "checksum" in
    let body = String.sub text i5 (String.length text - i5) in
    if checksum body <> sum then raise (Corrupt "checksum mismatch");
    finish body None)
  else if magic = "OCAGENT 3" then (
    let len_line, i5 = header_line text i4 in
    let sum_line, i6 = header_line text i5 in
    let step_len = scan "step_bytes %d" len_line "step_bytes" in
    let sum = scan "checksum %s" sum_line "checksum" in
    if step_len < 0 || i6 + step_len > String.length text then raise (Corrupt "step");
    let raw = String.sub text i6 step_len in
    let body = String.sub text (i6 + step_len) (String.length text - i6 - step_len) in
    if checksum (raw ^ body) <> sum then raise (Corrupt "checksum mismatch");
    match Step_manifest.parse_record raw with
    | Ok step -> finish body (Some step)
    | Error err -> raise (Corrupt (Step_manifest.describe err)))
  else raise (Corrupt "snapshot version")

let read_snapshot path =
  match read_file path with
  | exception Sys_error msg -> Error (Corrupt_snapshot msg)
  | text -> (
      match parse text with
      | snap -> Ok snap
      | exception Corrupt msg -> Error (Corrupt_snapshot msg))

let load path =
  match read_snapshot path with
  | Ok snap -> snap.journal
  | Error (Corrupt_snapshot msg) -> raise (Corrupt msg)
  | Error err -> raise (Corrupt (describe err))

let close_fd fd = try Unix.close fd with Unix.Unix_error _ -> ()

let unlock_fd fd = try Unix.lockf fd Unix.F_ULOCK 0 with Unix.Unix_error _ -> ()

let with_store path f =
  let mu = store_mutex path in
  Mutex.lock mu;
  Fun.protect ~finally:(fun () -> Mutex.unlock mu) (fun () ->
      let fd = Unix.openfile (lock_path path) [ Unix.O_RDWR; Unix.O_CREAT; Unix.O_CLOEXEC ] 0o600 in
      Fun.protect
        ~finally:(fun () -> close_fd fd)
        (fun () ->
          Unix.set_close_on_exec fd;
          Unix.lockf fd Unix.F_LOCK 0;
          Fun.protect ~finally:(fun () -> unlock_fd fd) f))

let write_snap path snap = write_atomic path (render snap)

let known_recovery recovery =
  recovery = "AwaitingApproval"
  ||
  match Ocagent_protocol.Policy.of_name recovery with
  | Ok _ -> true
  | Error _ -> false

let check_identity snap ~run_id ~agent_version =
  if snap.journal.run_id <> run_id then Error Run_mismatch
  else if snap.journal.agent_version <> agent_version then Error Version_mismatch
  else
    let rec walk i = function
      | [] -> Ok ()
      | entry :: rest ->
          if entry.Journal.seq <> i then Error (Protocol "seq")
          else if entry.run_id <> run_id then Error Run_mismatch
          else if entry.kind = "" || not (known_recovery entry.recovery) then Error (Protocol "recovery")
          else walk (i + 1) rest
    in
    walk 0 !(snap.journal.entries)

let classify (journal : Journal.t) ~epoch =
  let changed = ref false in
  List.iter
    (fun entry ->
      if
        entry.Journal.status = Journal.Pending && entry.dispatched && entry.recovery = "Manual_only"
        && entry.attempt <> epoch
      then (
        entry.status <- Journal.Unknown;
        changed := true))
    !(journal.entries);
  !changed

let claim path ~run_id ~agent_version =
  with_store path (fun () ->
      if not (Sys.file_exists path) then (
        let journal = Journal.create ~run_id ~agent_version in
        write_snap path { revision = 1; epoch = 1; journal; step = None };
        Ok 1)
      else
        match read_snapshot path with
        | Error _ as err -> err
        | Ok snap when snap.step <> None -> Error (Protocol "step snapshot")
        | Ok snap -> (
            match check_identity snap ~run_id ~agent_version with
            | Error _ as err -> err
            | Ok () ->
                let epoch = snap.epoch + 1 in
                ignore (classify snap.journal ~epoch);
                write_snap path { snap with revision = snap.revision + 1; epoch };
                Ok epoch))

let with_locked ~path ~run_id ~agent_version ?(execution_hash = None) ?(step_id = None) claim f =
  let path = canonical path in
  if not (try_acquire path) then Error Already_running
  else
    Fun.protect ~finally:(fun () -> release_key path) (fun () ->
        let fd = Unix.openfile (executor_path path) [ Unix.O_RDWR; Unix.O_CREAT; Unix.O_CLOEXEC ] 0o600 in
        Fun.protect
          ~finally:(fun () -> close_fd fd)
          (fun () ->
            Unix.set_close_on_exec fd;
            let locked =
              try
                Unix.lockf fd Unix.F_TLOCK 0;
                true
              with Unix.Unix_error ((Unix.EAGAIN | Unix.EACCES | Unix.EWOULDBLOCK), _, _) -> false
            in
            if not locked then Error Already_running
            else
              Fun.protect
                ~finally:(fun () -> unlock_fd fd)
                (fun () ->
                  match claim path with
                  | Error _ as err -> err
                  | Ok epoch -> f { path; run_id; agent_version; epoch; execution_hash; step_id })))

let with_executor ~path ~run_id ~agent_version f =
  with_locked ~path ~run_id ~agent_version (fun path -> claim path ~run_id ~agent_version) f

let fresh ~run_id seq request ~attempt ~dispatched =
  {
    Journal.run_id;
    seq;
    kind = request.kind;
    label = request.label;
    req_hash = request.req_hash;
    req = request.req;
    status = Journal.Pending;
    result = Json.Null;
    idempotency_key = Printf.sprintf "%s:%d:%s" run_id seq request.req_hash;
    attempt;
    idempotent = false;
    dispatched;
    recovery = request.recovery;
    callback_id = "";
    ts = 0;
    last_hit = Journal.Suspend;
  }

let append journal entry = journal.Journal.entries := !(journal.entries) @ [ entry ]

let completed snap =
  match snap.step with
  | Some record when record.Step_manifest.state = Step_manifest.Completed -> true
  | _ -> false

let step_scope snap ~execution_hash ~step_id =
  match (snap.step, execution_hash, step_id) with
  | None, None, None -> Ok None
  | Some record, Some hash, Some id
    when record.Step_manifest.manifest.execution_hash = hash && record.manifest.step_id = id ->
      Ok (Some (hash, id))
  | _ -> Error Manifest_mismatch

let bound_hash scope request =
  match scope with
  | None -> request.req_hash
  | Some (hash, step_id) ->
      Step_manifest.operation_hash ~execution_hash:hash ~step_id ~kind:request.kind ~codec_version:1
        ~approval:request.approval ~params_hash:request.req_hash

let prepare_operation executor request =
  with_store executor.path (fun () ->
      match read_snapshot executor.path with
      | Error _ as err -> err
      | Ok snap when completed snap -> Error (Protocol "completed")
      | Ok snap -> (
          match step_scope snap ~execution_hash:executor.execution_hash ~step_id:executor.step_id with
          | Error _ as err -> err
          | Ok scope ->
              let request = { request with req_hash = bound_hash scope request } in
              if executor.epoch <> snap.epoch then Error Stale_attempt
              else if snap.journal.run_id <> executor.run_id then Error Run_mismatch
              else if snap.journal.agent_version <> executor.agent_version then Error Version_mismatch
              else if request.seq < 0 || request.seq > List.length !(snap.journal.entries) then Error (Protocol "seq")
              else if request.approval && request.kind <> "Ask_human" then Error (Bad_decision "不是审批")
              else if (not request.approval) && request.recovery <> "Manual_only" then Error (Protocol "recovery")
              else
                let issued =
                  {
                    run_id = executor.run_id;
                    agent_version = executor.agent_version;
                    seq = request.seq;
                    request_hash = request.req_hash;
                    issued_attempt = executor.epoch;
                    execution_hash = executor.execution_hash;
                    step_id = executor.step_id;
                  }
                in
                match Journal.nth snap.journal request.seq with
                | Some existing when existing.req_hash <> request.req_hash || existing.kind <> request.kind ->
                    Error Request_changed
                | Some existing when existing.status = Journal.Unknown -> Error Unknown_result
                | Some existing when existing.status = Journal.Done -> Ok (Replay existing.result)
                | Some existing when existing.kind = "Ask_human" && (not existing.dispatched) -> Ok Awaiting_approval
                | Some existing when existing.dispatched -> Ok In_flight
                | Some _ -> Error (Protocol "status")
                | None ->
                    let entry =
                      fresh ~run_id:executor.run_id request.seq request ~attempt:executor.epoch
                        ~dispatched:(not request.approval)
                    in
                    append snap.journal entry;
                    write_snap executor.path { snap with revision = snap.revision + 1 };
                    Ok (if request.approval then Awaiting_approval else Execute issued)))

let commit_result path (issued : issued) result_json =
  with_store path (fun () ->
      match read_snapshot path with
      | Error _ as err -> err
      | Ok snap when completed snap -> Error (Protocol "completed")
      | Ok snap -> (
          match step_scope snap ~execution_hash:issued.execution_hash ~step_id:issued.step_id with
          | Error _ as err -> err
          | Ok _ -> (
              match Journal.nth snap.journal issued.seq with
              | None -> Error (Protocol "seq")
              | Some entry when entry.kind = "Ask_human" -> Error (Bad_decision "审批不能走结果入口")
              | Some entry
                when issued.run_id <> snap.journal.run_id
                     || issued.agent_version <> snap.journal.agent_version
                     || issued.request_hash <> entry.req_hash ->
                  Error Request_changed
              | Some _ when issued.issued_attempt <> snap.epoch -> Error Stale_attempt
              | Some entry when entry.attempt <> issued.issued_attempt -> Error Stale_attempt
              | Some entry when entry.status = Journal.Done && entry.result = result_json -> Ok ()
              | Some entry -> (
                  match Journal.commit entry ~attempt:issued.issued_attempt result_json with
                  | Error _ -> Error Stale_attempt
                  | Ok () ->
                      write_snap path { snap with revision = snap.revision + 1 };
                      Ok ()))))

let decision_ok = function
  | Json.Assoc fields ->
      let rec dups seen = function
        | [] -> false
        | (key, _) :: rest -> List.mem key seen || dups (key :: seen) rest
      in
      if dups [] fields then Error (Bad_decision "重复键")
      else
        let fields = List.sort (fun (a, _) (b, _) -> String.compare a b) fields in
        (match fields with
        | [ ("tag", Json.String "Approved") ] -> Ok ()
        | [ ("reason", Json.String reason); ("tag", Json.String "Rejected") ] when reason <> "" -> Ok ()
        | _ -> Error (Bad_decision "决定格式不对"))
  | Json.Null | Json.Bool _ | Json.Int _ | Json.Float _ | Json.String _ | Json.List _ ->
      Error (Bad_decision "决定不是对象")


let callback_used journal seq callback_id =
  List.exists
    (fun entry -> entry.Journal.seq <> seq && entry.callback_id = callback_id)
    !(journal.Journal.entries)

let commit_decision ~path ~run_id ~agent_version ~seq ~callback_id ~expected_request_hash ~decision_json =
  if callback_id = "" || String.length callback_id > 128 then Error (Bad_decision "callback")
  else
    match decision_ok decision_json with
    | Error _ as err -> err
    | Ok () ->
        with_store path (fun () ->
            match read_snapshot path with
            | Error _ as err -> err
            | Ok snap when snap.step <> None -> Error Manifest_mismatch
            | Ok snap -> (
                match check_identity snap ~run_id ~agent_version with
                | Error _ as err -> err
                | Ok () -> (
                    match Journal.nth snap.journal seq with
                    | None -> Error (Protocol "seq")
                    | Some entry when entry.kind <> "Ask_human" -> Error (Bad_decision "不是审批记录")
                    | Some entry when entry.req_hash <> expected_request_hash -> Error Request_changed
                    | Some _ when callback_used snap.journal seq callback_id -> Error Approval_conflict
                    | Some entry
                      when entry.status = Journal.Done && entry.callback_id = callback_id && entry.result = decision_json
                      ->
                        Ok ()
                    | Some entry when entry.status = Journal.Done -> Error Approval_conflict
                    | Some entry when entry.status <> Journal.Pending || entry.dispatched -> Error (Bad_decision "不能批准")
                    | Some entry ->
                        entry.status <- Journal.Done;
                        entry.result <- decision_json;
                        entry.callback_id <- callback_id;
                        write_snap path { snap with revision = snap.revision + 1 };
                        Ok ())))

let tail_check executor cursor =
  with_store executor.path (fun () ->
      match read_snapshot executor.path with
      | Error _ as err -> err
      | Ok snap ->
          let n = List.length !(snap.journal.entries) in
          if cursor = n then Ok ()
          else if cursor < n then Error Replay_incomplete
          else Error (Protocol "cursor"))

let compare_and_save ~path ~expected_revision ~epoch journal =
  with_store path (fun () ->
      match read_snapshot path with
      | Error _ as err -> err
      | Ok snap when snap.step <> None -> Error Manifest_mismatch
      | Ok snap when snap.revision <> expected_revision -> Error Revision_conflict
      | Ok snap ->
          write_snap path { revision = snap.revision + 1; epoch; journal; step = snap.step };
          Ok ())

let file_bytes path = read_file path

let max_text = 262144
let max_artifact = 16 * 1024 * 1024

type blob_kind =
  | Text
  | Artifact

let blob_limit = function
  | Text -> max_text
  | Artifact -> max_artifact

type 'a step_run =
  | Stored_completion of { reply : Step_manifest.reply; workspace : string }
  | Resumed of 'a

let blob_file path hash = Filename.concat (Filename.concat (Filename.dirname path) "step-blobs") hash

let put_blob path hash bytes ~limit =
  if String.length bytes > limit then Error (Protocol "too big")
  else
    let dir = Filename.dirname (blob_file path hash) in
    if not (Sys.file_exists dir) then Unix.mkdir dir 0o700;
    let target = blob_file path hash in
    if Sys.file_exists target then
      let size = (Unix.stat target).st_size in
      if size < 0 || size > limit then Error (Protocol "too big")
      else if Step_manifest.sha256 (read_file target) <> hash then Error Artifact_corrupt
      else Ok ()
    else (
      write_atomic target bytes;
      Ok ())

let check_blob path hash ~limit =
  let target = blob_file path hash in
  if not (Sys.file_exists target) then Error Artifact_missing
  else
    let size = (Unix.stat target).st_size in
    if size < 0 || size > limit then Error (Protocol "too big")
    else
      let bytes = read_file target in
      if String.length bytes > limit then Error (Protocol "too big")
      else if Step_manifest.sha256 bytes <> hash then Error Artifact_corrupt
      else Ok bytes

let check_manifest_blobs path (m : Step_manifest.t) =
  let text_hashes =
    m.source_hash :: m.sdk_hash :: m.driver_hash :: m.base_workspace_hash :: m.input_context_hash
    :: m.capability_grant_hash
    :: List.concat_map
         (fun (item : Step_manifest.module_desc) -> [ item.source_hash; item.interface_hash ])
         m.modules
  in
  let artifact_hashes = m.artifact_hash :: List.map (fun (item : Step_manifest.module_desc) -> item.artifact_hash) m.modules in
  let rec go limit = function
    | [] -> Ok ()
    | hash :: rest -> (
        match check_blob path hash ~limit with
        | Error _ as err -> err
        | Ok _ -> go limit rest)
  in
  match go max_text text_hashes with
  | Error _ as err -> err
  | Ok () -> go max_artifact artifact_hashes

let role_limits (bundle : Step_manifest.bundle) =
  let text bytes = String.length bytes <= max_text in
  let artifact bytes = String.length bytes <= max_artifact in
  let texts =
    text bundle.source && text bundle.sdk && text bundle.driver && text bundle.base_workspace && text bundle.input_context
    && text bundle.capability_grant
    && List.for_all
         (fun (item : Step_manifest.module_bytes) -> text item.source && text item.interface_)
         bundle.modules
  in
  let artifacts =
    artifact bundle.artifact
    && List.for_all (fun (item : Step_manifest.module_bytes) -> artifact item.artifact) bundle.modules
  in
  texts && artifacts

let admit_step ~path ~run_id ~agent_version ~admission_key bundle =
  if admission_key = "" then Error (Protocol "admission")
  else
    match Step_manifest.build ~run_id ~step_id:"0" ~step_seq:0 bundle with
    | Error err -> Error (Protocol (Step_manifest.describe err))
    | Ok manifest -> (
        let path = canonical path in
        if not (role_limits bundle) then Error (Protocol "too big")
        else
          let pairs =
          [
            (manifest.source_hash, bundle.Step_manifest.source, max_text);
            (manifest.sdk_hash, bundle.sdk, max_text);
            (manifest.driver_hash, bundle.driver, max_text);
            (manifest.artifact_hash, bundle.artifact, max_artifact);
            (manifest.base_workspace_hash, bundle.base_workspace, max_text);
            (manifest.input_context_hash, bundle.input_context, max_text);
            (manifest.capability_grant_hash, bundle.capability_grant, max_text);
          ]
          @ List.concat
              (List.map2
                 (fun (item : Step_manifest.module_desc) (raw : Step_manifest.module_bytes) ->
                   [
                     (item.source_hash, raw.source, max_text);
                     (item.interface_hash, raw.interface_, max_text);
                     (item.artifact_hash, raw.artifact, max_artifact);
                   ])
                 manifest.modules bundle.modules)
        in
        let rec write = function
          | [] -> Ok ()
          | (hash, bytes, limit) :: rest -> (
              match put_blob path hash bytes ~limit with
              | Error _ as err -> err
              | Ok () -> write rest)
        in
        match write pairs with
        | Error _ as err -> err
        | Ok () ->
            with_store path (fun () ->
                if not (Sys.file_exists path) then (
                  let journal = Journal.create ~run_id ~agent_version in
                  let step =
                    {
                      Step_manifest.admission_key;
                      manifest;
                      state = Prepared;
                      reply = None;
                      final_workspace = None;
                      error = None;
                    }
                  in
                  write_snap path { revision = 1; epoch = 0; journal; step = Some step };
                  Ok manifest)
                else
                  match read_snapshot path with
                  | Error _ as err -> err
                  | Ok snap -> (
                      match snap.step with
                      | None -> Error Version_unavailable
                      | Some existing
                        when existing.admission_key = admission_key && existing.manifest.execution_hash = manifest.execution_hash ->
                          if snap.journal.run_id <> run_id || existing.manifest.run_id <> run_id then Error Run_mismatch
                          else if snap.journal.agent_version <> agent_version then Error Version_mismatch
                          else Ok existing.manifest
                      | Some existing when existing.admission_key = admission_key -> Error Admission_conflict
                      | Some _ -> Error Multiple_steps_unsupported)))

type preflight =
  | Ready
  | Stored of { reply : Step_manifest.reply; workspace : string }

let read_blob ~path ~hash ~kind = check_blob path hash ~limit:(blob_limit kind)

let preflight ~path ~execution_hash ~compiler_id ~runtime_id =
  let path = canonical path in
  match read_snapshot path with
  | Error _ as err -> err
  | Ok snap -> (
      match snap.step with
      | None -> Error Version_unavailable
      | Some record when record.manifest.execution_hash <> execution_hash -> Error Manifest_mismatch
      | Some record when record.state = Step_manifest.Completed -> (
          match (record.reply, record.final_workspace) with
          | Some reply, Some workspace -> Ok (Stored { reply; workspace })
          | _ -> Error (Corrupt_snapshot "completion"))
      | Some record when record.manifest.compiler_id <> compiler_id || record.manifest.runtime_id <> runtime_id ->
          Error Version_mismatch
      | Some record -> (
          match check_manifest_blobs path record.manifest with
          | Error _ as err -> err
          | Ok _ -> Ok Ready))

let claim_step path ~execution_hash =
  with_store path (fun () ->
      match read_snapshot path with
      | Error _ as err -> err
      | Ok snap -> (
          match snap.step with
          | None -> Error Version_unavailable
          | Some record when record.manifest.execution_hash <> execution_hash -> Error Manifest_mismatch
          | Some record when record.state = Step_manifest.Completed -> Error (Protocol "completed")
          | Some record when record.state = Step_manifest.Failed || record.state = Step_manifest.Blocked_unknown ->
              Error Unknown_result
          | Some record -> (
              match check_manifest_blobs path record.manifest with
              | Error _ as err -> err
              | Ok () ->
                  let epoch = snap.epoch + 1 in
                  ignore (classify snap.journal ~epoch);
                  let step = { record with Step_manifest.state = Running } in
                  write_snap path { snap with revision = snap.revision + 1; epoch; step = Some step };
                  Ok epoch)))

let with_step_executor ~path ~execution_hash f =
  let path = canonical path in
  match
    with_store path (fun () -> if not (Sys.file_exists path) then Error (Protocol "no step") else read_snapshot path)
  with
  | Error _ as err -> err
  | Ok snap -> (
      match snap.step with
      | None -> Error Version_unavailable
      | Some record when record.manifest.execution_hash <> execution_hash -> Error Manifest_mismatch
      | Some record when record.state = Step_manifest.Completed -> (
          match (record.reply, record.final_workspace) with
          | Some reply, Some workspace -> Ok (Stored_completion { reply; workspace })
          | _ -> Error (Corrupt_snapshot "completion"))
      | Some record ->
          with_locked ~path ~run_id:snap.journal.run_id ~agent_version:snap.journal.agent_version
            ~execution_hash:(Some record.manifest.execution_hash) ~step_id:(Some record.manifest.step_id)
            (fun path -> claim_step path ~execution_hash)
            (fun executor ->
              match f executor with
              | Error _ as err -> err
              | Ok value -> Ok (Resumed value)))

let has_unknown journal =
  List.exists (fun entry -> entry.Journal.status = Journal.Unknown) !(journal.Journal.entries)

let has_pending journal =
  List.exists (fun entry -> entry.Journal.status = Journal.Pending) !(journal.Journal.entries)

let complete_step executor ~cursor ~reply ~workspace_hash =
  if not (Step_manifest.hash_ok workspace_hash) then Error (Protocol "hash")
  else
    with_store executor.path (fun () ->
      match read_snapshot executor.path with
      | Error _ as err -> err
      | Ok snap -> (
          match step_scope snap ~execution_hash:executor.execution_hash ~step_id:executor.step_id with
          | Error _ as err -> err
          | Ok _ -> (
          match snap.step with
          | None -> Error Version_unavailable
          | Some _ when executor.epoch <> snap.epoch -> Error Stale_attempt
          | Some record when record.state = Step_manifest.Completed ->
              if record.reply = Some reply && record.final_workspace = Some workspace_hash then Ok ()
              else Error Approval_conflict
          | Some record when record.state <> Step_manifest.Running -> Error (Protocol "state")
          | Some _ when has_unknown snap.journal -> Error Unknown_result
          | Some _ when has_pending snap.journal -> Error Replay_incomplete
          | Some _ when cursor <> List.length !(snap.journal.entries) -> Error Replay_incomplete
          | Some record ->
              let step = { record with state = Completed; reply = Some reply; final_workspace = Some workspace_hash } in
              match Step_manifest.canonical_record step with
              | Error _ -> Error (Protocol "reply")
              | Ok _ ->
                  write_snap executor.path { snap with revision = snap.revision + 1; step = Some step };
                  Ok ())))

let approve_step ~path ~execution_hash ~seq ~callback_id ~expected_request_hash ~decision_json =
  if callback_id = "" || String.length callback_id > 128 then Error (Bad_decision "callback")
  else
    match decision_ok decision_json with
    | Error _ as err -> err
    | Ok () ->
        with_store path (fun () ->
            match read_snapshot path with
            | Error _ as err -> err
            | Ok snap -> (
                match snap.step with
                | None -> Error Version_unavailable
                | Some record when record.manifest.execution_hash <> execution_hash -> Error Manifest_mismatch
                | Some record when record.state = Step_manifest.Completed -> Error (Protocol "completed")
                | Some _ -> (
                    match Journal.nth snap.journal seq with
                    | None -> Error (Protocol "seq")
                    | Some entry when entry.kind <> "Ask_human" -> Error (Bad_decision "不是审批记录")
                    | Some entry when entry.req_hash <> expected_request_hash -> Error Request_changed
                    | Some _ when callback_used snap.journal seq callback_id -> Error Approval_conflict
                    | Some entry
                      when entry.status = Journal.Done && entry.callback_id = callback_id && entry.result = decision_json ->
                        Ok ()
                    | Some entry when entry.status = Journal.Done -> Error Approval_conflict
                    | Some entry when entry.status <> Journal.Pending || entry.dispatched -> Error (Bad_decision "不能批准")
                    | Some entry ->
                        entry.status <- Journal.Done;
                        entry.result <- decision_json;
                        entry.callback_id <- callback_id;
                        write_snap path { snap with revision = snap.revision + 1 };
                        Ok ())))


