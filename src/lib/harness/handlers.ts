import { effectLabel, effectReq, reqHash } from "./hash.ts";
import type {
  CrashWindow,
  Ctx,
  Decision,
  Eff,
  Frame,
  HandlerReturn,
  JournalEntry,
  ToolResult,
} from "./types.ts";
import { interpret } from "./world.ts";

const HIGH_RISK = new Set(["shell", "delete_file", "network"]);
const WRITE_TOOLS = new Set(["apply_patch", "write_file"]);
const VERIFY_CAP = 3;

export function traceFrame(name: string): Frame {
  return {
    name,
    handle(eff, next, ctx) {
      const id = ctx.trace.length;
      ctx.trace.push({
        id,
        handler: name,
        effect: effectLabel(eff),
        phase: "see",
        detail: name === "otel" ? "span open" : "log",
      });
      const stamp = ctx.replayStamp;
      const result = next(eff);
      const replayed = ctx.replayStamp !== stamp;
      ctx.trace.push({
        id: ctx.trace.length,
        handler: name,
        effect: effectLabel(eff),
        phase: "return",
        detail: replayed ? "replayed=true" : "replayed=false",
      });
      return result;
    },
  };
}

export function verifyFrame(): Frame {
  return {
    name: "verify",
    handle(eff, next, ctx) {
      if (eff.tag !== "Tool" || !WRITE_TOOLS.has(eff.call.name)) return next(eff);
      const result = next(eff);
      if (result.tag !== "value") return result;
      return afterWrite(eff, result.value, next, ctx);
    },
  };
}

function afterWrite(
  eff: Extract<Eff, { tag: "Tool" }>,
  raw: unknown,
  next: (eff: Eff) => HandlerReturn,
  ctx: Ctx,
): HandlerReturn {
  const wrote = asTool(raw);
  const seen = ctx.verifyCounts.get(eff.call.callId) ?? 0;
  if (seen >= VERIFY_CAP) {
    return {
      tag: "value",
      value: {
        ok: false,
        output: wrote.output,
        diagnostics: [...wrote.diagnostics, "verify: 同一 call_id 已达 3 次上限"],
      },
    };
  }
  ctx.verifyCounts.set(eff.call.callId, seen + 1);
  const path = typeof eff.call.args === "object" && eff.call.args && !Array.isArray(eff.call.args)
    ? eff.call.args.path
    : "src/math.ml";
  const lint: Eff = {
    tag: "Tool",
    call: {
      callId: `${eff.call.callId}:lint`,
      name: "lint",
      args: { path: typeof path === "string" ? path : "src/math.ml", source: eff.call.callId },
    },
  };
  const checked = next(lint);
  if (checked.tag !== "value") return checked;
  const lintResult = asTool(checked.value);
  ctx.trace.push({
    id: ctx.trace.length,
    handler: "verify",
    effect: effectLabel(eff),
    phase: lintResult.ok ? "return" : "reject",
    detail: lintResult.ok ? "lint clean" : lintResult.diagnostics.join(" "),
  });
  return {
    tag: "value",
    value: {
      ok: lintResult.ok,
      output: wrote.output,
      diagnostics: [...wrote.diagnostics, ...lintResult.diagnostics],
    },
  };
}

export function budgetFrame(): Frame {
  return {
    name: "budget",
    handle(eff, next, ctx) {
      if (eff.tag !== "Llm") return next(eff);
      ctx.llmUsed += 1;
      if (ctx.llmUsed > ctx.budgetMax) {
        ctx.trace.push({
          id: ctx.trace.length,
          handler: "budget",
          effect: effectLabel(eff),
          phase: "reject",
          detail: `${ctx.llmUsed}/${ctx.budgetMax}`,
        });
        return {
          tag: "raise",
          error: { tag: "BudgetExceeded", used: ctx.llmUsed, max: ctx.budgetMax },
        };
      }
      return next(eff);
    },
  };
}

export function policyFrame(): Frame {
  return {
    name: "policy",
    handle(eff, next) {
      if (eff.tag !== "Tool" || !HIGH_RISK.has(eff.call.name)) return next(eff);
      const ask: Eff = {
        tag: "AskHuman",
        approval: {
          action: eff.call.name,
          risk: "High",
          payload: eff.call.args,
        },
      };
      const asked = next(ask);
      if (asked.tag === "suspend") {
        const inner = asked.continueK;
        return {
          ...asked,
          continueK: oneShot((decision) => {
            const continued = inner(decision);
            if (continued.tag !== "value") return continued;
            return applyDecision(continued.value, eff, next);
          }),
        };
      }
      if (asked.tag !== "value") return asked;
      return applyDecision(asked.value, eff, next);
    },
  };
}

