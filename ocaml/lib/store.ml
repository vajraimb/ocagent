(** One snapshot file per run. A commit is a private temp file, fsync, then rename.
    The lock file stays beside the snapshot and is never renamed over. *)

exception Corrupt of string

let lock_path path = path ^ ".lock"

let with_lock path f =
  let fd = Unix.openfile (lock_path path) [ Unix.O_RDWR; Unix.O_CREAT ] 0o600 in
  Unix.lockf fd Unix.F_LOCK 0;
  Fun.protect
    ~finally:(fun () ->
      Unix.lockf fd Unix.F_ULOCK 0;
      Unix.close fd)
    f

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
  let fd = Unix.openfile tmp [ Unix.O_WRONLY; Unix.O_CREAT; Unix.O_EXCL ] 0o600 in
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
  let dirfd = Unix.openfile (Filename.dirname path) [ Unix.O_RDONLY ] 0 in
  Fun.protect ~finally:(fun () -> Unix.close dirfd) (fun () -> Unix.fsync dirfd)

let render journal revision =
  let body = Journal.to_jsonl journal in
  let records = List.length !(journal.entries) in
  let sum = checksum body in
  Printf.sprintf "OCAGENT 1\nrevision %d\nrecords %d\nchecksum %s\n%s" revision records sum body

let parse text =
  let nl i = try String.index_from text i '\n' with Not_found -> raise (Corrupt "snapshot header") in
  let line i =
    let j = nl i in
    (String.sub text i (j - i), j + 1)
  in
  let magic, i1 = line 0 in
  let rev_line, i2 = line i1 in
  let rec_line, i3 = line i2 in
  let sum_line, i4 = line i3 in
  if magic <> "OCAGENT 1" then raise (Corrupt "snapshot version");
  let revision =
    try Scanf.sscanf rev_line "revision %d" (fun n -> n) with Scanf.Scan_failure _ | End_of_file -> raise (Corrupt "revision")
  in
  let records =
    try Scanf.sscanf rec_line "records %d" (fun n -> n) with Scanf.Scan_failure _ | End_of_file -> raise (Corrupt "records")
  in
  let sum =
    try Scanf.sscanf sum_line "checksum %s" (fun s -> s) with Scanf.Scan_failure _ | End_of_file -> raise (Corrupt "checksum")
  in
  let body = String.sub text i4 (String.length text - i4) in
  if checksum body <> sum then raise (Corrupt "checksum mismatch");
  let journal = try Journal.of_jsonl body with Json.Parse msg -> raise (Corrupt msg) in
  if List.length !(journal.entries) <> records then raise (Corrupt "record count");
  (revision, journal)

let read path = parse (read_file path)

let load path = snd (read path)

let save path journal =
  with_lock path (fun () ->
      let revision = if Sys.file_exists path then fst (read path) else 0 in
      write_atomic path (render journal (revision + 1)))

let classify (journal : Journal.t) =
  let changed = ref false in
  List.iter
    (fun entry ->
      if entry.Journal.status = Journal.Pending && entry.dispatched && entry.recovery = "Manual_only" then (
        entry.status <- Journal.Unknown;
        changed := true))
    !(journal.entries);
  !changed

let open_run path ~run_id ~agent_version =
  with_lock path (fun () ->
      let revision, journal =
        if Sys.file_exists path then read path else (0, Journal.create ~run_id ~agent_version)
      in
      let changed = classify journal in
      if changed || not (Sys.file_exists path) then write_atomic path (render journal (revision + 1));
      journal)

let mutate path f =
  with_lock path (fun () ->
      let revision, journal = read path in
      match f journal with
      | Error _ as err -> err
      | Ok () ->
          write_atomic path (render journal (revision + 1));
          Ok ())

let commit_decision path seq decision_json =
  mutate path (fun journal ->
      match Journal.nth journal seq with
      | None -> Error "没有这一条审批"
      | Some entry when entry.kind <> "Ask_human" -> Error "不是审批记录"
      | Some entry when entry.status = Journal.Done && entry.callback_id = "cb" && entry.result = decision_json ->
          Ok ()
      | Some entry when entry.status = Journal.Done -> Error "审批决定冲突"
      | Some entry when entry.status <> Journal.Pending -> Error "不能批准"
      | Some entry ->
          entry.status <- Journal.Done;
          entry.result <- decision_json;
          entry.callback_id <- "cb";
          Ok ())

let commit_result path seq ~attempt result_json =
  mutate path (fun journal ->
      match Journal.nth journal seq with
      | None -> Error "没有这一条结果"
      | Some entry -> Journal.commit entry ~attempt result_json)

let refuse_uncertain path =
  with_lock path (fun () ->
      let revision, journal = read path in
      let changed = classify journal in
      if changed then write_atomic path (render journal (revision + 1));
      changed)
