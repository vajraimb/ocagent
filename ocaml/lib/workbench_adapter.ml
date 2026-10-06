(** Trusted workbench adapter. prepare_run still admits only the fixed Step.
    Model text is reserved and committed beside the run, then admitted once.
    This module does not call a model and does not accept a caller-chosen
    URL, path, or policy. *)

type failure = {
  layer : string;
  code : string;
  message : string;
  retry_advice : string;
}

type reply = { tag : string; text : string }

type approval = {
  seq : int;
  request_hash : string;
  params : string;
  recorded_decision : string option;
}

type projection = {
  run_id : string;
  phase : string;
  execution_hash : string option;
  store_state : string option;
  activity : string;
  revision : int option;
  epoch : int option;
  reply : reply option;
  pending_approval : approval option;
  error : failure option;
  source_hash : string option;
  artifact_hash : string option;
  compiler_id : string option;
  runtime_id : string option;
  policy_version : string option;
  material : string;
  task : string;
  fetch_url : string;
  compile_count : int;
  notice : string option;
  source : string;
}

type answer = {
  ok : bool;
  projection : projection option;
  error : failure option;
  runs : projection list;
  truncated : bool;
}

let fixed_source =
  {|open Step_api
module Step : STEP = struct
  let run () =
    match Input.get "material", Input.get "fetch_url" with
    | Some material, Some url ->
        (match Net.get url with
        | Ok resp ->
            if resp.status = 200 then Done ("validated:" ^ material)
            else Done "bad"
        | Error (Net.Approval_rejected reason) -> Done ("rejected:" ^ reason)
        | Error (Net.Denied reason) -> Done ("denied:" ^ reason))
    | _ -> Done "missing"
end
|}

let agent_version = "step-v3"
let admission_key = "fixed-spec"
let max_material = 65536
let max_task = 4000
let max_runs = 50

external arm_parent_death : unit -> int = "ocagent_arm_pdeath"

let failure layer code message retry_advice = { layer; code; message; retry_advice }

let err layer code message retry =
  { ok = false; projection = None; error = Some (failure layer code message retry); runs = []; truncated = false }

let ok_one projection =
  { ok = true; projection = Some projection; error = None; runs = []; truncated = false }

let with_error projection error =
  { ok = false; projection = Some projection; error = Some error; runs = []; truncated = false }

let source_hash = Step_manifest.sha256 fixed_source

let url_ok url =
  let prefix = "http://127.0.0.1:" in
  let suffix = "/spec" in
  if (not (String.starts_with ~prefix url)) || not (String.ends_with ~suffix url) then false
  else
    let mid = String.sub url (String.length prefix) (String.length url - String.length prefix - String.length suffix) in
    match int_of_string_opt mid with
    | None -> false
    | Some port -> port > 0 && port < 65536 && string_of_int port = mid

let owner_ok owner =
  owner <> "" && String.length owner <= 128
  &&
  let rec loop i =
    if i >= String.length owner then true
    else
      match owner.[i] with
      | 'a' .. 'z' | 'A' .. 'Z' | '0' .. '9' | '.' | '_' | ':' | '-' -> loop (i + 1)
      | _ -> false
  in
  loop 0

let key_ok key =
  key <> "" && String.length key <= 128 && (not (String.contains key '/')) && (not (String.contains key '\\'))
  && not (String.contains key '\000')

let run_id_ok id =
  String.length id = 32
  &&
  let rec loop i =
    if i >= 32 then true
    else
      match id.[i] with
      | '0' .. '9' | 'a' .. 'f' -> loop (i + 1)
      | _ -> false
  in
  loop 0

let callback_ok id =
  id <> "" && String.length id <= 128
  &&
  let rec loop i =
    if i >= String.length id then true
    else
      match id.[i] with
      | 'a' .. 'z' | 'A' .. 'Z' | '0' .. '9' | '.' | '_' | ':' | '-' -> loop (i + 1)
      | _ -> false
  in
  loop 0

let rec utf8 s i =
  if i >= String.length s then true
  else
    let c = Char.code s.[i] in
    if c = 0 then false
    else if c < 128 then utf8 s (i + 1)
    else
      let need = if c land 0xE0 = 0xC0 then 1 else if c land 0xF0 = 0xE0 then 2 else if c land 0xF8 = 0xF0 then 3 else -1 in
      if need < 0 || c < 0xC2 then false
      else
        let rec cont n j =
          if n = 0 then utf8 s j
          else if j >= String.length s then false
          else
            let d = Char.code s.[j] in
            if d land 0xC0 <> 0x80 then false else cont (n - 1) (j + 1)
        in
        cont need (i + 1)

let text_ok ~limit text = String.length text <= limit && utf8 text 0

let hex_bytes n =
  let ic = In_channel.open_bin "/dev/urandom" in
  Fun.protect
    ~finally:(fun () -> In_channel.close ic)
    (fun () ->
      let raw = really_input_string ic n in
      let buf = Buffer.create (n * 2) in
      String.iter (fun c -> Buffer.add_string buf (Printf.sprintf "%02x" (Char.code c))) raw;
      Buffer.contents buf)

let input_bytes material url =
  let fields =
    List.map
      (fun (key, value) -> (key, Step_manifest.String value))
      (List.sort (fun (a, _) (b, _) -> String.compare a b) [ ("material", material); ("fetch_url", url) ])
  in
  Step_manifest.canonical (Step_manifest.Obj fields)

