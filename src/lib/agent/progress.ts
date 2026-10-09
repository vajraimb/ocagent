// Live progress for one desk run. The OCaml loop only reports at the very end,
// but every model call, step execution and network request passes through the
// Node bridge, so the bridge emits events here and the page polls them.

export type AgentEventBody =
  | { kind: "start"; task: string }
  | { kind: "think"; round: number }
  | { kind: "plan"; round: number; code: string }
  | { kind: "model_error"; round: number; message: string; budget?: boolean }
  | { kind: "run"; round: number }
  | { kind: "call"; round: number; tool: string; detail: string }
  | { kind: "compile_failed"; round: number; message: string }
  | { kind: "runner_failed"; round: number; message: string }
  | { kind: "effect"; round: number; tool: string; detail: string; output: string }
  | { kind: "step"; round: number; reply: string; text: string }
  | { kind: "module"; round: number; name: string; exports: string[] }
  | { kind: "module_dropped"; name: string; reason: string }
  | { kind: "todo"; round: number; items: PlanItem[] }
  | { kind: "check"; round: number; answer: string; failed: string[]; gaveUp?: boolean }
  | { kind: "limit"; round: number; what: string }
  | { kind: "need_input"; round: number; topics: string[]; question: string }
  | { kind: "remember"; round: number; text: string; forgot: boolean }
  | { kind: "schedule"; round: number; time: string; tz: string; task: string }
  | { kind: "unschedule"; round: number; n: number; time: string; tz: string; task: string }
  | { kind: "finish"; ok: boolean };

export type AgentEvent = AgentEventBody & { seq: number; at: number };

/** One item of the plan the model keeps with Plan.set / Plan.tick. */
export type PlanItem = { text: string; done: boolean; note: string };

/**
 * The plan across a whole run, plus the pre-finish check: how many times the
 * loop has held a Done for a check, whether anything was written (what makes
 * a check worth a round), and the answer being held while the check runs.
 */
export type PlanState = {
  items: PlanItem[];
  checks: number;
  wrote: boolean;
  pending: string | null;
  /** Assertions that failed in the held Done, shown in the check prompt. */
  failed: string[];
  /** Files the task has written so far, for the check prompt. */
  written: string[];
  /** Task-start content of the files the task changed (null: did not exist), for Files.restore. */
  origin: Record<string, string | null>;
};

export function emptyPlan(): PlanState {
  return { items: [], checks: 0, wrote: false, pending: null, failed: [], written: [], origin: {} };
}

/** Keeps the origin snapshot within what a run row can carry; the biggest files drop out first. */
export const MAX_ORIGIN_BYTES = 256 * 1024;
export const MAX_WRITTEN_LISTED = 20;

export function boundOrigin(origin: Record<string, string | null>): Record<string, string | null> {
  const entries = Object.entries(origin);
  let total = entries.reduce((sum, [, content]) => sum + (content ? Buffer.byteLength(content) : 0), 0);
  const kept = new Map(entries);
  for (const [path, content] of [...entries].sort((a, b) => (b[1]?.length ?? 0) - (a[1]?.length ?? 0))) {
    if (total <= MAX_ORIGIN_BYTES) break;
    kept.delete(path);
    total -= content ? Buffer.byteLength(content) : 0;
  }
  return Object.fromEntries(kept);
}

// A Check.* effect's verdict: true when it passed, false when it failed.
export function isCheckEffect(tool: string): boolean {
  return tool.startsWith("Check.");
}

export function checkVerdicts(effects: { tool: string; detail: string; output: string }[]): { desc: string; ok: boolean }[] {
  return effects.filter((effect) => isCheckEffect(effect.tool)).map((effect) => ({ desc: effect.detail || effect.tool, ok: effect.output.startsWith("通过") }));
}

const PLAN_SEP = "\u001f";
const MAX_PLAN_ITEMS = 12;

/** Applies one step's Plan.* effects to the plan; true when it changed. */
export function applyPlanEffects(plan: PlanState, effects: { tool: string; detail: string; output: string }[]): boolean {
  let changed = false;
  for (const effect of effects) {
    if (effect.tool === "Plan.set") {
      const items = effect.output
        .split(PLAN_SEP)
        .map((text) => text.trim())
        .filter(Boolean)
        .slice(0, MAX_PLAN_ITEMS);
      if (items.length === 0) continue;
      // Re-planning keeps the ticks of items that kept their text.
      plan.items = items.map((text) => {
        const before = plan.items.find((item) => item.text === text);
        return { text: clip(text, 200), done: before?.done ?? false, note: before?.note ?? "" };
      });
      changed = true;
    } else if (effect.tool === "Plan.tick") {
      const index = Number(effect.detail.trim()) - 1;
      const item = plan.items[index];
      if (!item) continue;
      item.done = true;
      item.note = clip(effect.output.trim(), 300);
      changed = true;
    }
  }
  return changed;
}

