(** Private stdio gateway. One workbench_v1 frame in, one frame out.
    The caller is the trusted server. Browser fields never choose owner,
    path, policy, issued, or the fetch URL. *)

module A = Ocagent_harness.Workbench_adapter
module Json = Ocagent_harness.Json

let max_frame = 262144

let fail_frame id layer code message retry =
  Json.Assoc
    [
      ("error", Json.Assoc [ ("code", Json.String code); ("layer", Json.String layer); ("message", Json.String message); ("retry_advice", Json.String retry) ]);
      ("id", Json.String id);
      ("ok", Json.Bool false);
      ("projection", Json.Null);
      ("runs", Json.List []);
      ("truncated", Json.Bool false);
      ("v", Json.String "workbench_v1");
    ]

let wrap id answer =
  match A.answer_json answer with
  | Json.Assoc fields -> Json.Assoc (("id", Json.String id) :: ("v", Json.String "workbench_v1") :: fields)
  | other -> other

let really_read fd buf off len =
  let rec go got =
    if got = len then ()
    else
      match Unix.read fd buf (off + got) (len - got) with
      | 0 -> failwith "eof"
      | n -> go (got + n)
      | exception Unix.Unix_error (Unix.EINTR, _, _) -> go got
  in
  go 0

let really_write fd buf off len =
  let rec go sent =
    if sent = len then ()
    else
      match Unix.write fd buf (off + sent) (len - sent) with
      | 0 -> failwith "e pipe"
      | n -> go (sent + n)
      | exception Unix.Unix_error (Unix.EINTR, _, _) -> go sent
  in
  go 0

let read_frame fd =
  let lenb = Bytes.create 4 in
  really_read fd lenb 0 4;
  let n =
    (Char.code (Bytes.get lenb 0) lsl 24)
    lor (Char.code (Bytes.get lenb 1) lsl 16)
    lor (Char.code (Bytes.get lenb 2) lsl 8)
    lor Char.code (Bytes.get lenb 3)
  in
  if n <= 0 || n > max_frame then failwith "frame"
  else
    let body = Bytes.create n in
    really_read fd body 0 n;
    Bytes.to_string body

let write_frame fd text =
  if String.length text > max_frame then failwith "frame"
  else
    let buf = Bytes.create (4 + String.length text) in
    let n = String.length text in
    Bytes.set buf 0 (Char.chr ((n lsr 24) land 255));
    Bytes.set buf 1 (Char.chr ((n lsr 16) land 255));
    Bytes.set buf 2 (Char.chr ((n lsr 8) land 255));
    Bytes.set buf 3 (Char.chr (n land 255));
    Bytes.blit_string text 0 buf 4 n;
    really_write fd buf 0 (Bytes.length buf)

let keys = function
  | Json.Assoc fields -> List.map fst fields
  | _ -> []

let exact json expected =
  let got = List.sort String.compare (keys json) in
  let expected = List.sort String.compare expected in
  got = expected

let string_field name json =
  match Json.field name json with
  | Json.String text -> text
  | _ -> failwith "string"

let id_of json =
  match Json.field_opt "id" json with
  | Some (Json.String id) when id <> "" && String.length id <= 64 -> id
  | _ -> "bad"

let env name =
  match Sys.getenv_opt name with
  | Some text when text <> "" -> text
  | _ -> ""

let handle json =
  let id = id_of json in
  if (match Json.field_opt "v" json with Some (Json.String "workbench_v1") -> false | _ -> true) then
    fail_frame id "protocol" "version" "需要 workbench_v1" "拒绝该帧"
  else
    let op = match Json.field_opt "op" json with Some (Json.String op) -> op | _ -> "" in
    let owner = match Json.field_opt "owner" json with Some (Json.String owner) -> owner | _ -> "" in
    let root = env "OCAGENT_DURABLE_ROOT" in
    let fetch_url = env "OCAGENT_FETCH_URL" in
    if root = "" || not (Filename.is_relative root = false) then fail_frame id "toolchain" "root" "持久目录未配置" "不要使用请求内的路径"
    else
      let run_id () = string_field "run_id" json in
      let execution_hash () = string_field "execution_hash" json in
      let answer =
        match op with
        | "createRun" when exact json [ "dedupe_key"; "id"; "material"; "op"; "owner"; "task"; "v" ] ->
            A.create_run ~root ~owner ~fetch_url ~dedupe_key:(string_field "dedupe_key" json) ~material:(string_field "material" json) ~task:(string_field "task" json)
        | "listRuns" when exact json [ "id"; "op"; "owner"; "v" ] -> A.list_runs ~root ~owner
        | "getRun" when exact json [ "id"; "op"; "owner"; "run_id"; "v" ] -> A.locate ~root ~owner (run_id ())
        | "prepareRun" when exact json [ "id"; "op"; "owner"; "run_id"; "v" ] -> A.prepare_run ~root ~owner ~run_id:(run_id ())
        | "reserveModel" when exact json [ "id"; "op"; "owner"; "run_id"; "v" ] -> A.reserve_model ~root ~owner ~run_id:(run_id ())
        | "commitModel" when exact json [ "id"; "model_text"; "op"; "owner"; "run_id"; "v" ] ->
            A.commit_model ~root ~owner ~run_id:(run_id ()) ~model_text:(string_field "model_text" json)
        | "startOrResumeRun" when exact json [ "execution_hash"; "id"; "op"; "owner"; "run_id"; "v" ] ->
            A.start_or_resume ~root ~owner ~run_id:(run_id ()) ~execution_hash:(execution_hash ())
        | "decideApproval" when exact json [ "callback_id"; "decision"; "execution_hash"; "id"; "op"; "owner"; "request_hash"; "run_id"; "seq"; "v" ] -> (
            match Json.field "seq" json with
            | Json.Int seq ->
                A.decide_approval ~root ~owner ~run_id:(run_id ()) ~execution_hash:(execution_hash ()) ~seq
                  ~callback_id:(string_field "callback_id" json) ~request_hash:(string_field "request_hash" json) ~decision:(Json.field "decision" json)
            | _ -> A.err "approval" "Bad_decision" "seq 必须是整数" "使用保存的 seq")
        | _ -> A.err "protocol" "schema" "未知操作或含有不允许的字段" "不要提交 path、policy、issued 或 URL"
      in
      wrap id answer

let () =
  Random.self_init ();
  Sys.set_signal Sys.sigpipe Sys.Signal_ignore;
  let armed = A.arm_parent_death () in
  if armed <> 0 then (
    prerr_endline ("pdeath " ^ string_of_int armed);
    exit 1);
  let stdin = Unix.stdin in
  let stdout = Unix.stdout in
  let respond json =
    let text = Json.canonical json in
    if String.length text > max_frame then write_frame stdout (Json.canonical (fail_frame "bad" "protocol" "frame" "响应超过上限" "拒绝"))
    else write_frame stdout text
  in
  match handle (Json.parse (read_frame stdin)) with
  | json -> respond json
  | exception Failure msg -> respond (fail_frame "bad" "protocol" "frame" msg "拒绝该帧")
  | exception Json.Parse msg -> respond (fail_frame "bad" "protocol" "bad_json" msg "拒绝该帧")
  | exception _ -> respond (fail_frame "bad" "protocol" "frame" "帧无效" "拒绝该帧")