let fingerprint ~owner ~dedupe_key ~material ~task ~fetch_url =
  Step_manifest.sha256
    (Json.canonical
       (Json.Assoc
          [
            ("dedupe_key", Json.String dedupe_key);
            ("fetch_url", Json.String fetch_url);
            ("material", Json.String material);
            ("owner", Json.String owner);
            ("source_hash", Json.String source_hash);
            ("task", Json.String task);
          ]))

type meta = {
  run_id : string;
  owner : string;
  dedupe_key : string;
  fingerprint : string;
  material : string;
  task : string;
  fetch_url : string;
  execution_hash : string option;
  compile_count : int;
}

let meta_json m =
  Json.Assoc
    [
      ("compile_count", Json.Int m.compile_count);
      ("dedupe_key", Json.String m.dedupe_key);
      ("execution_hash", (match m.execution_hash with None -> Json.Null | Some hash -> Json.String hash));
      ("fetch_url", Json.String m.fetch_url);
      ("fingerprint", Json.String m.fingerprint);
      ("material", Json.String m.material);
      ("owner", Json.String m.owner);
      ("run_id", Json.String m.run_id);
      ("source_hash", Json.String source_hash);
      ("task", Json.String m.task);
    ]

let meta_of json =
  let execution =
    match Json.field_opt "execution_hash" json with
    | Some Json.Null -> None
    | Some (Json.String hash) -> Some hash
    | _ -> raise (Json.Parse "execution_hash")
  in
  {
    run_id = Json.string_field "run_id" json;
    owner = Json.string_field "owner" json;
    dedupe_key = Json.string_field "dedupe_key" json;
    fingerprint = Json.string_field "fingerprint" json;
    material = Json.string_field "material" json;
    task = Json.string_field "task" json;
    fetch_url = Json.string_field "fetch_url" json;
    execution_hash = execution;
    compile_count = Json.int_field "compile_count" json;
  }

let fsync_dir dir =
  let fd = Unix.openfile dir [ Unix.O_RDONLY; Unix.O_CLOEXEC ] 0 in
  Fun.protect ~finally:(fun () -> Unix.close fd) (fun () -> Unix.fsync fd)

let write_atomic path text =
  let dir = Filename.dirname path in
  let tmp = Filename.concat dir (Printf.sprintf ".%d-%d.tmp" (Unix.getpid ()) (Random.bits ())) in
  let fd = Unix.openfile tmp [ Unix.O_WRONLY; Unix.O_CREAT; Unix.O_EXCL; Unix.O_CLOEXEC ] 0o600 in
  Fun.protect
    ~finally:(fun () -> (try Unix.close fd with Unix.Unix_error _ -> ()))
    (fun () ->
      let rec go off =
        if off < String.length text then
          let n = Unix.write_substring fd text off (String.length text - off) in
          go (off + n)
      in
      go 0;
      Unix.fsync fd);
  Unix.rename tmp path;
  fsync_dir dir

let read_file path = In_channel.with_open_bin path In_channel.input_all

let ensure_dir path mode =
  if Sys.file_exists path then
    if Sys.is_directory path then () else raise (Failure "not a directory")
  else
    try Unix.mkdir path mode with Unix.Unix_error (Unix.EEXIST, _, _) -> if not (Sys.is_directory path) then raise (Failure "not a directory")

let with_lock path f =
  let fd = Unix.openfile path [ Unix.O_RDWR; Unix.O_CREAT; Unix.O_CLOEXEC ] 0o600 in
  Fun.protect
    ~finally:(fun () -> Unix.close fd)
    (fun () ->
      Unix.lockf fd Unix.F_LOCK 0;
      Fun.protect ~finally:(fun () -> (try Unix.lockf fd Unix.F_ULOCK 0 with Unix.Unix_error _ -> ())) f)

let real_inside root path =
  let root = Unix.realpath root in
  let target = Unix.realpath path in
  let prefix = if String.ends_with ~suffix:"/" root then root else root ^ "/" in
  target = root || String.starts_with ~prefix target

let no_symlink path =
  match (Unix.lstat path).Unix.st_kind with
  | Unix.S_LNK -> false
  | _ -> true

let runs_dir root = Filename.concat root "runs"
let index_dir root owner = Filename.concat (Filename.concat root "index") (Step_manifest.sha256 owner)
let index_path root owner key = Filename.concat (index_dir root owner) (Step_manifest.sha256 key ^ ".json")
let index_lock root owner key = Filename.concat (index_dir root owner) (Step_manifest.sha256 key ^ ".lock")
let run_dir root run_id = Filename.concat (runs_dir root) run_id
let meta_path root run_id = Filename.concat (run_dir root run_id) "meta.json"
let step_path root run_id = Filename.concat (Filename.concat (run_dir root run_id) "step") "snapshot.json"
let prepare_lock root run_id = Filename.concat (run_dir root run_id) "prepare.lock"

