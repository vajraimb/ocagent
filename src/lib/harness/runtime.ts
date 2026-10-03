import { effectLabel } from "./hash.ts";
import {
  budgetFrame,
  compactFrame,
  journalFrame,
  policyFrame,
  strictFrame,
  traceFrame,
  verifyFrame,
  worldFrame,
  writeDecision,
} from "./handlers.ts";
import type {
  AgentResult,
  ContinuationState,
  CrashWindow,
  Ctx,
  Decision,
  Eff,
  Frame,
  HandlerReturn,
  HarnessError,
  Journal,
  LlmMode,
  Probe,
  ProfileName,
  RunResult,
  RunStatus,
} from "./types.ts";
import { createWorld } from "./world.ts";
import type { World } from "./types.ts";

export const AGENT_VERSION = "swe-agent@0.1";

export type AgentFn = (prompt: string, probe: Probe) => Generator<Eff, AgentResult, unknown>;

export type RunOptions = {
  profile?: ProfileName;
  prompt: string;
  llmMode?: LlmMode;
  budgetMax?: number;
  compactThreshold?: number;
  journal?: Journal;
  world?: World;
  crash?: { atSeq: number; window: CrashWindow };
  runId?: string;
  agentVersion?: string;
  agent: AgentFn;
  decisions?: Record<number, Decision>;
  verify?: boolean;
  policy?: boolean;
  compact?: boolean;
  sandbox?: boolean;
};

export type Session = {
  result: RunResult;
  exitProcess: () => Session;
  resumeFast: (decision: Decision) => Session;
};

type Flags = {
  verify: boolean;
  policy: boolean;
  compact: boolean;
  sandbox: boolean;
  budgetMax: number;
  compactThreshold: number;
  traceName: string;
};

export function profileFlags(profile: ProfileName): Flags {
  if (profile === "eval") {
    return {
      verify: true,
      policy: false,
      compact: false,
      sandbox: false,
      budgetMax: 10,
      compactThreshold: 99,
      traceName: "eval_logger",
    };
  }
  if (profile === "prod") {
    return {
      verify: true,
      policy: true,
      compact: true,
      sandbox: true,
      budgetMax: 20,
      compactThreshold: 4,
      traceName: "otel",
    };
  }
  return {
    verify: true,
    policy: true,
    compact: true,
    sandbox: false,
    budgetMax: 30,
    compactThreshold: 8,
    traceName: "trace",
  };
}

export function buildFrames(flags: Flags): Frame[] {
  const frames: Frame[] = [traceFrame(flags.traceName)];
  if (flags.verify) frames.push(verifyFrame());
  frames.push(budgetFrame());
  if (flags.policy) frames.push(policyFrame());
  if (flags.compact) frames.push(compactFrame());
  frames.push(journalFrame(), worldFrame(), strictFrame());
  return frames;
}

export function stackNames(profile: ProfileName, extra?: Partial<Flags>): string[] {
  const flags = { ...profileFlags(profile), ...extra };
  return buildFrames(flags).map((frame) => frame.name);
}

export function describeError(error: HarnessError): string {
  switch (error.tag) {
    case "BudgetExceeded":
      return `预算用尽 ${error.used}/${error.max}`;
    case "Nondeterminism":
      return `seq ${error.seq} 请求变了（${error.label}），拒绝静默错位`;
    case "VersionMismatch":
      return `日志属于 ${error.expected}，当前是 ${error.actual}`;
    case "Crash":
      return `kill -9 于 seq ${error.seq} · ${error.window}`;
    case "HarnessError":
      return error.message;
    case "Unhandled":
      return `没有 handler 接住 ${error.effect}`;
    case "ContinuationAlreadyResumed":
      return "这条 continuation 只能恢复一次";
  }
}

