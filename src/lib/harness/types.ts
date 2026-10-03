export type Risk = "Low" | "High";

export type Json =
  | null
  | boolean
  | number
  | string
  | Json[]
  | { [key: string]: Json };

export type Msg = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
};

export type LlmRequest = {
  purpose: "plan" | "patch" | "retry" | "compact";
  messages: Msg[];
};

export type LlmResponse = {
  text: string;
  tool?: { name: string; args: Json };
};

export type ToolCall = {
  callId: string;
  name: string;
  args: Json;
};

export type ToolResult = {
  ok: boolean;
  output: string;
  diagnostics: string[];
};

export type Approval = {
  action: string;
  risk: Risk;
  payload: Json;
};

export type Decision = { tag: "Approved" } | { tag: "Rejected"; reason: string };

export type Eff =
  | { tag: "Llm"; request: LlmRequest }
  | { tag: "Tool"; call: ToolCall }
  | { tag: "AskHuman"; approval: Approval }
  | { tag: "Checkpoint"; label: string }
  | { tag: "Compact"; msgs: Msg[] }
  | { tag: "Now" }
  | { tag: "FreshId" };

export type HarnessError =
  | { tag: "Unhandled"; effect: string }
  | { tag: "HarnessError"; message: string }
  | { tag: "BudgetExceeded"; used: number; max: number }
  | { tag: "Nondeterminism"; seq: number; expected: string; actual: string; label: string }
  | { tag: "VersionMismatch"; expected: string; actual: string }
  | { tag: "Crash"; seq: number; window: CrashWindow }
  | { tag: "ContinuationAlreadyResumed" };

export type CrashWindow = "after-pending" | "before-done" | "after-done";

export type JournalStatus = "Done" | "Pending";

export type JournalEntry = {
  runId: string;
  seq: number;
  kind: Eff["tag"];
  label: string;
  reqHash: string;
  req: Json;
  status: JournalStatus;
  result: Json;
  idempotencyKey: string;
  ts: number;
  path: string[];
  lastHit: "execute" | "replay" | "suspend";
};

export type Journal = {
  runId: string;
  agentVersion: string;
  entries: JournalEntry[];
};

export type SideLog = {
  key: string;
  name: string;
  duplicate: boolean;
};

export type World = {
  files: Record<string, string>;
  cache: Map<string, Json>;
  log: SideLog[];
  sandboxExecs: number;
  nextId: number;
  clock: number;
};

export type TraceEvent = {
  id: number;
  handler: string;
  effect: string;
  phase: "see" | "replay" | "execute" | "suspend" | "return" | "reject";
  detail: string;
};

export type AgentResult = {
  ok: boolean;
  attempts: number;
  stamp: string;
  now: number;
  published: "skipped" | "yes" | "rejected";
  diagnostics: string[];
};

export type Probe = { released: boolean };

export type ProfileName = "dev" | "eval" | "prod";

export type LlmMode = "correct-first" | "wrong-then-right" | "always-wrong";

export type RunStatus = "done" | "suspended" | "error" | "crashed";

export type ContinuationState = "held" | "discontinued" | "none";

export type RunResult = {
  status: RunStatus;
  value?: AgentResult;
  error?: HarnessError;
  journal: Journal;
  world: World;
  trace: TraceEvent[];
  protectReleased: boolean;
  continuation: ContinuationState;
  profile: ProfileName;
  llmUsed: number;
  suspendSeq?: number;
  approval?: Approval;
  stack: string[];
};

export type Ctx = {
  journal: Journal;
  world: World;
  trace: TraceEvent[];
  llmMode: LlmMode;
  budgetMax: number;
  llmUsed: number;
  compactThreshold: number;
  sandbox: boolean;
  verifyCounts: Map<string, number>;
  seen: string[];
  currentKey: string;
  replayStamp: number;
  cursor: number;
  crash?: { atSeq: number; window: CrashWindow };
};

export type HandlerReturn =
  | { tag: "value"; value: unknown }
  | { tag: "raise"; error: HarnessError }
  | {
      tag: "suspend";
      approval: Approval;
      seq: number;
      continueK: (decision: Decision) => HandlerReturn;
    };

export type Frame = {
  name: string;
  handle: (eff: Eff, next: (eff: Eff) => HandlerReturn, ctx: Ctx) => HandlerReturn;
};
