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

type actor_id = string

type actor_msg = {
  from : actor_id;
  body : string;
}

type restart_strategy =
  | One_for_one
  | One_for_all
  | Rest_for_one

type child_spec = {
  name : string;
  body : unit -> unit;
}

type trajectory_event =
  | LLMStart of message list
  | LLMEnd of llm_response
  | ToolStart of string * string
  | ToolEnd of string * (string, string) result
  | ApprovalRequested of string
  | ActorSpawn of actor_id
  | ActorCrash of actor_id * string
  | ActorRestart of actor_id

type http_method =
  | GET
  | POST

type http_reply = {
  status : int;
  body : string;
}

type search_hit = {
  title : string;
  url : string;
  snippet : string;
}

type search_answer = {
  text : string;
  hits : search_hit list;
}

