// Durable state for desks and runs (Postgres via @/lib/db: Neon when deployed,
// embedded PGLite in the preview). Rows are unowned: a desk id is an
// unguessable key the browser holds, and that key is the whole access model.
import { dbSource, getSql, type Sql } from "@/lib/db";
import { normalizeHarnesses, normalizeModules, type DeskModule, type HarnessId } from "./harness.ts";
import { normalizeNotes, type AgentEvent, type PlanItem, type PlanState } from "./progress.ts";
import { isScratchFile, safePath, type DeskFile, type JournalItem, type ToolStep } from "./workspace.ts";
import type { LastOutcome } from "./run.ts";

export type DeskState = { files: DeskFile[]; harnesses: HarnessId[]; modules: DeskModule[]; journal: JournalItem[]; memory: string; notes: string[] };
export type DeskRecord = DeskState & { id: string; revision: number; updatedAt: number; notifyUrl: string };

export type RunStatus = "running" | "paused" | "done" | "failed" | "stopped";

// What a finished (or paused) run leaves behind besides its timeline.
export type RunOutcome = { ok: boolean; answer: string; steps: ToolStep[]; touched: string[]; plan?: PlanState; asked?: boolean; last?: LastOutcome };

/** True when rows outlive this server instance (Neon), false on the embedded fallback. */
export function isDurable(): boolean {
  return dbSource === "neon";
}

export type RunTrigger = "user" | "schedule";

export type RunRecord = {
  id: string;
  deskId: string;
  task: string;
  /** Who started it: the user, or one of the desk's schedules. */
  trigger: RunTrigger;
  status: RunStatus;
  segment: number;
  rounds: number;
  events: AgentEvent[];
  result: RunOutcome | null;
  stopRequested: boolean;
  createdAt: number;
  updatedAt: number;
  endedAt: number | null;
};

export const DESK_ID = /^desk-[a-z0-9-]{8,48}$/;
export const RUN_ID = /^run-[a-z0-9-]{8,48}$/;

// A run that has not written anything for this long is not running anywhere:
// the instance that had it died (or the gateway cut it) without a last word.
export const STALE_RUN_MS = 3 * 60_000;
export const STALE_RUN_TEXT = "这一段跑到一半断了，没有传回结果。工作区里写好的都还在；点「接着做」会从那里继续。";

const MAX_EVENTS_STORED = 400;
const RUNS_LISTED = 24;
const RUNS_WITH_EVENTS = 6;

type DeskRow = { id: string; files: unknown; harnesses: unknown; modules: unknown; journal: unknown; memory: string; notes: unknown; notify_url: string | null; revision: number; updated_at: number };
type RunRow = {
  id: string;
  desk_id: string;
  task: string;
  trigger?: string;
  status: string;
  segment: number;
  rounds: number;
  events: unknown;
  result: unknown;
  stop_requested: boolean;
  created_at: number;
  updated_at: number;
  ended_at: number | null;
};