let store_failure = function
  | Store.Already_running -> failure "execution" "Already_running" "执行者忙" "先只读查询，不要重发外部请求"
  | Store.Unknown_result -> failure "execution" "Unknown_result" "可能已执行，禁止自动重试" "不要重试 Fetch"
  | Store.Approval_conflict -> failure "approval" "Approval_conflict" "审批冲突" "重新查询后不要改成另一条决定"
  | Store.Request_changed -> failure "approval" "Request_changed" "请求哈希与已保存的不一致" "使用服务器保存的哈希，不要重算"
  | Store.Bad_decision msg -> failure "approval" "Bad_decision" msg "修正决定后重试"
  | Store.Artifact_missing -> failure "execution" "Artifact_missing" "产物缺失" "不要改走旧执行桥"
  | Store.Artifact_corrupt -> failure "execution" "Artifact_corrupt" "产物损坏" "不要改走旧执行桥"
  | Store.Version_mismatch -> failure "toolchain" "Version_mismatch" "工具链身份不符" "不要放宽策略，也不要裸执行"
  | Store.Version_unavailable -> failure "admission" "Version_unavailable" "还没有可执行的接纳记录" "先接纳固定示例"
  | Store.Manifest_mismatch -> failure "execution" "Manifest_mismatch" "执行身份不一致" "使用已保存的 execution_hash"
  | Store.Stale_attempt -> failure "execution" "Stale_attempt" "旧尝试已失效" "只读查询后再决定是否恢复"
  | Store.Replay_incomplete -> failure "execution" "Replay_incomplete" "重放未完成" "不要补发外部请求"
  | Store.Admission_conflict -> failure "admission" "Admission_conflict" "接纳冲突" "不要写入第二个 Step"
  | Store.Run_mismatch -> failure "execution" "Run_mismatch" "run 身份不一致" "不要换路径重试"
  | other -> failure "execution" "Store" (Store.describe other) "回读快照，不要推断成功"

let compile_failure = function
  | Step_compile.Rejected msg -> failure "admission" "Rejected" msg "这是接纳拒绝，不会自动再生成"
  | Step_compile.Unavailable msg -> failure "toolchain" "Unavailable" msg "未完成的 run 停住，不回退旧工作台"
  | Step_compile.Store err -> store_failure err

let runtime_failure = function
  | Step_runtime.Store err -> store_failure err
  | Step_runtime.Unavailable msg -> failure "toolchain" "Unavailable" msg "未完成的 run 停住，不回退旧工作台"
  | Step_runtime.Rejected msg -> failure "execution" "Rejected" msg "不要自动重发"
  | Step_runtime.Blocked msg -> failure "execution" "Blocked" msg "不要自动重试 Fetch"

let activity_of = function
  | Some "Running" -> "uncertain"
  | _ -> "idle"

let notice_of = function
  | Some "Running" -> Some "上次尝试中断，等待核对/恢复"
  | _ -> None

let reply_of = function
  | Step_manifest.Continue text -> { tag = "Continue"; text }
  | Step_manifest.Done text -> { tag = "Done"; text }
  | Step_manifest.Ask text -> { tag = "Ask"; text }
  | Step_manifest.Partial text -> { tag = "Partial"; text }

let approval_of entries =
  let asks = List.filter (fun (entry : Journal.entry) -> entry.kind = "Ask_human") entries in
  let chosen =
    match List.find_opt (fun (entry : Journal.entry) -> entry.status = Journal.Pending) asks with
    | Some entry -> Some entry
    | None -> (match List.rev asks with entry :: _ -> Some entry | [] -> None)
  in
  match chosen with
  | None -> None
  | Some entry ->
      let recorded =
        match entry.status with
        | Journal.Done -> Some (Json.canonical entry.result)
        | Journal.Pending | Journal.Unknown -> None
      in
      Some
        {
          seq = entry.seq;
          request_hash = entry.req_hash;
          params = Json.canonical entry.req;
          recorded_decision = recorded;
        }

let derived_error state entries record_error =
  let unknown = List.exists (fun (entry : Journal.entry) -> entry.status = Journal.Unknown) entries in
  match state with
  | Some "BlockedUnknown" | _ when unknown ->
      Some (failure "execution" "Unknown_result" "可能已执行，禁止自动重试" "不要重试 Fetch")
  | Some "Failed" ->
      Some (failure "execution" "Failed" (match record_error with Some text -> text | None -> "执行失败") "这是终态，不要自动重发")
  | _ -> None

let model_id = "grok-4.5"
let prompt_version = "wb-grok-1"
let model_admission_key = "grok-step-1"
let max_model_text = 48000

let generation_path root run_id = Filename.concat (run_dir root run_id) "generation.json"

let model_fingerprint meta =
  Step_manifest.sha256
    (Json.canonical
       (Json.Assoc
          [
            ("fetch_url", Json.String meta.fetch_url);
            ("material", Json.String meta.material);
            ("model", Json.String model_id);
            ("prompt_version", Json.String prompt_version);
            ("task", Json.String meta.task);
          ]))

type generation = { status : string; fingerprint : string; text : string option; admit_error : string option }

let generation_of json =
  let status = Json.string_field "status" json in
  let fingerprint = Json.string_field "fingerprint" json in
  let text =
    match Json.field_opt "text" json with
    | None | Some Json.Null -> None
    | Some (Json.String text) -> Some text
    | _ -> raise (Json.Parse "text")
  in
  let admit_error =
    match Json.field_opt "admit_error" json with
    | None | Some Json.Null -> None
    | Some (Json.String text) -> Some text
    | _ -> raise (Json.Parse "admit_error")
  in
  if status <> "dispatched" && status <> "committed" then raise (Json.Parse "status");
  { status; fingerprint; text; admit_error }

let write_generation root run_id gen =
  write_atomic (generation_path root run_id)
    (Json.canonical
       (Json.Assoc
          [
            ("fingerprint", Json.String gen.fingerprint);
            ("model", Json.String model_id);
            ("prompt_version", Json.String prompt_version);
            ("status", Json.String gen.status);
            ("text", (match gen.text with None -> Json.Null | Some text -> Json.String text));
            ("admit_error", (match gen.admit_error with None -> Json.Null | Some text -> Json.String text));
          ]))

