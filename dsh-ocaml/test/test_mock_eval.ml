(** Offline evaluation. Same script, same trajectory bytes, no network. *)

open Core.Types

let fail fmt = Printf.ksprintf failwith fmt

let check name cond =
  if not cond then fail "FAIL %s" name

let tool id name args = { id; name; args_json = args }

let agent prompt () =
  Core.Agent.react ~model:"deepseek-v4" ~messages:[ { role = User; content = prompt } ] ()

let run env ~responses ~approvals ~max_steps ~max_tokens prompt =
  Dsh_ocaml.Runtime.run_harness ~env ~responses ~approvals ~max_steps ~max_tokens
    ~mode:(Evaluation "dsh-test-eval.jsonl")
    ~agent_entry:(agent prompt) ()

let event_name = function
  | LLMStart _ -> "llm_start"
  | LLMEnd _ -> "llm_end"
  | ToolStart (name, _) -> "tool_start:" ^ name
  | ToolEnd (name, Ok _) -> "tool_end:" ^ name ^ ":ok"
  | ToolEnd (name, Error _) -> "tool_end:" ^ name ^ ":err"
  | ApprovalRequested _ -> "approval"

let names events = List.map event_name events

let assert_tool_end events name result =
  match
    List.find_map
      (function ToolEnd (n, r) when n = name -> Some r | _ -> None)
      events
  with
  | None -> fail "missing ToolEnd %s" name
  | Some got when got = result -> ()
  | Some got ->
      let show = function Ok t -> "Ok " ^ t | Error t -> "Error " ^ t in
      fail "ToolEnd %s = %s, want %s" name (show got) (show result)

let test_parse () =
  let hello =
    Harness.Llm_provider.parse_body
      "{\"choices\":[{\"message\":{\"content\":\"hello\"}}]}"
  in
  check "json content" (hello = TextResponse "hello");
  let sse =
    String.concat "\n"
      [
        "data: {\"choices\":[{\"delta\":{\"content\":\"he\"}}]}";
        "";
        "data: {\"choices\":[{\"delta\":{\"content\":\"llo\"}}]}";
        "data: [DONE]";
      ]
  in
  check "sse content" (Harness.Llm_provider.parse_body sse = TextResponse "hello");
  let call =
    Harness.Llm_provider.parse_body
      "{\"choices\":[{\"message\":{\"tool_calls\":[{\"function\":{\"name\":\"shell\",\"arguments\":\"echo hi\"}}]}}]}"
  in
  check "tool json"
    (call = ToolCallResponse [ { id = "call"; name = "shell"; args_json = "echo hi" } ]);
  let body =
    Harness.Llm_provider.request_body ~model:"deepseek-v4"
      [ { role = User; content = "ping" } ]
  in
  let needle = "\"stream\":false" in
  let n = String.length body and m = String.length needle in
  let rec has i =
    if i + m > n then false else if String.sub body i m = needle then true else has (i + 1)
  in
  if not (has 0) then fail "request missing stream:false: %s" body

let test_det env =
  let responses =
    [
      ToolCallResponse [ tool "1" "shell" "echo hello" ];
      TextResponse "done";
    ]
  in
  let a, mock_a = run env ~responses ~approvals:[] ~max_steps:16 ~max_tokens:8000 "打个招呼" in
  let b, mock_b = run env ~responses ~approvals:[] ~max_steps:16 ~max_tokens:8000 "打个招呼" in
  check "value" (a.value = "done" && b.value = "done");
  check "bytes" (Harness.Trajectory.events_json a.events = Harness.Trajectory.events_json b.events);
  check "commands" (mock_a.commands = [ "echo hello" ] && mock_b.commands = mock_a.commands);
  check "trace"
    (names a.events
    = [
        "llm_start";
        "llm_end";
        "tool_start:shell";
        "tool_start:sandbox_exec";
        "tool_end:sandbox_exec:ok";
        "tool_end:shell:ok";
        "llm_start";
        "llm_end";
      ]);
  let path = Eio.Path.(Eio.Stdenv.cwd env / "dsh-test-eval.jsonl") in
  let on_disk = Eio.Path.load path in
  check "saved" (on_disk = Harness.Trajectory.events_json b.events);
  Eio.Path.unlink path

let test_deny env =
  let responses =
    [
      ToolCallResponse [ tool "w" "write_file" "notes.txt\nsecret" ];
      ToolCallResponse [ tool "d" "delete_file" "notes.txt" ];
      ToolCallResponse [ tool "r" "read_file" "notes.txt" ];
      TextResponse "kept";
    ]
  in
  let outcome, mock = run env ~responses ~approvals:[ false ] ~max_steps:16 ~max_tokens:8000 "删掉" in
  check "kept value" (outcome.value = "kept");
  check "no shell" (mock.commands = []);
  check "file remains" (List.assoc_opt "notes.txt" mock.files = Some "secret");
  assert_tool_end outcome.events "delete_file" (Error "用户拒绝了该高危操作");
  check "asked" (List.exists (function ApprovalRequested _ -> true | _ -> false) outcome.events)

let test_approve env =
  let responses =
    [
      ToolCallResponse [ tool "w" "write_file" "notes.txt\nsecret" ];
      ToolCallResponse [ tool "d" "delete_file" "notes.txt" ];
      ToolCallResponse [ tool "r" "read_file" "notes.txt" ];
      TextResponse "gone";
    ]
  in
  let outcome, mock = run env ~responses ~approvals:[ true ] ~max_steps:16 ~max_tokens:8000 "删掉" in
  check "gone value" (outcome.value = "gone");
  check "deleted" (List.assoc_opt "notes.txt" mock.files = None);
  assert_tool_end outcome.events "delete_file" (Ok "deleted notes.txt");
  assert_tool_end outcome.events "read_file" (Error "missing notes.txt")

let test_steps env =
  let responses =
    [ ToolCallResponse [ tool "1" "shell" "echo hello" ]; TextResponse "nope" ]
  in
  match run env ~responses ~approvals:[] ~max_steps:1 ~max_tokens:8000 "step" with
  | _ -> fail "steps should discontinue"
  | exception Harness.Budget.Budget_exceeded msg -> check "step msg" (msg = "steps 2/1")

let test_tokens env =
  let fat = String.make 8 'x' in
  match run env ~responses:[ TextResponse "nope" ] ~approvals:[] ~max_steps:4 ~max_tokens:1 fat with
  | _ -> fail "tokens should discontinue"
  | exception Harness.Budget.Budget_exceeded msg -> check "token msg" (msg = "tokens 2/1")

let test_dry env =
  let outcome, mock =
    Dsh_ocaml.Runtime.run_harness ~env ~mode:DryRun ~agent_entry:(agent "删掉 notes.txt") ()
  in
  check "dry value" (outcome.value = "dry-run：高危操作已拒绝，未执行。");
  check "dry commands" (mock.commands = []);
  assert_tool_end outcome.events "delete_file" (Error "用户拒绝了该高危操作")

let () =
  test_parse ();
  Eio_main.run @@ fun env ->
  test_det env;
  test_deny env;
  test_approve env;
  test_steps env;
  test_tokens env;
  test_dry env;
  Eio.Path.unlink ~missing_ok:true Eio.Path.(Eio.Stdenv.cwd env / "dsh-test-eval.jsonl");
  print_endline "mock eval ok"
