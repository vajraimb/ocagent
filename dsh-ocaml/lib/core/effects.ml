open Types

type _ Effect.t +=
  | AskLLM : { messages : message list; model : string } -> llm_response Effect.t
  | CallTool : { name : string; args_json : string } -> (string, string) result Effect.t
  | SandboxExec : { cmd : string; timeout_sec : float } -> (string, string) result Effect.t
  | EmitTrajectory : trajectory_event -> unit Effect.t
  | AskApproval : { action : string; risk_level : string } -> bool Effect.t
