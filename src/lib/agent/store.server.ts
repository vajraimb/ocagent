// Durable state for desks and runs (Postgres via @/lib/db: Neon when deployed,
// embedded PGLite in the preview). Rows are unowned: a desk id is an
// unguessable key the browser holds, and that key is the whole access model.
import { getSql, type Sql } from "@/lib/db";
import { normalizeHarnesses, normalizeModules, type DeskModule, type HarnessId } from "./harness.ts";
import type { AgentEvent } from "./progress.ts";
import { safePath, type DeskFile, type JournalItem, type ToolStep } from "./workspace.ts";

export type DeskState = { files: DeskFile[]; harnesses: HarnessId[]; modules: DeskModule[]; journal: JournalItem[]; memory: string };
export type DeskRecord = DeskState & { id: string; revision: number; updatedAt: number };

export type RunStatus = "running" | "paused" | "done" | "failed" | "stopped";

// What a finished (or paused) run leaves behind besides its timeline.
export type RunOutcome = { ok: boolean; answer: string; steps: ToolStep[]; touched: string[] };

export type RunRecord = {
  id: string;
  deskId: string;
  task: string;
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

type DeskRow = { id: string; files: unknown; harnesses: unknown; modules: unknown; journal: unknown; memory: string; revision: number; updated_at: number };
type RunRow = {
  id: string;
  desk_id: string;
  task: string;
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
    if (safePath(path)) files.push({ path, content });
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
  return { ok: item.ok, answer: item.answer, steps: Array.isArray(item.steps) ? item.steps : [], touched: Array.isArray(item.touched) ? item.touched : [] };
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
    revision: Number(row.revision) || 0,
    updatedAt: Number(row.updated_at) || 0,
  };
}

function runOf(row: RunRow): RunRecord {
  return {
    id: row.id,
    deskId: row.desk_id,
    task: row.task,
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
    insert into desks (id, files, harnesses, modules, journal, memory, revision, created_at, updated_at)
    values (${id}, ${JSON.stringify(state.files)}::jsonb, ${JSON.stringify(state.harnesses)}::jsonb, ${JSON.stringify(state.modules)}::jsonb, ${JSON.stringify(state.journal)}::jsonb, ${state.memory}, 1, ${now}, ${now})
    on conflict (id) do update set
      files = excluded.files,
      harnesses = excluded.harnesses,
      modules = excluded.modules,
      journal = excluded.journal,
      memory = excluded.memory,
      revision = desks.revision + 1,
      updated_at = excluded.updated_at
    returning *`;
  return deskOf(rows[0]!);
}

// Settings the user changes between runs; the loop's own state is untouched.
export async function writeDeskSettings(id: string, patch: Partial<Pick<DeskState, "files" | "harnesses" | "modules">>): Promise<DeskRecord | null> {
  const current = await readDesk(id);
  if (!current) return null;
  return writeDesk(id, { ...current, ...patch });
}

export async function createRun(deskId: string, id: string, task: string): Promise<RunRecord> {
  const sql = await getSql();
  const now = Date.now();
  const rows = await sql<RunRow>`
    insert into runs (id, desk_id, task, status, segment, rounds, events, result, stop_requested, created_at, updated_at)
    values (${id}, ${deskId}, ${task}, 'running', 1, 0, '[]'::jsonb, null, false, ${now}, ${now})
    returning *`;
  return runOf(rows[0]!);
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

export async function beginSegment(id: string, segment: number): Promise<void> {
  const sql = await getSql();
  await sql`update runs set status = 'running', segment = ${segment}, stop_requested = false, updated_at = ${Date.now()}, ended_at = null where id = ${id}`;
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
  await writeDesk(id, { files: [], harnesses: normalizeHarnesses(undefined), modules: [], journal: [], memory: "" });
}
