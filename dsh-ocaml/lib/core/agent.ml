(** Pure ReAct loop. The only way out to the world is [Effect.perform]. *)

open Effect
open Types
open Effects

let react ~model ~messages () =
  let rec loop messages =
    perform (EmitTrajectory (LLMStart messages));
    let response = perform (AskLLM { messages; model }) in
    perform (EmitTrajectory (LLMEnd response));
    match response with
    | TextResponse text -> text
    | ToolCallResponse [] -> ""
    | ToolCallResponse calls ->
        let messages = ref (messages @ [ { role = Assistant; content = "调用工具" } ]) in
        List.iter
          (fun (call : tool_call) ->
            perform (EmitTrajectory (ToolStart (call.name, call.args_json)));
            let result = perform (CallTool { name = call.name; args_json = call.args_json }) in
            perform (EmitTrajectory (ToolEnd (call.name, result)));
            let body = match result with Ok text -> text | Error text -> "error: " ^ text in
            messages := !messages @ [ { role = ToolResult call.id; content = body } ])
          calls;
        loop !messages
  in
  loop messages