function parsed(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function filesOf(raw: unknown): DeskFile[] {
  const list = parsed(raw);
  if (!Array.isArray(list)) return [];
  const files: DeskFile[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const path = "path" in item && typeof item.path === "string" ? item.path : "";
    const content = "content" in item && typeof item.content === "string" ? item.content : "";
    if (safePath(path) && !isScratchFile(path)) files.push({ path, content });
  }
  return files;
}

function journalOf(raw: unknown): JournalItem[] {
  const list = parsed(raw);
  if (!Array.isArray(list)) return [];
  const items: JournalItem[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const kind = "kind" in item && typeof item.kind === "string" ? item.kind : "";
    const text = "text" in item && typeof item.text === "string" ? item.text : "";
    if (kind) items.push({ kind, text });
  }
  return items;
}

function eventsOf(raw: unknown): AgentEvent[] {
  const list = parsed(raw);
  return Array.isArray(list) ? (list.filter((item) => item && typeof item === "object" && "kind" in item && "seq" in item) as AgentEvent[]) : [];
}

function outcomeOf(raw: unknown): RunOutcome | null {
  const value = parsed(raw);
  if (!value || typeof value !== "object") return null;
  const item = value as Partial<RunOutcome>;
  if (typeof item.ok !== "boolean" || typeof item.answer !== "string") return null;
  const outcome: RunOutcome = { ok: item.ok, answer: item.answer, steps: Array.isArray(item.steps) ? item.steps : [], touched: Array.isArray(item.touched) ? item.touched : [] };
  const plan = planOf(item.plan);
  if (plan) outcome.plan = plan;
  if (item.asked === true) outcome.asked = true;
  const last = lastOf(item.last);
  if (last) outcome.last = last;
  return outcome;
}

// The carried last-step outcome is the loop's own data; only its shape is checked.
function lastOf(raw: unknown): LastOutcome {
  if (!raw || typeof raw !== "object" || typeof (raw as { kind?: unknown }).kind !== "string") return null;
  const item = raw as Record<string, unknown>;
  if (item.kind === "ran" && typeof item.reply === "string" && Array.isArray(item.effects)) {
    return {
      kind: "ran",
      round: Number(item.round) || 0,
      reply: item.reply,
      text: typeof item.text === "string" ? item.text : "",
      effects: item.effects
        .filter((effect): effect is { tool: string; detail: string; output: string } => !!effect && typeof effect === "object" && typeof (effect as { tool?: unknown }).tool === "string")
        .map((effect) => ({ tool: effect.tool, detail: String(effect.detail ?? ""), output: String(effect.output ?? "") })),
    };
  }
  if ((item.kind === "compile_failed" || item.kind === "runner_failed" || item.kind === "model_error") && typeof item.message === "string") {
    if (item.kind === "compile_failed") return { kind: "compile_failed", message: item.message, code: typeof item.code === "string" ? item.code : "" };
    return { kind: item.kind, message: item.message };
  }
  return null;
}

function planOf(raw: unknown): PlanState | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Partial<PlanState>;
  const items: PlanItem[] = [];
  for (const item of Array.isArray(value.items) ? value.items : []) {
    if (!item || typeof item !== "object" || typeof (item as PlanItem).text !== "string") continue;
    const it = item as Partial<PlanItem>;
    items.push({ text: it.text ?? "", done: Boolean(it.done), note: typeof it.note === "string" ? it.note : "" });
  }
  const strings = (list: unknown): string[] => (Array.isArray(list) ? list.filter((item): item is string => typeof item === "string") : []);
  const origin: Record<string, string | null> = {};
  if (value.origin && typeof value.origin === "object") {
    for (const [path, content] of Object.entries(value.origin)) if (content === null || typeof content === "string") origin[path] = content;
  }
  return {
    items,
    checks: Number.isInteger(value.checks) ? (value.checks as number) : 0,
    wrote: Boolean(value.wrote),
    pending: typeof value.pending === "string" ? value.pending : null,
    failed: strings(value.failed),
    written: strings(value.written),
    origin,
  };
}

function statusOf(raw: string): RunStatus {
  return raw === "running" || raw === "paused" || raw === "done" || raw === "failed" || raw === "stopped" ? raw : "failed";
}

function deskOf(row: DeskRow): DeskRecord {
  return {
    id: row.id,
    files: filesOf(row.files),
    harnesses: normalizeHarnesses(parsed(row.harnesses)),
    modules: normalizeModules(parsed(row.modules)),
    journal: journalOf(row.journal),
    memory: typeof row.memory === "string" ? row.memory : "",
    notes: normalizeNotes(parsed(row.notes)),
    notifyUrl: typeof row.notify_url === "string" ? row.notify_url : "",
    revision: Number(row.revision) || 0,
    updatedAt: Number(row.updated_at) || 0,
  };
}