export function isPlanEffect(tool: string): boolean {
  return tool === "Plan.set" || tool === "Plan.tick";
}

// Notes the agent keeps about a desk across tasks (Memory.remember / forget):
// few and short, so they fit in every prompt.
export const MAX_NOTES = 24;
export const MAX_NOTE_CHARS = 200;

export function normalizeNotes(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const notes: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const text = item.replace(/\s+/g, " ").trim();
    if (!text || notes.includes(text)) continue;
    notes.push(clip(text, MAX_NOTE_CHARS));
    if (notes.length >= MAX_NOTES) break;
  }
  return notes;
}

export type NoteChange = { text: string; forgot: boolean };

/** Applies one step's Memory.* effects to the notes; returns what changed, in order. */
export function applyMemoryEffects(notes: string[], effects: { tool: string; detail: string; output: string }[]): NoteChange[] {
  const changes: NoteChange[] = [];
  for (const effect of effects) {
    if (effect.tool === "Memory.remember") {
      const text = clip(effect.output.replace(/\s+/g, " ").trim(), MAX_NOTE_CHARS);
      if (!text || notes.includes(text)) continue;
      // The newest note wins when the list is full.
      if (notes.length >= MAX_NOTES) notes.shift();
      notes.push(text);
      changes.push({ text, forgot: false });
    } else if (effect.tool === "Memory.forget") {
      const index = Number(effect.detail.trim()) - 1;
      const [gone] = Number.isInteger(index) && index >= 0 ? notes.splice(index, 1) : [];
      if (gone) changes.push({ text: gone, forgot: true });
    }
  }
  return changes;
}

export function isMemoryEffect(tool: string): boolean {
  return tool === "Memory.remember" || tool === "Memory.forget";
}

/** The plan as the timeline last saw it, or null when the run never set one. */
export function latestPlan(events: AgentEvent[]): PlanItem[] | null {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event?.kind === "todo") return event.items;
  }
  return null;
}

export type JobSnapshot<Result> = {
  found: boolean;
  done: boolean;
  events: AgentEvent[];
  result: Result | null;
};

type Job<Result> = {
  events: AgentEvent[];
  result: Result | null;
  done: boolean;
  startedAt: number;
  endedAt: number | null;
  abort: (() => void) | null;
  seqBase: number;
};

const KEEP_MS = 30 * 60_000;
const MAX_EVENTS = 400;
const OUTPUT_CLIP = 700;
const CODE_CLIP = 6000;

export const JOB_ID = /^[a-z0-9-]{8,48}$/;

export function isJobId(value: unknown): value is string {
  return typeof value === "string" && JOB_ID.test(value);
}

export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.7);
  return `${text.slice(0, head)} … ${text.slice(text.length - (max - head))}`;
}

export class ProgressRegistry<Result> {
  private jobs = new Map<string, Job<Result>>();
  private now: () => number;

  constructor(now: () => number = () => Date.now()) {
    this.now = now;
  }

  // A later segment of the same run opens with the seq its earlier events
  // reached, so the page's "after" cursor keeps working across segments.
  open(id: string, seqBase = 0): void {
    this.prune();
    this.jobs.set(id, { events: [], result: null, done: false, startedAt: this.now(), endedAt: null, abort: null, seqBase });
  }

  emit(id: string, body: AgentEventBody): AgentEvent | null {
    const job = this.jobs.get(id);
    if (!job || job.done) return null;
    const trimmed = trimBody(body);
    const seq = job.events.length ? (job.events[job.events.length - 1]?.seq ?? 0) + 1 : job.seqBase + 1;
    const event: AgentEvent = { ...trimmed, seq, at: this.now() };
    job.events.push(event);
    if (job.events.length > MAX_EVENTS) job.events.splice(0, job.events.length - MAX_EVENTS);
    return event;
  }

  attachAbort(id: string, abort: () => void): void {
    const job = this.jobs.get(id);
    if (job) job.abort = abort;
  }

  cancel(id: string): boolean {
    const job = this.jobs.get(id);
    if (!job || job.done || !job.abort) return false;
    job.abort();
    return true;
  }