export function startSession(opts: RunOptions): Session {
  const profile = opts.profile ?? "dev";
  const flags = profileFlags(profile);
  if (opts.verify !== undefined) flags.verify = opts.verify;
  if (opts.policy !== undefined) flags.policy = opts.policy;
  if (opts.compact !== undefined) flags.compact = opts.compact;
  if (opts.sandbox !== undefined) flags.sandbox = opts.sandbox;
  if (opts.budgetMax !== undefined) flags.budgetMax = opts.budgetMax;
  if (opts.compactThreshold !== undefined) flags.compactThreshold = opts.compactThreshold;

  const version = opts.agentVersion ?? AGENT_VERSION;
  const world = opts.world ?? createWorld();
  const journal: Journal = opts.journal ?? {
    runId: opts.runId ?? `${profile}:local`,
    agentVersion: version,
    entries: [],
  };

  const frames = buildFrames(flags);
  const ctx: Ctx = {
    journal,
    world,
    trace: [],
    llmMode: opts.llmMode ?? "correct-first",
    budgetMax: flags.budgetMax,
    llmUsed: 0,
    compactThreshold: flags.compactThreshold,
    sandbox: flags.sandbox,
    verifyCounts: new Map(),
    seen: [],
    currentKey: "",
    replayStamp: 0,
    cursor: 0,
    crash: opts.crash,
  };

  const base = (): Omit<RunResult, "status" | "protectReleased" | "continuation" | "value" | "error"> => ({
    journal,
    world,
    trace: ctx.trace,
    profile,
    llmUsed: ctx.llmUsed,
    stack: frames.map((frame) => frame.name),
  });

  const stalled = (status: RunStatus, extra: Partial<RunResult>): Session => ({
    result: {
      ...base(),
      status,
      protectReleased: false,
      continuation: "none",
      llmUsed: ctx.llmUsed,
      ...extra,
    },
    exitProcess() {
      return stalled(status, extra);
    },
    resumeFast() {
      return stalled("error", {
        error: { tag: "HarnessError", message: "没有可恢复的 continuation" },
      });
    },
  });

  if (journal.entries.length > 0 && journal.agentVersion !== version) {
    return stalled("error", {
      error: { tag: "VersionMismatch", expected: journal.agentVersion, actual: version },
    });
  }

  if (opts.decisions) {
    for (const [seq, decision] of Object.entries(opts.decisions)) {
      const entry = journal.entries[Number(seq)];
      if (entry && entry.status === "Pending") writeDecision(entry, decision);
    }
  }

  const probe: Probe = { released: false };
  const gen = opts.agent(opts.prompt, probe);

  const pack = (
    status: RunStatus,
    continuation: ContinuationState,
    extra: Partial<RunResult> = {},
  ): RunResult => ({
    ...base(),
    status,
    protectReleased: probe.released,
    continuation,
    llmUsed: ctx.llmUsed,
    ...extra,
  });

  let alive = true;
  let consumed = false;
  let steps = 0;

  const closeGen = () => {
    try {
      gen.return(emptyResult());
    } catch {
      /* already closed */
    }
  };

  const fail = (error: HarnessError): Session => {
    const crashed = error.tag === "Crash";
    // kill -9 不会跑 Fun.protect；其它错误按 discontinue 释放。
    if (!crashed) closeGen();
    alive = false;
    const result = pack(crashed ? "crashed" : "error", "none", { error });
    return {
      result,
      exitProcess: () => ({ result, exitProcess: () => fail(error), resumeFast: () => fail(error) }),
      resumeFast: () => fail(error),
    };
  };

  const succeed = (value: AgentResult): Session => {
    alive = false;
    const result = pack("done", "none", { value });
    return {
      result,
      exitProcess: () => succeed(value),
      resumeFast: () =>
        stalled("error", { error: { tag: "HarnessError", message: "运行已经结束" } }),
    };
  };

  function loop(step: IteratorResult<Eff, AgentResult>): Session {
    if (step.done) return succeed(step.value);
    steps += 1;
    if (steps > 80) {
      return fail({ tag: "HarnessError", message: "effect 步数超过 80，已中止" });
    }
    const handled = dispatch(frames, 0, step.value, [], ctx);
    if (handled.tag === "raise") return fail(handled.error);
    if (handled.tag === "suspend") return pause(handled, step.value);
    return loop(gen.next(handled.value));
  }

  function pause(handled: Extract<HandlerReturn, { tag: "suspend" }>, _eff: Eff): Session {
    const suspended = (): RunResult =>
      pack("suspended", alive ? "held" : "discontinued", {
        suspendSeq: handled.seq,
        approval: handled.approval,
      });

    return {
      result: suspended(),
      exitProcess() {
        if (alive) {
          alive = false;
          closeGen();
        }
        return {
          result: suspended(),
          exitProcess() {
            return pause(handled, _eff).exitProcess();
          },
          resumeFast() {
            return stalled("error", {
              error: { tag: "HarnessError", message: "进程已退出，continuation 已 discontinue" },
            });
          },
        };
      },
      resumeFast(decision) {
        if (consumed) {
          return stalled("error", { error: { tag: "ContinuationAlreadyResumed" } });
        }
        if (!alive) {
          return stalled("error", {
            error: { tag: "HarnessError", message: "进程已退出，continuation 已 discontinue" },
          });
        }
        consumed = true;
        const continued = handled.continueK(decision);
        if (continued.tag === "raise") return fail(continued.error);
        if (continued.tag === "suspend") return pause(continued, _eff);
        return loop(gen.next(continued.value));
      },
    };
  }

  return loop(gen.next(undefined));
}

function dispatch(frames: Frame[], index: number, eff: Eff, seen: string[], ctx: Ctx): HandlerReturn {
  if (index >= frames.length) {
    return { tag: "raise", error: { tag: "Unhandled", effect: effectLabel(eff) } };
  }
  const frame = frames[index]!;
  const here = [...seen, frame.name];
  ctx.seen = here;
  const next = (nextEff: Eff) =>
    dispatch(frames, index + 1, nextEff, nextEff === eff ? here : [frame.name], ctx);
  return frame.handle(eff, next, ctx);
}

export function emptyResult(): AgentResult {
  return { ok: false, attempts: 0, stamp: "", now: 0, published: "skipped", diagnostics: [] };
}

export function slimJournal(journal: Journal) {
  return journal.entries.map((entry) => ({
    seq: entry.seq,
    kind: entry.kind,
    label: entry.label,
    reqHash: entry.reqHash,
    status: entry.status,
    result: entry.result,
    idempotencyKey: entry.idempotencyKey,
    ts: entry.ts,
  }));
}