function runOf(row: RunRow): RunRecord {
  return {
    id: row.id,
    deskId: row.desk_id,
    task: row.task,
    trigger: row.trigger === "schedule" ? "schedule" : "user",
    status: statusOf(row.status),
    segment: Number(row.segment) || 1,
    rounds: Number(row.rounds) || 0,
    events: eventsOf(row.events),
    result: outcomeOf(row.result),
    stopRequested: Boolean(row.stop_requested),
    createdAt: Number(row.created_at) || 0,
    updatedAt: Number(row.updated_at) || 0,
    endedAt: row.ended_at === null || row.ended_at === undefined ? null : Number(row.ended_at),
  };
}

export async function readDesk(id: string): Promise<DeskRecord | null> {
  const sql = await getSql();
  const rows = await sql<DeskRow>`select * from desks where id = ${id}`;
  return rows[0] ? deskOf(rows[0]) : null;
}

export async function writeDesk(id: string, state: DeskState): Promise<DeskRecord> {
  const sql = await getSql();
  const now = Date.now();
  const rows = await sql<DeskRow>`
    insert into desks (id, files, harnesses, modules, journal, memory, notes, revision, created_at, updated_at)
    values (${id}, ${JSON.stringify(state.files)}::jsonb, ${JSON.stringify(state.harnesses)}::jsonb, ${JSON.stringify(state.modules)}::jsonb, ${JSON.stringify(state.journal)}::jsonb, ${state.memory}, ${JSON.stringify(normalizeNotes(state.notes))}::jsonb, 1, ${now}, ${now})
    on conflict (id) do update set
      files = excluded.files,
      harnesses = excluded.harnesses,
      modules = excluded.modules,
      journal = excluded.journal,
      memory = excluded.memory,
      notes = excluded.notes,
      revision = desks.revision + 1,
      updated_at = excluded.updated_at
    returning *`;
  return deskOf(rows[0]!);
}

// Settings the user changes between runs; the loop's own state is untouched.
export async function writeDeskSettings(id: string, patch: Partial<Pick<DeskState, "files" | "harnesses" | "modules" | "notes">>): Promise<DeskRecord | null> {
  const current = await readDesk(id);
  if (!current) return null;
  return writeDesk(id, { ...current, ...patch });
}

// The desk's notify address, set from the panel; blank means none.
export async function writeDeskNotify(id: string, notifyUrl: string): Promise<DeskRecord | null> {
  const sql = await getSql();
  const rows = await sql<DeskRow>`update desks set notify_url = ${notifyUrl}, updated_at = ${Date.now()} where id = ${id} returning *`;
  return rows[0] ? deskOf(rows[0]) : null;
}

export async function createRun(deskId: string, id: string, task: string, trigger: RunTrigger = "user"): Promise<RunRecord> {
  const sql = await getSql();
  const now = Date.now();
  const rows = await sql<RunRow>`
    insert into runs (id, desk_id, task, trigger, status, segment, rounds, events, result, stop_requested, created_at, updated_at)
    values (${id}, ${deskId}, ${task}, ${trigger}, 'running', 1, 0, '[]'::jsonb, null, false, ${now}, ${now})
    returning *`;
  return runOf(rows[0]!);
}

// ---------------------------------------------------------------------------
// Schedules: "every day at this time, give the desk this task".

export type ScheduleRecord = {
  id: string;
  deskId: string;
  task: string;
  time: string;
  tz: string;
  enabled: boolean;
  nextAt: number;
  lastAt: number | null;
  lastRunId: string | null;
  createdAt: number;
};

type ScheduleRow = { id: string; desk_id: string; task: string; at_time: string; tz: string; enabled: boolean; next_at: number; last_at: number | null; last_run_id: string | null; created_at: number };

function scheduleOf(row: ScheduleRow): ScheduleRecord {
  return {
    id: row.id,
    deskId: row.desk_id,
    task: row.task,
    time: row.at_time,
    tz: row.tz,
    enabled: Boolean(row.enabled),
    nextAt: Number(row.next_at) || 0,
    lastAt: row.last_at === null || row.last_at === undefined ? null : Number(row.last_at),
    lastRunId: row.last_run_id ?? null,
    createdAt: Number(row.created_at) || 0,
  };
}