  close(id: string, result: Result, ok: boolean): void {
    const job = this.jobs.get(id);
    if (!job || job.done) return;
    this.emit(id, { kind: "finish", ok });
    job.result = result;
    job.done = true;
    job.endedAt = this.now();
    job.abort = null;
  }

  read(id: string, after = 0): JobSnapshot<Result> {
    const job = this.jobs.get(id);
    if (!job) return { found: false, done: false, events: [], result: null };
    return {
      found: true,
      done: job.done,
      events: job.events.filter((event) => event.seq > after),
      result: job.done ? job.result : null,
    };
  }

  private prune(): void {
    const cutoff = this.now() - KEEP_MS;
    for (const [id, job] of this.jobs) {
      const stamp = job.endedAt ?? job.startedAt;
      if (stamp < cutoff) this.jobs.delete(id);
    }
  }
}

function trimBody(body: AgentEventBody): AgentEventBody {
  switch (body.kind) {
    case "plan":
      return { ...body, code: clip(body.code, CODE_CLIP) };
    case "effect":
      return { ...body, detail: clip(body.detail, 200), output: clip(body.output, OUTPUT_CLIP) };
    case "call":
      return { ...body, detail: clip(body.detail, 200) };
    case "step":
      return { ...body, text: clip(body.text, 2000) };
    case "model_error":
    case "compile_failed":
      return { ...body, message: clip(body.message, 1200) };
    default:
      return body;
  }
}

// Reads the "ok\n<kind>\n<text><traces><effects>…" frame a step run returns.
export type StepFrame =
  | { kind: "fail"; message: string }
  | { kind: "ok"; reply: string; text: string; effects: { tool: string; detail: string; output: string }[]; files: { path: string; bytes: number; content: string }[] | null };

// Text files up to this size ride along in the frame description, so the
// run can look at what a step wrote; bigger ones (and pictures) are listed by size only.
const FRAME_CONTENT_BYTES = 64 * 1024;

export function describeStepFrame(raw: string): StepFrame | null {
  const buf = Buffer.from(raw, "utf8");
  let i = 0;
  const line = (): string | null => {
    const j = buf.indexOf(0x0a, i);
    if (j < 0) return null;
    const s = buf.toString("utf8", i, j);
    i = j + 1;
    return s;
  };
  const block = (): string | null => {
    const n = Number(line());
    if (!Number.isFinite(n) || n < 0 || i + n > buf.length) return null;
    const s = buf.toString("utf8", i, i + n);
    i += n;
    if (buf[i] === 0x0a) i += 1;
    return s;
  };
  const head = line();
  if (head === "fail") return { kind: "fail", message: block() ?? raw.slice(5) };
  if (head !== "ok") return null;
  const reply = line();
  const text = block();
  const traces = block();
  const effects = block();
  if (reply === null || text === null || traces === null || effects === null) return null;
  // The workspace as the step left it: paths and sizes, for the next prompt.
  let files: { path: string; bytes: number; content: string }[] | null = null;
  const countLine = line();
  const count = countLine === null ? NaN : Number(countLine);
  if (Number.isInteger(count) && count >= 0) {
    files = [];
    for (let k = 0; k < count; k += 1) {
      const path = line();
      const content = block();
      if (path === null || content === null) {
        files = null;
        break;
      }
      const bytes = Buffer.byteLength(content);
      files.push({ path, bytes, content: bytes <= FRAME_CONTENT_BYTES && !content.startsWith("data:") ? content : "" });
    }
  }
  return { kind: "ok", reply, text, effects: parseEffects(effects), files };
}

export function parseEffects(effectText: string): { tool: string; detail: string; output: string }[] {
  return effectText
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const [tool = "", detail = "", ...rest] = line.split("\t");
      return { tool, detail, output: rest.join("\t") };
    })
    .filter((item) => item.tool && !(item.tool === "Trace.note" && item.output.startsWith("【结果】")));
}

// Reads the "text\n<len>\n…" / "error\n<len>\n…" envelope the model bridge returns.
export function describeModelReply(raw: string): { kind: "text"; text: string } | { kind: "error"; message: string } | null {
  const buf = Buffer.from(raw, "utf8");
  const first = buf.indexOf(0x0a);
  if (first < 0) return null;
  const head = buf.toString("utf8", 0, first);
  const second = buf.indexOf(0x0a, first + 1);
  if (second < 0) return null;
  const n = Number(buf.toString("utf8", first + 1, second));
  if (!Number.isFinite(n) || n < 0) return null;
  const body = buf.toString("utf8", second + 1, Math.min(buf.length, second + 1 + n));
  if (head === "text") return { kind: "text", text: body };
  if (head === "error") return { kind: "error", message: body };
  return null;
}