let read_generation root run_id =
  let path = generation_path root run_id in
  if not (Sys.file_exists path) then None else try Some (generation_of (Json.parse (read_file path))) with _ -> None

let index_from text from ch = try Some (String.index_from text from ch) with Not_found -> None

let extract_step text =
  let rec fences acc i =
    if i >= String.length text then List.rev acc
    else if i + 2 < String.length text && text.[i] = '`' && text.[i + 1] = '`' && text.[i + 2] = '`' then
      let start = i + 3 in
      match index_from text start '\n' with
      | None -> List.rev acc
      | Some nl -> (
          let lang = String.trim (String.sub text start (nl - start)) in
          let body_at = nl + 1 in
          let rec close k =
            match index_from text k '`' with
            | None -> None
            | Some p when p + 2 < String.length text && text.[p + 1] = '`' && text.[p + 2] = '`' -> Some p
            | Some p -> close (p + 1)
          in
          match close body_at with
          | None -> List.rev acc
          | Some p ->
              let body = String.sub text body_at (p - body_at) in
              fences ((lang, body) :: acc) (p + 3))
    else fences acc (i + 1)
  in
  match fences [] 0 with
  | [ (lang, body) ] ->
      let lang = String.lowercase_ascii lang in
      let body = String.trim body in
      let has_step =
        let needle = "module Step" in
        let rec loop i =
          if i + String.length needle > String.length body then false
          else if String.sub body i (String.length needle) = needle then true
          else loop (i + 1)
        in
        loop 0
      in
      if (lang = "" || lang = "ocaml") && body <> "" && text_ok ~limit:max_material body && String.starts_with ~prefix:"open Step_api" body && has_step then
        Some body
      else None
  | _ -> None

let project_meta ~source ?(phase_override = None) ?(admit_note = None) meta snap =
  match snap with
  | None ->
      {
        run_id = meta.run_id;
        phase = (match phase_override with Some phase -> phase | None -> "admission");
        execution_hash = meta.execution_hash;
        store_state = None;
        activity = "idle";
        revision = None;
        epoch = None;
        reply = None;
        pending_approval = None;
        error =
          (match admit_note with
          | None -> None
          | Some text -> (
              match String.split_on_char '\x1e' text with
              | layer :: code :: message :: retry :: [] when layer <> "" && code <> "" ->
                  Some (failure layer code message retry)
              | _ -> Some (failure "admission" "Rejected" text "这是接纳拒绝，不会自动再生成")));
        source_hash = Some (Step_manifest.sha256 source);
        artifact_hash = None;
        compiler_id = None;
        runtime_id = None;
        policy_version = None;
        material = meta.material;
        task = meta.task;
        fetch_url = meta.fetch_url;
        compile_count = meta.compile_count;
        notice =
          (match phase_override with
          | Some "generation" -> Some "生成已派出，结果未知。不要自动再请求。"
          | _ when source <> fixed_source -> Some "生成结果已保存，但没有接纳。不会自动再请求 Grok。"
          | _ -> None);
        source;
      }
  | Some ((record : Step_manifest.record), revision, epoch, entries) ->
      let state = Step_manifest.state_name record.state in
      {
        run_id = meta.run_id;
        phase = "execution";
        execution_hash = Some record.manifest.execution_hash;
        store_state = Some state;
        activity = activity_of (Some state);
        revision = Some revision;
        epoch = Some epoch;
        reply = (match record.reply with None -> None | Some reply -> Some (reply_of reply));
        pending_approval = approval_of entries;
        error = derived_error (Some state) entries record.error;
        source_hash = Some record.manifest.source_hash;
        artifact_hash = Some record.manifest.artifact_hash;
        compiler_id = Some record.manifest.compiler_id;
        runtime_id = Some record.manifest.runtime_id;
        policy_version = Some record.manifest.policy_version;
        material = meta.material;
        task = meta.task;
        fetch_url = meta.fetch_url;
        compile_count = meta.compile_count;
        notice = notice_of (Some state);
        source;
      }

let read_meta root run_id =
  match meta_of (Json.parse (read_file (meta_path root run_id))) with
  | meta when meta.run_id = run_id && run_id_ok run_id -> Ok meta
  | _ -> Error (failure "protocol" "Corrupt_meta" "run 元数据无效" "不要用客户端路径修复")

let read_owned root ~owner run_id =
  if not (owner_ok owner) then Error (failure "auth" "owner" "owner 无效" "使用已验证身份")
  else if not (run_id_ok run_id) then Error (failure "auth" "run_id" "run_id 无效" "不要提交路径")
  else
    let dir = run_dir root run_id in
    if not (Sys.file_exists dir) then Error (failure "auth" "not_found" "run 不存在" "刷新列表")
    else if (not (no_symlink dir)) || not (real_inside root dir) then
      Error (failure "auth" "path_escape" "路径越界" "拒绝访问")
    else
      match read_meta root run_id with
      | Error _ as err -> err
      | Ok meta when meta.owner <> owner -> Error (failure "auth" "forbidden" "run 不属于当前身份" "拒绝访问")
      | Ok meta -> Ok meta

let snapshot_view root run_id =
  let path = step_path root run_id in
  if not (Sys.file_exists path) then None
  else
    match Store.read_snapshot path with
    | Error _ -> None
    | Ok snap -> (
        match snap.step with
        | None -> None
        | Some record -> Some (record, snap.revision, snap.epoch, !(snap.journal.entries)))