function applyDecision(
  value: unknown,
  tool: Extract<Eff, { tag: "Tool" }>,
  next: (eff: Eff) => HandlerReturn,
): HandlerReturn {
  const decision = value as Decision;
  if (!decision || typeof decision !== "object" || !("tag" in decision)) {
    return { tag: "raise", error: { tag: "HarnessError", message: "审批结果无法识别" } };
  }
  if (decision.tag === "Rejected") {
    const result: ToolResult = {
      ok: false,
      output: decision.reason,
      diagnostics: ["policy: 已拒绝，handler 不改写工具参数"],
    };
    return { tag: "value", value: result };
  }
  return next(tool);
}

export function compactFrame(): Frame {
  return {
    name: "compact",
    handle(eff, next, ctx) {
      if (eff.tag === "Compact") return summarize(eff.msgs, next);
      if (eff.tag !== "Llm") return next(eff);
      if (eff.request.purpose === "compact") return next(eff);
      if (eff.request.messages.length <= ctx.compactThreshold) return next(eff);
      const summary = next({
        tag: "Llm",
        request: { purpose: "compact", messages: eff.request.messages },
      });
      if (summary.tag !== "value") return summary;
      const text = (summary.value as { text?: string }).text ?? "";
      const rewritten: Eff = {
        tag: "Llm",
        request: {
          purpose: eff.request.purpose,
          messages: [
            { role: "system", content: "compacted" },
            { role: "user", content: text },
          ],
        },
      };
      return next(rewritten);
    },
  };
}

function summarize(msgs: { role: string; content: string }[], next: (eff: Eff) => HandlerReturn): HandlerReturn {
  const summary = next({
    tag: "Llm",
    request: {
      purpose: "compact",
      messages: msgs.map((msg) => ({
        role: msg.role as "system" | "user" | "assistant" | "tool",
        content: msg.content,
      })),
    },
  });
  if (summary.tag !== "value") return summary;
  const text = (summary.value as { text?: string }).text ?? "";
  return {
    tag: "value",
    value: [
      { role: "system", content: "compacted" },
      { role: "user", content: text },
    ],
  };
}

export function journalFrame(): Frame {
  return {
    name: "journal",
    handle(eff, next, ctx) {
      const seq = ctx.cursor;
      ctx.cursor += 1;
      const existing = ctx.journal.entries[seq];
      const hash = reqHash(eff);
      const label = effectLabel(eff);
      if (!existing) {
        if (seq !== ctx.journal.entries.length) {
          return {
            tag: "raise",
            error: { tag: "HarnessError", message: `日志序号断裂：期望 ${ctx.journal.entries.length}，实际 ${seq}` },
          };
        }
      }
      if (existing) {
        if (existing.reqHash !== hash) {
          return {
            tag: "raise",
            error: {
              tag: "Nondeterminism",
              seq,
              expected: existing.reqHash,
              actual: hash,
              label,
            },
          };
        }
        if (existing.status === "Done") {
          ctx.replayStamp += 1;
          existing.lastHit = "replay";
          ctx.trace.push({
            id: ctx.trace.length,
            handler: "journal",
            effect: label,
            phase: "replay",
            detail: `seq ${seq}`,
          });
          return { tag: "value", value: existing.result };
        }
        return finishPending(existing, eff, next, ctx);
      }

      const entry: JournalEntry = {
        runId: ctx.journal.runId,
        seq,
        kind: eff.tag,
        label,
        reqHash: hash,
        req: effectReq(eff),
        status: "Pending",
        result: null,
        idempotencyKey: `${ctx.journal.runId}:${seq}:${hash}`,
        ts: ctx.world.clock + seq,
        path: [...ctx.seen],
        lastHit: "execute",
      };
      ctx.journal.entries.push(entry);
      if (hitCrash(ctx, seq, "after-pending")) {
        return { tag: "raise", error: { tag: "Crash", seq, window: "after-pending" } };
      }
      if (eff.tag === "AskHuman") {
        entry.lastHit = "suspend";
        ctx.trace.push({
          id: ctx.trace.length,
          handler: "journal",
          effect: label,
          phase: "suspend",
          detail: `seq ${seq} pending`,
        });
        return {
          tag: "suspend",
          approval: eff.approval,
          seq,
          continueK: oneShot((decision) => {
            entry.status = "Done";
            entry.result = decision as unknown as JournalEntry["result"];
            entry.lastHit = "execute";
            return { tag: "value", value: decision };
          }),
        };
      }
      return finishPending(entry, eff, next, ctx);
    },
  };
}

