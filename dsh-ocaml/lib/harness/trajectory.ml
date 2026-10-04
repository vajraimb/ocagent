open Effect.Deep
open Core.Effects
open Core.Types

let with_trajectory ~on_event f =
  match_with f ()
    {
      retc = (fun x -> x);
      exnc = raise;
      effc =
        (fun (type b) (eff : b Effect.t) ->
          match eff with
          | EmitTrajectory ev ->
              Some
                (fun (k : (b, _) continuation) ->
                  on_event ev;
                  continue k ())
          | _ -> None);
    }

let json_string s =
  let buf = Buffer.create (String.length s + 8) in
  Buffer.add_char buf '"';
  String.iter
    (function
      | '"' -> Buffer.add_string buf "\\\""
      | '\\' -> Buffer.add_string buf "\\\\"
      | '\n' -> Buffer.add_string buf "\\n"
      | '\r' -> Buffer.add_string buf "\\r"
      | '\t' -> Buffer.add_string buf "\\t"
      | c when Char.code c < 32 ->
          Buffer.add_string buf (Printf.sprintf "\\u%04x" (Char.code c))
      | c -> Buffer.add_char buf c)
    s;
  Buffer.add_char buf '"';
  Buffer.contents buf

let role_json = function
  | System -> "system"
  | User -> "user"
  | Assistant -> "assistant"
  | ToolResult id -> "tool:" ^ id

let message_json m =
  Printf.sprintf {|{"role":%s,"content":%s}|} (json_string (role_json m.role)) (json_string m.content)

let tool_call_json c =
  Printf.sprintf {|{"id":%s,"name":%s,"args":%s}|} (json_string c.id) (json_string c.name)
    (json_string c.args_json)

let response_json = function
  | TextResponse text -> Printf.sprintf {|{"kind":"text","text":%s}|} (json_string text)
  | ToolCallResponse calls ->
      Printf.sprintf {|{"kind":"tools","calls":[%s]}|}
        (String.concat "," (List.map tool_call_json calls))

let result_json = function
  | Ok text -> Printf.sprintf {|{"ok":true,"text":%s}|} (json_string text)
  | Error text -> Printf.sprintf {|{"ok":false,"text":%s}|} (json_string text)

let event_json = function
  | LLMStart messages ->
      Printf.sprintf {|{"event":"llm_start","messages":[%s]}|}
        (String.concat "," (List.map message_json messages))
  | LLMEnd response ->
      Printf.sprintf {|{"event":"llm_end","response":%s}|} (response_json response)
  | ToolStart (name, args) ->
      Printf.sprintf {|{"event":"tool_start","name":%s,"args":%s}|} (json_string name) (json_string args)
  | ToolEnd (name, result) ->
      Printf.sprintf {|{"event":"tool_end","name":%s,"result":%s}|} (json_string name) (result_json result)
  | ApprovalRequested action ->
      Printf.sprintf {|{"event":"approval","action":%s}|} (json_string action)
  | ActorSpawn name -> Printf.sprintf {|{"event":"actor_spawn","name":%s}|} (json_string name)
  | ActorCrash (name, error) ->
      Printf.sprintf {|{"event":"actor_crash","name":%s,"error":%s}|} (json_string name) (json_string error)
  | ActorRestart name -> Printf.sprintf {|{"event":"actor_restart","name":%s}|} (json_string name)

let events_json events = String.concat "\n" (List.map event_json events) ^ "\n"

let describe = function
  | LLMStart _ -> "llm_start"
  | LLMEnd _ -> "llm_end"
  | ToolStart (name, _) -> "tool_start " ^ name
  | ToolEnd (name, Ok _) -> "tool_end " ^ name ^ " ok"
  | ToolEnd (name, Error _) -> "tool_end " ^ name ^ " error"
  | ApprovalRequested _ -> "approval"
  | ActorSpawn name -> "actor_spawn " ^ name
  | ActorCrash (name, _) -> "actor_crash " ^ name
  | ActorRestart name -> "actor_restart " ^ name