export async function listSchedules(deskId: string): Promise<ScheduleRecord[]> {
  const sql = await getSql();
  const rows = await sql<ScheduleRow>`select * from schedules where desk_id = ${deskId} order by created_at asc`;
  return rows.map(scheduleOf);
}

// Adds a daily schedule; the same task at the same time is one schedule.
export async function addSchedule(deskId: string, spec: { time: string; tz: string; task: string }, nextAt: number, max: number): Promise<{ ok: true; schedule: ScheduleRecord; existed: boolean } | { ok: false; error: string }> {
  const sql = await getSql();
  const existing = await listSchedules(deskId);
  const same = existing.find((item) => item.time === spec.time && item.tz === spec.tz && item.task === spec.task);
  if (same) return { ok: true, schedule: same, existed: true };
  if (existing.length >= max) return { ok: false, error: `这个工作区已经有 ${existing.length} 个定时任务，最多 ${max} 个；先取消一个。` };
  const now = Date.now();
  const id = `sch-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const rows = await sql<ScheduleRow>`
    insert into schedules (id, desk_id, task, at_time, tz, enabled, next_at, last_at, last_run_id, created_at, updated_at)
    values (${id}, ${deskId}, ${spec.task}, ${spec.time}, ${spec.tz}, true, ${nextAt}, null, null, ${now}, ${now})
    returning *`;
  return { ok: true, schedule: scheduleOf(rows[0]!), existed: false };
}

export async function removeSchedule(deskId: string, id: string): Promise<boolean> {
  const sql = await getSql();
  const rows = await sql<{ id: string }>`delete from schedules where id = ${id} and desk_id = ${deskId} returning id`;
  return rows.length > 0;
}

// Schedules whose time has come, oldest due first.
export async function dueSchedules(now: number, limit: number): Promise<ScheduleRecord[]> {
  const sql = await getSql();
  const rows = await sql<ScheduleRow>`select * from schedules where enabled and next_at <= ${now} order by next_at asc limit ${limit}`;
  return rows.map(scheduleOf);
}

// Takes a due schedule for one run: moves it to its next time so no other
// instance starts the same occurrence. Null when someone else got it first.
export async function claimSchedule(id: string, dueAt: number, nextAt: number, runId: string): Promise<ScheduleRecord | null> {
  const sql = await getSql();
  const now = Date.now();
  const rows = await sql<ScheduleRow>`
    update schedules set next_at = ${nextAt}, last_at = ${now}, last_run_id = ${runId}, updated_at = ${now}
    where id = ${id} and enabled and next_at = ${dueAt}
    returning *`;
  return rows[0] ? scheduleOf(rows[0]) : null;
}

// A "running" row nobody has touched for a while is a dead segment: say so
// once, in the row, so every reader agrees.
async function settleStale(sql: Sql, run: RunRecord): Promise<RunRecord> {
  if (run.status !== "running" || Date.now() - run.updatedAt < STALE_RUN_MS) return run;
  const now = Date.now();
  const result: RunOutcome = { ok: false, answer: STALE_RUN_TEXT, steps: run.result?.steps ?? [], touched: run.result?.touched ?? [] };
  await sql`update runs set status = 'failed', result = ${JSON.stringify(result)}::jsonb, updated_at = ${now}, ended_at = ${now} where id = ${run.id} and status = 'running'`;
  return { ...run, status: "failed", result, updatedAt: now, endedAt: now };
}

export async function getRun(id: string): Promise<RunRecord | null> {
  const sql = await getSql();
  const rows = await sql<RunRow>`select * from runs where id = ${id}`;
  return rows[0] ? settleStale(sql, runOf(rows[0])) : null;
}

// The desk's recent runs, oldest first. Timelines ride along only for the
// newest few; older ones are fetched on demand when the user expands them.
export async function listRuns(deskId: string): Promise<RunRecord[]> {
  const sql = await getSql();
  const rows = await sql<RunRow>`select * from runs where desk_id = ${deskId} order by created_at desc limit ${RUNS_LISTED}`;
  const runs: RunRecord[] = [];
  for (const [index, row] of rows.entries()) {
    const run = await settleStale(sql, runOf(row));
    runs.push(index < RUNS_WITH_EVENTS ? run : { ...run, events: [] });
  }
  return runs.reverse();
}

// Marks a segment as alive and appends what it emitted since the last flush.
export async function appendRunEvents(id: string, events: AgentEvent[], rounds: number): Promise<void> {
  const sql = await getSql();
  const now = Date.now();
  if (events.length === 0) {
    await sql`update runs set updated_at = ${now}, rounds = greatest(rounds, ${rounds}) where id = ${id}`;
    return;
  }
  await sql`update runs set events = events || ${JSON.stringify(events)}::jsonb, rounds = greatest(rounds, ${rounds}), updated_at = ${now} where id = ${id}`;
}

// Takes a paused run's next segment, if nobody else has: the page and the
// server both try after a pause, and exactly one of them gets to run it.
export async function claimSegment(id: string, fromSegment: number): Promise<RunRecord | null> {
  const sql = await getSql();
  const rows = await sql<RunRow>`
    update runs set status = 'running', segment = ${fromSegment + 1}, stop_requested = false, updated_at = ${Date.now()}, ended_at = null
    where id = ${id} and status = 'paused' and segment = ${fromSegment}
    returning *`;
  return rows[0] ? runOf(rows[0]) : null;
}

export async function finishRun(id: string, status: Exclude<RunStatus, "running">, rounds: number, result: RunOutcome): Promise<void> {
  const sql = await getSql();
  const now = Date.now();
  await sql`update runs set status = ${status}, rounds = greatest(rounds, ${rounds}), result = ${JSON.stringify(result)}::jsonb, updated_at = ${now}, ended_at = ${status === "paused" ? null : now} where id = ${id}`;
  // Keep the stored timeline bounded; the registry already clips what it holds.
  const rows = await sql<{ n: number }>`select jsonb_array_length(events) as n from runs where id = ${id}`;
  const n = Number(rows[0]?.n ?? 0);
  if (n > MAX_EVENTS_STORED) {
    await sql`update runs set events = (select coalesce(jsonb_agg(e), '[]'::jsonb) from (select e from jsonb_array_elements(events) with ordinality as t(e, i) where i > ${n - MAX_EVENTS_STORED} order by i) s) where id = ${id}`;
  }
}

export async function requestStop(id: string): Promise<boolean> {
  const sql = await getSql();
  const rows = await sql<{ id: string }>`update runs set stop_requested = true, updated_at = ${Date.now()} where id = ${id} and status = 'running' returning id`;
  return rows.length > 0;
}

export async function stopRequested(id: string): Promise<boolean> {
  const sql = await getSql();
  const rows = await sql<{ stop_requested: boolean }>`select stop_requested from runs where id = ${id}`;
  return Boolean(rows[0]?.stop_requested);
}

export async function activeRun(deskId: string): Promise<RunRecord | null> {
  const sql = await getSql();
  const rows = await sql<RunRow>`select * from runs where desk_id = ${deskId} and status in ('running', 'paused') order by created_at desc limit 1`;
  if (!rows[0]) return null;
  const run = await settleStale(sql, runOf(rows[0]));
  return run.status === "running" || run.status === "paused" ? run : null;
}

export async function clearDesk(id: string): Promise<void> {
  const sql = await getSql();
  await sql`delete from runs where desk_id = ${id} and status not in ('running')`;
  await sql`delete from schedules where desk_id = ${id}`;
  await writeDesk(id, { files: [], harnesses: normalizeHarnesses(undefined), modules: [], journal: [], memory: "", notes: [] });
}
