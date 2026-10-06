export type DurableError = {
  layer: string;
  code: string;
  message: string;
  retry_advice: string;
};

export type DurableReply = {
  tag: "Continue" | "Done" | "Ask" | "Partial";
  text: string;
};

export type DurableApproval = {
  seq: number;
  request_hash: string;
  params: string;
  recorded_decision: string | null;
};

export type DurableProjection = {
  run_id: string;
  phase: "generation" | "admission" | "execution";
  execution_hash: string | null;
  store_state: string | null;
  activity: "active" | "idle" | "uncertain";
  revision: number | null;
  epoch: number | null;
  reply: DurableReply | null;
  pending_approval: DurableApproval | null;
  error: DurableError | null;
  source_hash: string | null;
  artifact_hash: string | null;
  compiler_id: string | null;
  runtime_id: string | null;
  policy_version: string | null;
  material: string;
  task: string;
  fetch_url: string;
  compile_count: number;
  notice: string | null;
  source: string;
};

export type DurableResponse = {
  ok: boolean;
  projection: DurableProjection | null;
  error: DurableError | null;
  runs: DurableProjection[];
  truncated: boolean;
};

const forbidden = new Set([
  "owner",
  "path",
  "storePath",
  "store_path",
  "issued",
  "policy",
  "fetch_url",
  "fetchUrl",
  "execution_hash",
  "epoch",
  "compiler_id",
  "runtime_id",
  "shell",
  "source",
]);

function record(input: unknown): Record<string, unknown> | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  return input as Record<string, unknown>;
}

export function readCreate(input: unknown): { dedupeKey: string; material: string; task: string } | { error: string } {
  const body = record(input);
  if (!body) return { error: "输入无效" };
  for (const key of Object.keys(body)) {
    if (forbidden.has(key) || (key !== "dedupeKey" && key !== "material" && key !== "task")) return { error: "不能提交路径、策略或 URL" };
  }
  const dedupeKey = body.dedupeKey;
  const material = body.material;
  const task = body.task ?? "";
  if (typeof dedupeKey !== "string" || dedupeKey.length < 1 || dedupeKey.length > 128 || dedupeKey.includes("/") || dedupeKey.includes("\\")) {
    return { error: "去重键无效" };
  }
  if (typeof material !== "string" || material.length < 1 || material.length > 65536) return { error: "材料无效" };
  if (typeof task !== "string" || task.length > 4000) return { error: "任务说明无效" };
  return { dedupeKey, material, task };
}

export function readRunId(input: unknown): { runId: string } | { error: string } {
  const body = record(input);
  if (!body) return { error: "输入无效" };
  for (const key of Object.keys(body)) {
    if (forbidden.has(key) || key !== "runId") return { error: "不能提交路径、策略或 URL" };
  }
  const runId = body.runId;
  if (typeof runId !== "string" || !/^[0-9a-f]{32}$/.test(runId)) return { error: "run_id 无效" };
  return { runId };
}

export function readResume(input: unknown): { runId: string; executionHash: string } | { error: string } {
  const body = record(input);
  if (!body) return { error: "输入无效" };
  for (const key of Object.keys(body)) {
    if (key !== "runId" && key !== "executionHash") return { error: "不能提交路径、策略或 URL" };
  }
  const runId = body.runId;
  const executionHash = body.executionHash;
  if (typeof runId !== "string" || !/^[0-9a-f]{32}$/.test(runId)) return { error: "run_id 无效" };
  if (typeof executionHash !== "string" || !/^[0-9a-f]{64}$/.test(executionHash)) return { error: "execution_hash 无效" };
  return { runId, executionHash };
}