let project_owned root meta =
  let gen = read_generation root meta.run_id in
  let source =
    match gen with
    | Some { status = "committed"; text = Some text; _ } -> (match extract_step text with Some src -> src | None -> text)
    | _ -> fixed_source
  in
  let phase_override = match gen with Some { status = "dispatched"; _ } -> Some "generation" | _ -> None in
  let admit_note = match gen with Some { admit_error = Some text; _ } -> Some text | _ -> None in
  let view =
    match snapshot_view root meta.run_id with
    | None -> None
    | Some (record, revision, epoch, entries) -> Some (record, revision, epoch, entries)
  in
  project_meta ~source ~phase_override ~admit_note meta view

let locate ~root ~owner run_id =
  match read_owned root ~owner run_id with
  | Error failure -> err failure.layer failure.code failure.message failure.retry_advice
  | Ok meta -> ok_one (project_owned root meta)

let ensure_tree path mode =
  let rec walk path =
    if path = "/" || path = "." then ()
    else
      let parent = Filename.dirname path in
      if parent <> path then walk parent;
      ensure_dir path mode
  in
  walk path

let ensure_layout root owner =
  ensure_tree root 0o700;
  ensure_dir (runs_dir root) 0o700;
  ensure_dir (Filename.concat root "index") 0o700;
  ensure_dir (index_dir root owner) 0o700

let index_of text =
  let json = Json.parse text in
  (Json.string_field "run_id" json, Json.string_field "fingerprint" json, Json.string_field "dedupe_key" json, match Json.field "ready" json with Json.Bool ready -> ready | _ -> raise (Json.Parse "ready"))

let write_index root owner key ~run_id ~fingerprint ~ready =
  write_atomic (index_path root owner key)
    (Json.canonical
       (Json.Assoc
          [
            ("dedupe_key", Json.String key);
            ("fingerprint", Json.String fingerprint);
            ("ready", Json.Bool ready);
            ("run_id", Json.String run_id);
          ]))

let write_meta root meta = write_atomic (meta_path root meta.run_id) (Json.canonical (meta_json meta))

let blank_meta ~run_id ~owner ~dedupe_key ~fingerprint ~material ~task ~fetch_url =
  { run_id; owner; dedupe_key; fingerprint; material; task; fetch_url; execution_hash = None; compile_count = 0 }

let protect f =
  try f () with
  | Json.Parse msg -> err "protocol" "bad_json" msg "拒绝该帧"
  | Failure msg -> err "protocol" "rejected" msg "拒绝该请求"
  | Unix.Unix_error (code, fn, _) -> err "toolchain" "io" (Unix.error_message code ^ " " ^ fn) "不要改走旧执行桥"
  | Sys_error msg -> err "toolchain" "io" msg "不要改走旧执行桥"

let create_run ~root ~owner ~fetch_url ~dedupe_key ~material ~task =
  protect (fun () ->
  if not (owner_ok owner) then err "auth" "owner" "owner 无效" "使用已验证身份"
  else if not (url_ok fetch_url) then err "input" "fetch_url" "受控端点未配置或不是精确的 loopback /spec" "不要提交用户 URL"
  else if not (key_ok dedupe_key) then err "input" "dedupe_key" "去重键无效" "使用不含路径的短键"
  else if material = "" || not (text_ok ~limit:max_material material) then err "input" "material" "材料为空、过大或不是 UTF-8" "缩短材料"
  else if not (text_ok ~limit:max_task task) then err "input" "task" "任务说明无效" "缩短说明"
  else
    let fingerprint = fingerprint ~owner ~dedupe_key ~material ~task ~fetch_url in
    ensure_layout root owner;
    with_lock (index_lock root owner dedupe_key) (fun () ->
        let path = index_path root owner dedupe_key in
        let existing =
          if Sys.file_exists path then Some (index_of (read_file path)) else None
        in
        match existing with
        | Some (_, other, _, _) when other <> fingerprint -> err "input" "conflict" "相同去重键对应了不同输入" "换一个新 run，不要覆盖"
        | Some (run_id, _, _, true) -> locate ~root ~owner run_id
        | Some (run_id, _, _, false) ->
            let dir = run_dir root run_id in
            ensure_dir dir 0o700;
            if (not (no_symlink dir)) || not (real_inside root dir) then err "auth" "path_escape" "路径越界" "拒绝访问"
            else (
              ensure_dir (Filename.concat dir "step") 0o700;
              let meta =
                if Sys.file_exists (meta_path root run_id) then (
                  match read_meta root run_id with
                  | Ok meta when meta.fingerprint = fingerprint && meta.owner = owner -> meta
                  | _ -> blank_meta ~run_id ~owner ~dedupe_key ~fingerprint ~material ~task ~fetch_url)
                else blank_meta ~run_id ~owner ~dedupe_key ~fingerprint ~material ~task ~fetch_url
              in
              write_meta root meta;
              write_index root owner dedupe_key ~run_id ~fingerprint ~ready:true;
              ok_one (project_owned root meta))
        | None ->
            let run_id = hex_bytes 16 in
            if not (run_id_ok run_id) then err "protocol" "run_id" "无法分配 run" "重试创建"
            else (
              write_index root owner dedupe_key ~run_id ~fingerprint ~ready:false;
              let dir = run_dir root run_id in
              ensure_dir dir 0o700;
              if (not (no_symlink dir)) || not (real_inside root dir) then err "auth" "path_escape" "路径越界" "拒绝访问"
              else (
                ensure_dir (Filename.concat dir "step") 0o700;
                let meta = blank_meta ~run_id ~owner ~dedupe_key ~fingerprint ~material ~task ~fetch_url in
                write_meta root meta;
                write_index root owner dedupe_key ~run_id ~fingerprint ~ready:true;
                ok_one (project_owned root meta)))))