function finishPending(
  entry: JournalEntry,
  eff: Eff,
  next: (eff: Eff) => HandlerReturn,
  ctx: Ctx,
): HandlerReturn {
  if (eff.tag === "AskHuman") {
    entry.lastHit = "suspend";
    return {
      tag: "suspend",
      approval: eff.approval,
      seq: entry.seq,
      continueK: oneShot((decision) => {
        entry.status = "Done";
        entry.result = decision as unknown as JournalEntry["result"];
        entry.lastHit = "execute";
        return { tag: "value", value: decision };
      }),
    };
  }
  ctx.currentKey = entry.idempotencyKey;
  entry.lastHit = "execute";
  const result = next(eff);
  if (hitCrash(ctx, entry.seq, "before-done")) {
    return { tag: "raise", error: { tag: "Crash", seq: entry.seq, window: "before-done" } };
  }
  if (result.tag === "value") {
    entry.status = "Done";
    entry.result = result.value as JournalEntry["result"];
    ctx.trace.push({
      id: ctx.trace.length,
      handler: "journal",
      effect: entry.label,
      phase: "execute",
      detail: `seq ${entry.seq}`,
    });
  }
  if (hitCrash(ctx, entry.seq, "after-done")) {
    return { tag: "raise", error: { tag: "Crash", seq: entry.seq, window: "after-done" } };
  }
  return result;
}

function hitCrash(ctx: Ctx, seq: number, window: CrashWindow): boolean {
  return ctx.crash?.atSeq === seq && ctx.crash.window === window;
}

export function worldFrame(): Frame {
  return {
    name: "world",
    handle(eff, next, ctx) {
      if (
        eff.tag !== "Llm" &&
        eff.tag !== "Tool" &&
        eff.tag !== "Now" &&
        eff.tag !== "FreshId" &&
        eff.tag !== "Checkpoint"
      ) {
        return next(eff);
      }
      const key = ctx.currentKey;
      const cached = ctx.world.cache.get(key);
      const name = eff.tag === "Tool" ? eff.call.name : eff.tag;
      if (cached !== undefined || ctx.world.cache.has(key)) {
        ctx.world.log.push({ key, name, duplicate: true });
        return { tag: "value", value: cached ?? null };
      }
      const value = interpret(eff, ctx.world, ctx.sandbox, ctx.llmMode);
      ctx.world.cache.set(key, value);
      ctx.world.log.push({ key, name, duplicate: false });
      return { tag: "value", value };
    },
  };
}

export function strictFrame(): Frame {
  return {
    name: "strict",
    handle(eff, next) {
      const result = next(eff);
      if (result.tag === "raise" && result.error.tag === "Unhandled") {
        return {
          tag: "raise",
          error: { tag: "HarnessError", message: `未处理的 effect：${result.error.effect}` },
        };
      }
      return result;
    },
  };
}

export function oneShot(fn: (decision: Decision) => HandlerReturn): (decision: Decision) => HandlerReturn {
  let used = false;
  return (decision) => {
    if (used) return { tag: "raise", error: { tag: "ContinuationAlreadyResumed" } };
    used = true;
    return fn(decision);
  };
}

function asTool(value: unknown): ToolResult {
  const tool = value as Partial<ToolResult> | null;
  return {
    ok: Boolean(tool && tool.ok),
    output: tool && typeof tool.output === "string" ? tool.output : "",
    diagnostics: tool && Array.isArray(tool.diagnostics) ? tool.diagnostics.filter((item) => typeof item === "string") : [],
  };
}

export function writeDecision(entry: JournalEntry, decision: Decision) {
  entry.status = "Done";
  entry.result = decision as unknown as JournalEntry["result"];
  entry.lastHit = "replay";
}

