(** Mock world. The only place that turns an effect into a value.
    Time and ids come from this record, never from [Unix] or [Random]. *)

module Map = Map.Make (String)

type llm_mode =
  | Correct_first
  | Wrong_then_right
  | Always_wrong

type side = {
  key : string;
  name : string;
  duplicate : bool;
}

type t = {
  mutable files : string Map.t;
  mutable cache : Json.t Map.t;
  mutable log : side list;
  mutable sandbox_execs : int;
  mutable next_id : int;
  mutable fetch : (Proto.fetch_request -> Proto.fetch_reply) option;
  clock : int;
}

let math_path = "src/math.ml"
let buggy_add = "let add x y = x - y\n"
let fixed_add = "let add x y = x + y\n"
let wrong_patch = "let add x y = x - y + 0\n"

let create () =
  {
    files = Map.singleton math_path buggy_add;
    cache = Map.empty;
    log = [];
    sandbox_execs = 0;
    next_id = 1;
    fetch = None;
    clock = 1_725_000_000;
  }

let copy w =
  { w with files = w.files; cache = w.cache; log = w.log }

let file_is_add content =
  Proto.contains content "x + y" && not (Proto.contains content "x - y")

let mock_llm req mode =
  if req.Proto.purpose = "compact" then
    {
      Proto.text = Printf.sprintf "摘要(%d): 把 src/math.ml 的 add 改成加法" (List.length req.messages);
      tool = None;
    }
  else if req.purpose = "plan" then
    { Proto.text = "先读 src/math.ml，再 apply_patch。"; tool = None }
  else if req.purpose = "retry" then
    let content = if mode = Always_wrong then wrong_patch else fixed_add in
    { Proto.text = "按诊断改正"; tool = Some ("apply_patch", Json.Assoc [ ("path", Json.String math_path); ("content", Json.String content) ]) }
  else
    let content = if mode = Correct_first then fixed_add else wrong_patch in
    { Proto.text = "提交补丁"; tool = Some ("apply_patch", Json.Assoc [ ("path", Json.String math_path); ("content", Json.String content) ]) }

let run_tool name args w sandbox =
  let record result =
    if sandbox then w.sandbox_execs <- w.sandbox_execs + 1;
    if sandbox then { result with Proto.output = "[sandbox] " ^ result.Proto.output } else result
  in
  let path = Json.assoc_string "path" args in
  match name with
  | "read_file" ->
      let content = match Map.find_opt path w.files with Some s -> s | None -> "" in
      record { Proto.ok = true; output = content; diagnostics = [] }
  | "apply_patch" | "write_file" ->
      let content = Json.assoc_string "content" args in
      w.files <- Map.add path content w.files;
      record { Proto.ok = true; output = "wrote " ^ path; diagnostics = [] }
  | "lint" ->
      let content = match Map.find_opt path w.files with Some s -> s | None -> "" in
      if file_is_add content then record { Proto.ok = true; output = "lint clean"; diagnostics = [] }
      else
        record
          {
            Proto.ok = false;
            output = "lint failed";
            diagnostics = [ "src/math.ml:1 add 仍不是加法，期望 `x + y`" ];
          }
  | "shell" -> record { Proto.ok = true; output = "published"; diagnostics = [] }
  | other ->
      record
        {
          Proto.ok = false;
          output = "unknown tool " ^ other;
          diagnostics = [ "没有工具 " ^ other ];
        }

let interpret (type a) (e : a Effect.t) w ~sandbox ~llm_mode : a =
  match e with
  | Proto.Now -> float_of_int w.clock
  | Proto.Fresh_id ->
      let id = Printf.sprintf "id-%d" w.next_id in
      w.next_id <- w.next_id + 1;
      id
  | Proto.Checkpoint _ -> ()
  | Proto.Llm req -> mock_llm req llm_mode
  | Proto.Tool call -> run_tool call.name call.args w sandbox
  | Proto.Fetch req ->
      if not sandbox then raise (Proto.Harness_error "Fetch 只在沙箱 profile 里执行")
      else (
        w.sandbox_execs <- w.sandbox_execs + 1;
        match w.fetch with
        | None -> { Proto.status = 200; body = "fetched " ^ req.url }
        | Some fetch -> fetch req)
  | Proto.Ask_human _ -> raise (Proto.Harness_error "world 不应直接执行 Ask_human")
  | Proto.Compact _ -> raise (Proto.Harness_error "world 不应直接执行 Compact")
  | _ -> raise (Proto.Harness_error "world 不认识这个 effect")

let mutation_count w =
  List.length
    (List.filter
       (fun s -> (not s.duplicate) && (s.name = "apply_patch" || s.name = "write_file" || s.name = "shell"))
       w.log)

let file w path = match Map.find_opt path w.files with Some s -> s | None -> ""