let list_runs ~root ~owner =
  protect (fun () ->
  if not (owner_ok owner) then err "auth" "owner" "owner 无效" "使用已验证身份"
  else (
    ensure_layout root owner;
    let dir = index_dir root owner in
    let names = Array.to_list (Sys.readdir dir) |> List.filter (fun name -> String.ends_with ~suffix:".json" name) |> List.sort String.compare in
    let rec take n acc = function
      | [] -> (List.rev acc, false)
      | _ when n = 0 -> (List.rev acc, true)
      | name :: rest -> (
          match index_of (read_file (Filename.concat dir name)) with
          | run_id, _, _, true -> (
              match read_owned root ~owner run_id with
              | Ok meta -> take (n - 1) (project_owned root meta :: acc) rest
              | Error _ -> take n acc rest)
          | _ -> take n acc rest
          | exception _ -> take n acc rest)
    in
    let runs, truncated = take max_runs [] names in
    { ok = true; projection = None; error = None; runs; truncated }))

let load_for_mutation root ~owner run_id =
  match read_owned root ~owner run_id with
  | Error failure -> Error failure
  | Ok meta -> Ok meta

let expected_input_hash meta =
  match input_bytes meta.material meta.fetch_url with
  | Error err -> Error (failure "admission" "input" (Step_manifest.describe err) "不要更换已保存的输入")
  | Ok text -> Ok (Step_manifest.sha256 text)

let matching_record meta record =
  record.Step_manifest.manifest.source_hash = source_hash
  && record.manifest.run_id = meta.run_id
  &&
  match expected_input_hash meta with
  | Error _ -> false
  | Ok hash -> record.manifest.input_context_hash = hash

let note_admit_error root run_id (error : failure) =
  match read_generation root run_id with
  | None -> ()
  | Some gen ->
      let message = if String.length error.message <= 1800 then error.message else String.sub error.message 0 1800 in
      let packed = String.concat "\x1e" [ error.layer; error.code; message; error.retry_advice ] in
      write_generation root run_id { gen with admit_error = Some packed }

let admit_saved root meta source =
  let path = step_path root meta.run_id in
  let got_hash = Step_manifest.sha256 source in
  let same record =
    match expected_input_hash meta with
    | Error _ -> false
    | Ok hash ->
        record.Step_manifest.manifest.input_context_hash = hash && record.manifest.run_id = meta.run_id && record.manifest.source_hash = got_hash
  in
  match snapshot_view root meta.run_id with
  | Some (record, _, _, _) when same record ->
      let meta = { meta with execution_hash = Some record.Step_manifest.manifest.execution_hash; compile_count = max meta.compile_count 1 } in
      write_meta root meta;
      ok_one (project_owned root meta)
  | Some _ -> err "admission" "Admission_conflict" "已有接纳与这次生成不一致" "不要编译第二个 Step"
  | None -> (
      match
        Step_compile.submit ~path ~run_id:meta.run_id ~agent_version ~admission_key:model_admission_key ~source ~modules:[]
          ~input:[ ("material", meta.material); ("fetch_url", meta.fetch_url) ]
      with
      | Error compile_err ->
          let failure = compile_failure compile_err in
          note_admit_error root meta.run_id failure;
          with_error (project_owned root meta) failure
      | Ok manifest -> (
          match snapshot_view root meta.run_id with
          | Some (record, _, _, _) when record.manifest.execution_hash = manifest.execution_hash ->
              let meta = { meta with execution_hash = Some manifest.execution_hash; compile_count = meta.compile_count + 1 } in
              write_meta root meta;
              ok_one (project_owned root meta)
          | _ -> err "admission" "Admission_conflict" "接纳结果与快照不一致" "不要写入第二个 Step"))

let saved_step gen =
  match gen with
  | { status = "committed"; text = Some text; _ } -> extract_step text
  | _ -> None

let reserve_model ~root ~owner ~run_id =
  protect (fun () ->
      match load_for_mutation root ~owner run_id with
      | Error failure -> err failure.layer failure.code failure.message failure.retry_advice
      | Ok meta ->
          if not (url_ok meta.fetch_url) then err "input" "fetch_url" "已保存的端点不是受控 /spec" "不要改写 URL"
          else
            with_lock (prepare_lock root run_id) (fun () ->
                let fingerprint = model_fingerprint meta in
                match read_generation root run_id with
                | Some gen when gen.fingerprint <> fingerprint ->
                    err "generation" "Request_changed" "已保存的生成请求与这条 run 不一致" "不要改材料后重发"
                | Some gen -> (
                    match saved_step gen with
                    | Some source -> admit_saved root meta source
                    | None when gen.status = "committed" ->
                        let rejected = failure "admission" "Rejected" "已保存的生成结果不是唯一的 Step" "不会自动再生成" in
                        note_admit_error root run_id rejected;
                        with_error (project_owned root meta) rejected
                    | None when gen.status = "dispatched" ->
                        with_error (project_owned root meta)
                          (failure "generation" "Unknown_result" "生成结果未知，禁止自动再请求" "不要重试模型。若要再生成，新建一条 run，并注意可能重复计费")
                    | None -> err "protocol" "Corrupt_meta" "生成记录无效" "不要重发")
                | None ->
                    write_generation root run_id { status = "dispatched"; fingerprint; text = None; admit_error = None };
                    with_error (project_owned root meta) (failure "generation" "Needs_model" "可以由服务端请求一次模型" "浏览器不能提交源码")))

