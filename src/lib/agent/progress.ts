// Live progress for one desk run. The OCaml loop only reports at the very end,
// but every model call, step execution and network request passes through the
// Node bridge, so the bridge emits events here and the page polls them.

export type AgentEventBody =
  | { kind: "start"; task: string }
  | { kind: "think"; round: number }
  | { kind: "plan"; round: number; code: string }
  | { kind: "model_error"; round: number; message: string }
  | { kind: "run"; round: number }
  | { kind: "call"; round: number; tool: string; detail: string }
  | { kind: "compile_failed"; round: number; message: string }
  | { kind: "effect"; round: number; tool: string; detail: string; output: string }
  | { kind: "step"; round: number; reply: string; text: string }
  | { kind: "finish"; ok: boolean };

export type AgentEvent = AgentEventBody & { seq: number; at: number };

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

  open(id: string): void {
    this.prune();
    this.jobs.set(id, { events: [], result: null, done: false, startedAt: this.now(), endedAt: null, abort: null });
  }

  emit(id: string, body: AgentEventBody): void {
    const job = this.jobs.get(id);
    if (!job || job.done) return;
    const trimmed = trimBody(body);
    const seq = job.events.length ? (job.events[job.events.length - 1]?.seq ?? 0) + 1 : 1;
    job.events.push({ ...trimmed, seq, at: this.now() });
    if (job.events.length > MAX_EVENTS) job.events.splice(0, job.events.length - MAX_EVENTS);
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
export function describeStepFrame(raw: string): { kind: "fail"; message: string } | { kind: "ok"; reply: string; text: string; effects: { tool: string; detail: string; output: string }[] } | null {
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
  return { kind: "ok", reply, text, effects: parseEffects(effects) };
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
  running: boolean;
  compileError: string;
  calls: { tool: string; detail: string }[];
  effects: { tool: string; detail: string; output: string }[];
  reply: { kind: string; text: string } | null;
};

export function foldRounds(events: AgentEvent[]): Round[] {
  const rounds = new Map<number, Round>();
  const at = (round: number): Round => {
    let found = rounds.get(round);
    if (!found) {
      found = { round, thinking: false, code: "", modelError: "", running: false, compileError: "", calls: [], effects: [], reply: null };
      rounds.set(round, found);
    }
    return found;
  };
  for (const event of events) {
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
      case "effect":
        at(event.round).effects.push({ tool: event.tool, detail: event.detail, output: event.output });
        break;
      case "step": {
        const round = at(event.round);
        round.running = false;
        round.calls = [];
        round.reply = { kind: event.reply, text: event.text };
        break;
      }
      default:
        break;
    }
  }
  return [...rounds.values()].sort((left, right) => left.round - right.round);
}
