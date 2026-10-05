(** Catalogue shared by [ocaml/] and [dsh-ocaml/]. It names effects and which
    profile installs a handler. It does not run them. *)

type tree =
  | Ocagent
  | Dsh

type row = {
  tree : tree;
  effect_name : string;
  profile : string;
  handler : string;
}

let tree_name = function
  | Ocagent -> "ocaml"
  | Dsh -> "dsh-ocaml"

let rows =
  [
    { tree = Ocagent; effect_name = "Llm"; profile = "Dev"; handler = "trace, budget, journal, world" };
    { tree = Ocagent; effect_name = "Llm"; profile = "Eval"; handler = "eval_logger, budget, journal, world" };
    { tree = Ocagent; effect_name = "Llm"; profile = "Prod"; handler = "otel, budget, compact, journal, world" };
    { tree = Ocagent; effect_name = "Tool"; profile = "Dev"; handler = "trace, verify, policy, journal, world" };
    { tree = Ocagent; effect_name = "Tool"; profile = "Eval"; handler = "eval_logger, verify, journal, world" };
    { tree = Ocagent; effect_name = "Tool"; profile = "Prod"; handler = "otel, verify, policy, journal, world" };
    { tree = Ocagent; effect_name = "Ask_human"; profile = "Dev"; handler = "trace, policy, journal" };
    { tree = Ocagent; effect_name = "Ask_human"; profile = "Eval"; handler = "eval_logger, journal" };
    { tree = Ocagent; effect_name = "Ask_human"; profile = "Prod"; handler = "otel, policy, journal" };
    { tree = Ocagent; effect_name = "Checkpoint"; profile = "Dev Eval Prod"; handler = "journal, world" };
    { tree = Ocagent; effect_name = "Compact"; profile = "Dev"; handler = "compact, journal" };
    { tree = Ocagent; effect_name = "Compact"; profile = "Eval"; handler = "none" };
    { tree = Ocagent; effect_name = "Compact"; profile = "Prod"; handler = "compact, journal" };
    { tree = Ocagent; effect_name = "Now"; profile = "Dev Eval Prod"; handler = "journal, world" };
    { tree = Ocagent; effect_name = "Fresh_id"; profile = "Dev Eval Prod"; handler = "journal, world" };
    { tree = Ocagent; effect_name = "Fetch"; profile = "Dev"; handler = "journal; world refuses without sandbox" };
    { tree = Ocagent; effect_name = "Fetch"; profile = "Eval"; handler = "journal; world refuses without sandbox" };
    { tree = Ocagent; effect_name = "Fetch"; profile = "Prod"; handler = "otel, journal, world sandbox" };
    { tree = Dsh; effect_name = "AskLLM"; profile = "Evaluation"; handler = "mock llm" };
    { tree = Dsh; effect_name = "AskLLM"; profile = "DryRun"; handler = "mock llm" };
    { tree = Dsh; effect_name = "AskLLM"; profile = "Production"; handler = "https chat, else loopback, else mock" };
    { tree = Dsh; effect_name = "CallTool"; profile = "Evaluation"; handler = "mock fs, risk approval" };
    { tree = Dsh; effect_name = "CallTool"; profile = "DryRun"; handler = "auto-deny on delete_file and deploy" };
    { tree = Dsh; effect_name = "CallTool"; profile = "Production"; handler = "eio fs, risk approval, auto-deny sink" };
    { tree = Dsh; effect_name = "SandboxExec"; profile = "Evaluation"; handler = "mock sandbox" };
    { tree = Dsh; effect_name = "SandboxExec"; profile = "DryRun"; handler = "dry-run sandbox" };
    { tree = Dsh; effect_name = "SandboxExec"; profile = "Production"; handler = "eio sandbox" };
    { tree = Dsh; effect_name = "AskApproval"; profile = "Evaluation"; handler = "scripted sink" };
    { tree = Dsh; effect_name = "AskApproval"; profile = "DryRun"; handler = "auto-deny" };
    { tree = Dsh; effect_name = "AskApproval"; profile = "Production"; handler = "auto-deny" };
    { tree = Dsh; effect_name = "Fetch"; profile = "Evaluation"; handler = "offline net" };
    { tree = Dsh; effect_name = "Fetch"; profile = "DryRun"; handler = "offline net" };
    { tree = Dsh; effect_name = "Fetch"; profile = "Production"; handler = "curl http/https" };
    { tree = Dsh; effect_name = "Web_search"; profile = "Evaluation"; handler = "offline search" };
    { tree = Dsh; effect_name = "Web_search"; profile = "DryRun"; handler = "offline search" };
    { tree = Dsh; effect_name = "Web_search"; profile = "Production"; handler = "xAI when XAI_API_KEY is set, else unconfigured" };
    { tree = Dsh; effect_name = "EmitTrajectory"; profile = "Evaluation DryRun Production"; handler = "trajectory" };
    { tree = Dsh; effect_name = "Spawn"; profile = "actor"; handler = "child reinstalls the stack; a raw fiber does not" };
    { tree = Dsh; effect_name = "Supervise"; profile = "actor"; handler = "same reinstall inside each child" };
    { tree = Dsh; effect_name = "Send"; profile = "actor"; handler = "mailbox" };
    { tree = Dsh; effect_name = "Receive"; profile = "actor"; handler = "mailbox" };
    { tree = Dsh; effect_name = "Self"; profile = "actor"; handler = "actor id" };
  ]

let covered tree effect_name =
  List.filter (fun row -> row.tree = tree && row.effect_name = effect_name) rows