export function readDecision(input: unknown):
  | { runId: string; executionHash: string; seq: number; requestHash: string; callbackId: string; decision: { tag: "Approved" } | { tag: "Rejected"; reason: string } }
  | { error: string } {
  const body = record(input);
  if (!body) return { error: "输入无效" };
  const allowed = new Set(["runId", "executionHash", "seq", "requestHash", "callbackId", "decision"]);
  for (const key of Object.keys(body)) {
    if (!allowed.has(key) || forbidden.has(key)) return { error: "不能提交路径、策略或 URL" };
  }
  const run = readResume({ runId: body.runId, executionHash: body.executionHash });
  if ("error" in run) return run;
  if (typeof body.seq !== "number" || !Number.isInteger(body.seq) || body.seq < 0) return { error: "seq 无效" };
  if (typeof body.requestHash !== "string" || !/^[0-9a-f]{64}$/.test(body.requestHash)) return { error: "请求哈希无效" };
  if (typeof body.callbackId !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(body.callbackId)) return { error: "callback 无效" };
  const decision = record(body.decision);
  if (!decision) return { error: "决定无效" };
  if (decision.tag === "Approved" && Object.keys(decision).length === 1) {
    return { ...run, seq: body.seq, requestHash: body.requestHash, callbackId: body.callbackId, decision: { tag: "Approved" } };
  }
  if (decision.tag === "Rejected" && typeof decision.reason === "string" && decision.reason.length > 0 && decision.reason.length <= 500 && Object.keys(decision).length === 2) {
    return { ...run, seq: body.seq, requestHash: body.requestHash, callbackId: body.callbackId, decision: { tag: "Rejected", reason: decision.reason } };
  }
  return { error: "决定必须是批准或带理由的拒绝" };
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asError(value: unknown): DurableError | null {
  const body = record(value);
  if (!body) return null;
  const layer = asString(body.layer);
  const code = asString(body.code);
  const message = asString(body.message);
  const retry = asString(body.retry_advice);
  if (!layer || !code || !message || retry === null) return null;
  return { layer, code, message, retry_advice: retry };
}

export function parseProjection(value: unknown): DurableProjection | null {
  const body = record(value);
  if (!body) return null;
  const runId = asString(body.run_id);
  const phase = body.phase === "generation" || body.phase === "admission" || body.phase === "execution" ? body.phase : null;
  const activity = body.activity === "active" || body.activity === "idle" || body.activity === "uncertain" ? body.activity : null;
  if (!runId || !phase || !activity || typeof body.material !== "string" || typeof body.task !== "string" || typeof body.fetch_url !== "string") return null;
  if (typeof body.compile_count !== "number" || typeof body.source !== "string") return null;
  let reply: DurableReply | null = null;
  if (body.reply !== null && body.reply !== undefined) {
    const raw = record(body.reply);
    const tag = raw && asString(raw.tag);
    const text = raw && asString(raw.text);
    if (tag !== "Continue" && tag !== "Done" && tag !== "Ask" && tag !== "Partial") return null;
    if (text === null) return null;
    reply = { tag, text };
  }
  let pending: DurableApproval | null = null;
  if (body.pending_approval !== null && body.pending_approval !== undefined) {
    const raw = record(body.pending_approval);
    if (!raw || typeof raw.seq !== "number" || typeof raw.request_hash !== "string" || typeof raw.params !== "string") return null;
    const recorded = raw.recorded_decision === null ? null : asString(raw.recorded_decision);
    if (raw.recorded_decision !== null && recorded === null) return null;
    pending = { seq: raw.seq, request_hash: raw.request_hash, params: raw.params, recorded_decision: recorded };
  }
  const num = (value: unknown) => (typeof value === "number" ? value : value === null ? null : undefined);
  const revision = num(body.revision);
  const epoch = num(body.epoch);
  if (revision === undefined || epoch === undefined) return null;
  return {
    run_id: runId,
    phase,
    execution_hash: body.execution_hash === null ? null : asString(body.execution_hash),
    store_state: body.store_state === null ? null : asString(body.store_state),
    activity,
    revision,
    epoch,
    reply,
    pending_approval: pending,
    error: body.error === null || body.error === undefined ? null : asError(body.error),
    source_hash: body.source_hash === null ? null : asString(body.source_hash),
    artifact_hash: body.artifact_hash === null ? null : asString(body.artifact_hash),
    compiler_id: body.compiler_id === null ? null : asString(body.compiler_id),
    runtime_id: body.runtime_id === null ? null : asString(body.runtime_id),
    policy_version: body.policy_version === null ? null : asString(body.policy_version),
    material: body.material,
    task: body.task,
    fetch_url: body.fetch_url,
    compile_count: body.compile_count,
    notice: body.notice === null ? null : asString(body.notice),
    source: body.source,
  };
}

export function parseResponse(value: unknown): DurableResponse | null {
  const body = record(value);
  if (!body || typeof body.ok !== "boolean" || typeof body.truncated !== "boolean" || !Array.isArray(body.runs)) return null;
  const projection = body.projection === null ? null : parseProjection(body.projection);
  if (body.projection !== null && !projection) return null;
  const runs: DurableProjection[] = [];
  for (const item of body.runs) {
    const parsed = parseProjection(item);
    if (!parsed) return null;
    runs.push(parsed);
  }
  const error = body.error === null ? null : asError(body.error);
  if (body.error !== null && !error) return null;
  return { ok: body.ok, projection, error, runs, truncated: body.truncated };
}

export function callbackFor(runId: string, seq: number, requestHash: string, decision: "Approved" | "Rejected"): string {
  const key = `ocagent-decision:${runId}:${seq}:${requestHash}:${decision}`;
  const saved = sessionStorage.getItem(key);
  if (saved && /^[A-Za-z0-9._:-]{1,128}$/.test(saved)) return saved;
  const created = `cb-${crypto.randomUUID()}`;
  sessionStorage.setItem(key, created);
  return created;
}
