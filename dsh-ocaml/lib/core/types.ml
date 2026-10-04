type role =
  | System
  | User
  | Assistant
  | ToolResult of string

type message = {
  role : role;
  content : string;
}

type tool_call = {
  id : string;
  name : string;
  args_json : string;
}

type llm_response =
  | TextResponse of string
  | ToolCallResponse of tool_call list

type trajectory_event =
  | LLMStart of message list
  | LLMEnd of llm_response
  | ToolStart of string * string
  | ToolEnd of string * (string, string) result
  | ApprovalRequested of string