let commit_model ~root ~owner ~run_id ~model_text =
  protect (fun () ->
      if not (text_ok ~limit:max_model_text model_text) then
        err "generation" "Unknown_result" "模型响应无法按原样保存" "不要截断后当成成功，也不要自动再请求"
      else
        match load_for_mutation root ~owner run_id with
        | Error failure -> err failure.layer failure.code failure.message failure.retry_advice
        | Ok meta ->
            with_lock (prepare_lock root run_id) (fun () ->
                let fingerprint = model_fingerprint meta in
                match read_generation root run_id with
                | None -> err "generation" "state" "还没有派发记录" "不要提交浏览器源码"
                | Some gen when gen.fingerprint <> fingerprint -> err "generation" "Request_changed" "生成请求已变化" "不要覆盖已保存的结果"
                | Some { status = "committed"; text = Some saved; _ } when saved <> model_text ->
                    err "generation" "Admission_conflict" "已提交的模型结果不同" "不要覆盖"
                | Some ({ status = "committed"; text = Some _; _ } as gen) -> (
                    match saved_step gen with
                    | Some source -> admit_saved root meta source
                    | None ->
                        let rejected = failure "admission" "Rejected" "已保存的生成结果不是唯一的 Step" "不会自动再生成" in
                        note_admit_error root run_id rejected;
                        with_error (project_owned root meta) rejected)
                | Some { status = "dispatched"; _ } ->
                    let gen = { status = "committed"; fingerprint; text = Some model_text; admit_error = None } in
                    write_generation root run_id gen;
                    (match saved_step gen with
                    | Some source -> admit_saved root meta source
                    | None ->
                        let rejected = failure "admission" "Rejected" "生成结果没有唯一的 Step 源码" "不会自动再生成" in
                        note_admit_error root run_id rejected;
                        with_error (project_owned root meta) rejected)
                | Some _ -> err "protocol" "Corrupt_meta" "生成记录无效" "不要重发"))

let prepare_run ~root ~owner ~run_id =
  protect (fun () ->
  match load_for_mutation root ~owner run_id with
  | Error failure -> err failure.layer failure.code failure.message failure.retry_advice
  | Ok meta ->
      if not (url_ok meta.fetch_url) then err "input" "fetch_url" "已保存的端点不是受控 /spec" "不要改写 URL"
      else
        with_lock (prepare_lock root run_id) (fun () ->
            let path = step_path root meta.run_id in
            let finish meta record =
              let meta = { meta with execution_hash = Some record.Step_manifest.manifest.execution_hash; compile_count = max meta.compile_count 1 } in
              write_meta root meta;
              ok_one (project_owned root meta)
            in
            match snapshot_view root meta.run_id with
            | Some (record, _, _, _) when matching_record meta record -> finish meta record
            | Some _ -> err "admission" "Admission_conflict" "已有接纳与固定示例不一致" "不要编译第二个 Step"
            | None -> (
                match Step_compile.submit ~path ~run_id:meta.run_id ~agent_version ~admission_key ~source:fixed_source ~modules:[]
                        ~input:[ ("material", meta.material); ("fetch_url", meta.fetch_url) ]
                with
                | Error compile_err ->
                    let failure = compile_failure compile_err in
                    err failure.layer failure.code failure.message failure.retry_advice
                | Ok manifest -> (
                    match snapshot_view root meta.run_id with
                    | None -> err "admission" "missing" "接纳后读不到快照" "不要重编译另一份程序"
                    | Some (record, _, _, _) when record.manifest.execution_hash = manifest.execution_hash ->
                        let meta = { meta with execution_hash = Some manifest.execution_hash; compile_count = meta.compile_count + 1 } in
                        write_meta root meta;
                        ok_one (project_owned root meta)
                    | Some _ -> err "admission" "Admission_conflict" "接纳结果与快照不一致" "不要写入第二个 Step"))))

let start_or_resume ~root ~owner ~run_id ~execution_hash =
  protect (fun () ->
  match load_for_mutation root ~owner run_id with
  | Error failure -> err failure.layer failure.code failure.message failure.retry_advice
  | Ok meta -> (
      match meta.execution_hash with
      | None -> err "admission" "not_admitted" "还没有保存的产物" "不要在缺少 artifact 时重新编译"
      | Some saved when saved <> execution_hash || not (Step_manifest.hash_ok execution_hash) ->
          err "execution" "Manifest_mismatch" "execution_hash 与已保存的不一致" "不要重新规划或编译"
      | Some saved ->
          let path = step_path root run_id in
          if not (Sys.file_exists path) then err "execution" "Artifact_missing" "产物缺失" "不要现场重新编译"
          else
            let outcome = Step_runtime.run ~path ~execution_hash:saved ~allowed_url:meta.fetch_url in
            let meta = match read_meta root run_id with Ok meta -> meta | Error _ -> meta in
            let projection = project_owned root meta in
            match outcome with
            | Ok _ -> ok_one projection
            | Error err ->
                let failure = runtime_failure err in
                with_error projection failure))

let decision_json = function
  | `Approved -> Json.Assoc [ ("tag", Json.String "Approved") ]
  | `Rejected reason -> Json.Assoc [ ("tag", Json.String "Rejected"); ("reason", Json.String reason) ]

