(** Disk journal. A commit is a complete file renamed into place.
    A truncated temporary file is not the journal. *)

let read_file path =
  let ic = open_in_bin path in
  Fun.protect ~finally:(fun () -> close_in ic) (fun () -> really_input_string ic (in_channel_length ic))

let save path journal =
  let text = Journal.to_jsonl journal in
  let tmp = path ^ ".tmp" in
  let oc = open_out_gen [ Open_wronly; Open_creat; Open_trunc ] 0o644 tmp in
  Fun.protect
    ~finally:(fun () -> close_out oc)
    (fun () ->
      output_string oc text;
      flush oc);
  Sys.rename tmp path

let load path = Journal.of_jsonl (read_file path)

let mutate path f =
  let journal = load path in
  match f journal with
  | Error _ as err -> err
  | Ok () ->
      save path journal;
      Ok ()

let commit_decision path seq decision_json =
  mutate path (fun journal ->
      match Journal.nth journal seq with
      | None -> Error "没有这一条审批"
      | Some entry -> Journal.commit entry ~attempt:entry.attempt decision_json)

let commit_result path seq ~attempt result_json =
  mutate path (fun journal ->
      match Journal.nth journal seq with
      | None -> Error "没有这一条结果"
      | Some entry -> Journal.commit entry ~attempt result_json)

let refuse_uncertain path =
  let journal = load path in
  let changed = ref false in
  List.iter
    (fun entry ->
      if entry.Journal.status = Journal.Pending && not entry.idempotent then (
        entry.status <- Journal.Unknown;
        changed := true))
    !(journal.entries);
  if !changed then save path journal;
  !changed
