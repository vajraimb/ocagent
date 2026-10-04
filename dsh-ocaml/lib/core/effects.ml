open Types

type _ Effect.t +=
  | AskLLM : { messages : message list; model : string } -> llm_response Effect.t
  | CallTool : { name : string; args_json : string } -> (string, string) result Effect.t
  | SandboxExec : { cmd : string; timeout_sec : float } -> (string, string) result Effect.t
  | EmitTrajectory : trajectory_event -> unit Effect.t
  | AskApproval : { action : string; risk_level : string } -> bool Effect.t
  | Fetch : { meth : http_method; url : string; body : string } -> (http_reply, string) result Effect.t
  | Web_search : { query : string; limit : int } -> (search_answer, string) result Effect.t
  | Self : actor_id Effect.t
  | Send : { to_ : actor_id; body : string } -> unit Effect.t
  | Receive : actor_msg Effect.t
  | Spawn : { name : string; max_restarts : int; body : unit -> unit } -> actor_id Effect.t
  | Supervise :
      { strategy : restart_strategy; max_restarts : int; children : child_spec list } -> unit Effect.t