export function extractCode(text: string): string {
  const fenced = /```(?:ocaml)?\s*\n([\s\S]*?)```/.exec(text);
  if (fenced?.[1]?.trim()) return fenced[1].trim();
  if (text.includes("module Step") || text.includes("let run")) return text.trim();
  return "";
}

// Groups a flat event list into rounds for the timeline.
export type Round = {
  round: number;
  thinking: boolean;
  code: string;
  modelError: string;
  /** The model error above is the segment's budget running out mid-call, not the model failing. */
  budgetCut: boolean;
  /** When the round's first and last events happened (ms); the page shows the span. */
  startedAt: number;
  endedAt: number;
  running: boolean;
  compileError: string;
  runnerError: string;
  calls: { tool: string; detail: string }[];
  effects: { tool: string; detail: string; output: string }[];
  modules: { name: string; exports: string[] }[];
  reply: { kind: string; text: string } | null;
  /** The answer the model wanted to end with, when the loop held it for a check. */
  check: string;
  /** Assertions that failed when the Done was held. */
  checkFailed: string[];
  /** The held reply was a Partial: the model gave up on a failed check it never looked into. */
  checkGaveUp: boolean;
  /** The run turned this round's Done into a question: what it needs from the user. */
  needInput: { topics: string[]; question: string } | null;
  /** The run turned this round's Done into a Partial: the task asked for something it cannot do. */
  limit: string;
  /** Notes remembered or forgotten in this round. */
  remembered: NoteChange[];
  /** Daily schedules registered (Schedule.daily) or cancelled (n) in this round. */
  scheduled: { kind: "daily" | "cancel"; time: string; tz: string; task: string }[];
};

export function foldRounds(events: AgentEvent[]): Round[] {
  const rounds = new Map<number, Round>();
  const at = (round: number): Round => {
    let found = rounds.get(round);
    if (!found) {
      found = { round, thinking: false, code: "", modelError: "", budgetCut: false, startedAt: 0, endedAt: 0, running: false, compileError: "", runnerError: "", calls: [], effects: [], modules: [], reply: null, check: "", checkFailed: [], checkGaveUp: false, needInput: null, limit: "", remembered: [], scheduled: [] };
      rounds.set(round, found);
    }
    return found;
  };
  for (const event of events) {
    if ("round" in event) {
      const round = at(event.round);
      if (!round.startedAt) round.startedAt = event.at;
      round.endedAt = event.at;
    }
    switch (event.kind) {
      case "think":
        at(event.round).thinking = true;
        break;
      case "plan": {
        const round = at(event.round);
        round.thinking = false;
        round.code = event.code;
        break;
      }
      case "model_error": {
        const round = at(event.round);
        round.thinking = false;
        round.modelError = event.message;
        round.budgetCut = event.budget === true;
        break;
      }
      case "run":
        at(event.round).running = true;
        break;
      case "call":
        at(event.round).calls.push({ tool: event.tool, detail: event.detail });
        break;
      case "compile_failed": {
        const round = at(event.round);
        round.running = false;
        round.compileError = event.message;
        break;
      }
      case "runner_failed": {
        const round = at(event.round);
        round.running = false;
        round.runnerError = event.message;
        break;
      }
      case "effect":
        at(event.round).effects.push({ tool: event.tool, detail: event.detail, output: event.output });
        break;
      case "module":
        at(event.round).modules.push({ name: event.name, exports: event.exports });
        break;
      case "step": {
        const round = at(event.round);
        round.running = false;
        round.calls = [];
        round.reply = { kind: event.reply, text: event.text };
        break;
      }
      case "check": {
        const round = at(event.round);
        round.check = event.answer;
        round.checkFailed = event.failed;
        round.checkGaveUp = event.gaveUp === true;
        break;
      }
      case "need_input":
        at(event.round).needInput = { topics: event.topics, question: event.question };
        break;
      case "limit":
        at(event.round).limit = event.what;
        break;
      case "schedule":
        at(event.round).scheduled.push({ kind: "daily", time: event.time, tz: event.tz, task: event.task });
        break;
      case "unschedule":
        at(event.round).scheduled.push({ kind: "cancel", time: event.time, tz: event.tz, task: event.task });
        break;
      case "remember":
        at(event.round).remembered.push({ text: event.text, forgot: event.forgot });
        break;
      default:
        break;
    }
  }
  return [...rounds.values()].sort((left, right) => left.round - right.round);
}