let parse_decision = function
  | Json.Assoc [ ("tag", Json.String "Approved") ] -> Ok (`Approved, decision_json `Approved)
  | Json.Assoc fields -> (
      match (List.assoc_opt "tag" fields, List.assoc_opt "reason" fields) with
      | Some (Json.String "Approved"), None when List.length fields = 1 -> Ok (`Approved, decision_json `Approved)
      | Some (Json.String "Rejected"), Some (Json.String reason) when reason <> "" && String.length reason <= 500 && utf8 reason 0 && List.length fields = 2 ->
          Ok (`Rejected reason, decision_json (`Rejected reason))
      | _ -> Error (failure "approval" "Bad_decision" "决定必须是 Approved 或带理由的 Rejected" "不要提交自由文本授权"))
  | _ -> Error (failure "approval" "Bad_decision" "决定格式无效" "不要提交自由文本授权")

let same_decision entry callback decision =
  entry.Journal.callback_id = callback && entry.result = decision

let decide_approval ~root ~owner ~run_id ~execution_hash ~seq ~callback_id ~request_hash ~decision =
  protect (fun () ->
  if (not (callback_ok callback_id)) || not (Step_manifest.hash_ok request_hash) then
    err "approval" "Bad_decision" "callback 或请求哈希无效" "重试必须复用同一次决定"
  else if seq < 0 then err "approval" "Bad_decision" "seq 无效" "使用保存的 seq"
  else
    match load_for_mutation root ~owner run_id with
    | Error failure -> err failure.layer failure.code failure.message failure.retry_advice
    | Ok meta -> (
        match meta.execution_hash with
        | Some saved when saved = execution_hash -> (
            match parse_decision decision with
            | Error failure -> err failure.layer failure.code failure.message failure.retry_advice
            | Ok (_, decision_json) ->
                let path = step_path root run_id in
                let completed_same () =
                  match Store.read_snapshot path with
                  | Ok snap -> (
                      match snap.step with
                      | Some record when record.state = Step_manifest.Completed -> (
                          match Journal.nth snap.journal seq with
                          | Some entry
                            when entry.kind = "Ask_human" && entry.req_hash = request_hash && entry.status = Journal.Done
                                 && same_decision entry callback_id decision_json ->
                              Ok ()
                          | _ -> Error (failure "approval" "Approval_conflict" "已完成，决定不匹配" "只读核对，不要修改"))
                      | _ -> Error (failure "approval" "state" "审批没有写入" "重新查询"))
                  | Error err -> Error (store_failure err)
                in
                let result =
                  match Store.approve_step ~path ~execution_hash ~seq ~callback_id ~expected_request_hash:request_hash ~decision_json with
                  | Ok () -> Ok ()
                  | Error (Store.Protocol "completed") -> completed_same ()
                  | Error err -> Error (store_failure err)
                in
                let meta = match read_meta root run_id with Ok meta -> meta | Error _ -> meta in
                let projection = project_owned root meta in
                match result with
                | Ok () -> ok_one projection
                | Error failure -> with_error projection failure)
        | _ -> err "execution" "Manifest_mismatch" "execution_hash 与已保存的不一致" "不要批准另一份程序"))

let projection_json (p : projection) =
  let opt_string = function
    | None -> Json.Null
    | Some text -> Json.String text
  in
  let opt_int = function
    | None -> Json.Null
    | Some n -> Json.Int n
  in
  let reply =
    match p.reply with
    | None -> Json.Null
    | Some reply -> Json.Assoc [ ("tag", Json.String reply.tag); ("text", Json.String reply.text) ]
  in
  let approval =
    match p.pending_approval with
    | None -> Json.Null
    | Some approval ->
        Json.Assoc
          [
            ("params", Json.String approval.params);
            ("recorded_decision", opt_string approval.recorded_decision);
            ("request_hash", Json.String approval.request_hash);
            ("seq", Json.Int approval.seq);
          ]
  in
  let error =
    match p.error with
    | None -> Json.Null
    | Some error ->
        Json.Assoc
          [
            ("code", Json.String error.code);
            ("layer", Json.String error.layer);
            ("message", Json.String error.message);
            ("retry_advice", Json.String error.retry_advice);
          ]
  in
  Json.Assoc
    [
      ("activity", Json.String p.activity);
      ("artifact_hash", opt_string p.artifact_hash);
      ("compile_count", Json.Int p.compile_count);
      ("compiler_id", opt_string p.compiler_id);
      ("epoch", opt_int p.epoch);
      ("error", error);
      ("execution_hash", opt_string p.execution_hash);
      ("fetch_url", Json.String p.fetch_url);
      ("material", Json.String p.material);
      ("notice", opt_string p.notice);
      ("pending_approval", approval);
      ("phase", Json.String p.phase);
      ("policy_version", opt_string p.policy_version);
      ("reply", reply);
      ("revision", opt_int p.revision);
      ("run_id", Json.String p.run_id);
      ("runtime_id", opt_string p.runtime_id);
      ("source", Json.String p.source);
      ("source_hash", opt_string p.source_hash);
      ("store_state", opt_string p.store_state);
      ("task", Json.String p.task);
    ]

let failure_json error =
  Json.Assoc
    [
      ("code", Json.String error.code);
      ("layer", Json.String error.layer);
      ("message", Json.String error.message);
      ("retry_advice", Json.String error.retry_advice);
    ]

let answer_json answer =
  Json.Assoc
    [
      ("error", (match answer.error with None -> Json.Null | Some error -> failure_json error));
      ("ok", Json.Bool answer.ok);
      ("projection", (match answer.projection with None -> Json.Null | Some projection -> projection_json projection));
      ("runs", Json.List (List.map projection_json answer.runs));
      ("truncated", Json.Bool answer.truncated);
    ]
