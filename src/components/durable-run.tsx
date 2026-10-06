import { useEffect, useState } from "react";
import { createDurableRun, decideDurableApproval, generateDurableRun, getDurableRun, listDurableRuns, resumeDurableRun } from "@/lib/agent/durable-api";
import { callbackFor, type DurableProjection, type DurableResponse } from "@/lib/agent/durable-types";

const RUN_KEY = "ocagent-durable-run";
const STAGES = ["建立", "接纳", "执行", "审批", "结果"] as const;

function freshKey() {
  return `run-${crypto.randomUUID().slice(0, 8)}`;
}

function stateLabel(run: DurableProjection | null) {
  if (!run) return "未选择";
  switch (run.store_state) {
    case "Prepared":
      return "已接纳";
    case "Running":
      return "执行记录仍在";
    case "AwaitingApproval":
      return "等待审批";
    case "BlockedUnknown":
      return "结果未知";
    case "Completed":
      return "已完成";
    case "Failed":
      return "失败";
    default:
      return run.phase === "generation" ? "生成已派出" : run.phase === "admission" ? "已建立，尚未接纳" : (run.store_state ?? "状态未识别");
  }
}

function stageIndex(run: DurableProjection | null) {
  switch (run?.store_state) {
    case "Prepared":
      return 1;
    case "Running":
      return 2;
    case "AwaitingApproval":
      return 3;
    case "Completed":
    case "Failed":
    case "BlockedUnknown":
      return 4;
    default:
      return run ? 0 : -1;
  }
}

function activityLabel(activity: DurableProjection["activity"]) {
  if (activity === "uncertain") return "活性不确定";
  if (activity === "active") return "尝试进行中";
  return "空闲";
}

function replyNote(tag: "Continue" | "Done" | "Ask" | "Partial") {
  if (tag === "Done") return "这是本 Step 的完成回复。";
  if (tag === "Ask") return "Ask 是回复类型，不是审批。待授权只看「等待审批」。";
  if (tag === "Continue") return "Continue 仍是这一步的回复，不会自动开始下一步。";
  return "Partial 仍是这一步的回复，不会自动补全。";
}

function shortId(id: string) {
  return id.length > 12 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id;
}

function firstLine(text: string) {
  const line = text.split("\n").find((item) => item.trim().length > 0) ?? "";
  return line.length > 42 ? `${line.slice(0, 42)}…` : line;
}

export function DurableRun() {
  const [dedupeKey, setDedupeKey] = useState("");
  const [material, setMaterial] = useState("");
  const [task, setTask] = useState("");
  const [reason, setReason] = useState("");
  const [run, setRun] = useState<DurableProjection | null>(null);
  const [runs, setRuns] = useState<DurableProjection[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [actionError, setActionError] = useState("");
  const [advice, setAdvice] = useState("");
  const [busy, setBusy] = useState(false);
  const [booting, setBooting] = useState(true);
  const [composing, setComposing] = useState(false);
  const [watching, setWatching] = useState(true);
  const [stoppedNote, setStoppedNote] = useState("");
  const [linkNote, setLinkNote] = useState("");

  function apply(result: DurableResponse) {
    if (result.projection) {
      setRun(result.projection);
      setComposing(false);
      localStorage.setItem(RUN_KEY, result.projection.run_id);
    }
    if (result.runs.length) setRuns(result.runs);
    setTruncated(result.truncated);
    const fault = result.error;
    if (fault) {
      setActionError(`${fault.layer} · ${fault.code}：${fault.message}`);
      setAdvice(fault.retry_advice);
    } else {
      setActionError("");
      setAdvice("");
    }
    setLinkNote("");
  }

  async function refresh(runId = run?.run_id): Promise<DurableResponse> {
    if (!runId) throw new Error("还没有 run");
    return getDurableRun({ data: { runId } });
  }

  useEffect(() => {
    setDedupeKey((current) => current || freshKey());
    const saved = localStorage.getItem(RUN_KEY);
    void listDurableRuns({ data: {} })
      .then((result) => {
        if (result.runs.length) setRuns(result.runs);
        setTruncated(result.truncated);
        if (!saved) {
          setComposing(true);
          return;
        }
        return getDurableRun({ data: { runId: saved } }).then(apply);
      })
      .catch(() => setLinkNote("列表没有读回来。页面没有把任务改成失败。"))
      .finally(() => setBooting(false));
  }, []);

  useEffect(() => {
    if (!watching || composing || !run || run.store_state === "Completed" || run.store_state === "Failed") return;
    const runId = run.run_id;
    const timer = window.setInterval(() => {
      void getDurableRun({ data: { runId } })
        .then(apply)
        .catch(() => setLinkNote("这次查询没有回来。状态没有被改成失败，也没有重发请求。"));
    }, 4000);
    return () => window.clearInterval(timer);
  }, [watching, composing, run?.run_id, run?.store_state]);

  async function act(work: () => Promise<DurableResponse>) {
    setBusy(true);
    setStoppedNote("");
    try {
      apply(await work());
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : "请求没有完成");
      setAdvice("这不是取消。刷新状态，看服务器上的记录。");
    } finally {
      setBusy(false);
    }
  }

  function beginNew() {
    setComposing(true);
    setRun(null);
    setDedupeKey(freshKey());
    setMaterial("");
    setTask("");
    setReason("");
    setActionError("");
    setAdvice("");
    setStoppedNote("");
    setLinkNote("");
    setWatching(true);
    localStorage.removeItem(RUN_KEY);
  }

  const approval = run?.pending_approval ?? null;
  const executionHash = run?.execution_hash ?? null;
  const decided = Boolean(approval?.recorded_decision);
  const unknown = run?.store_state === "BlockedUnknown" || run?.error?.code === "Unknown_result";
  const finished = run?.store_state === "Completed" || run?.store_state === "Failed";
  const canResume = Boolean(run && executionHash && !finished && !unknown && !busy);
  const current = stageIndex(run);
  const showRun = Boolean(run) && !composing;

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-2xl flex-col">
      <header className="px-4 pb-2 pt-3">
        <p className="font-mono text-xs tracking-widest text-muted">OCAGENT · GROK</p>
        <h1 className="mt-1 text-lg font-semibold text-fg">一次生成，一条耐久 Step</h1>
        <p className="mt-2 text-sm leading-6 text-muted">每个新 run 只向 Grok 请求一次，结果先保存再接纳。重复点击不会再生成。没有 Files、Search、Clock，抓取只走服务器配置的 GET /spec。</p>
      </header>

      <div className="flex flex-wrap gap-2 px-4">
        <button type="button" onClick={beginNew} className="min-h-11 rounded-lg border border-border px-3 text-sm text-fg">
          新建
        </button>
      </div>

      {composing ? (
        <section className="mx-4 mt-4 rounded-2xl border border-border bg-surface p-3">
          <p className="font-mono text-xs tracking-widest text-muted">生成并接纳</p>
          <p className="mt-2 text-sm leading-6 text-muted">材料在创建时冻结。Grok 只根据这份材料和说明写一次 Step。</p>
          <label className="mt-3 flex flex-col gap-2 text-sm text-fg">
            材料
            <textarea
              value={material}
              onChange={(event) => setMaterial(event.target.value)}
              rows={4}
              placeholder="冻结后只交给 Grok 写一次"
              className="w-full resize-y rounded-xl border border-border bg-bg px-3 py-3 text-sm leading-6 text-fg outline-none placeholder:text-muted focus:border-primary"
            />
          </label>
          <label className="mt-3 flex flex-col gap-2 text-sm text-fg">
            说明
            <input
              value={task}
              onChange={(event) => setTask(event.target.value)}
              placeholder="可选。告诉 Grok 要做什么。不参与第二次请求。"
              className="min-h-11 rounded-lg border border-border bg-bg px-3 text-sm text-fg outline-none placeholder:text-muted focus:border-primary"
            />
          </label>
          <p className="mt-3 break-all font-mono text-xs leading-5 text-muted">去重键 {dedupeKey || "…"}</p>
          <button
            type="button"
            disabled={busy || material.trim().length === 0 || dedupeKey.length === 0}
            onClick={() =>
              void act(async () => {
                const created = await createDurableRun({ data: { dedupeKey, material, task } });
                const runId = created.projection?.run_id;
                if (!created.ok || !runId) return created;
                const generated = await generateDurableRun({ data: { runId } });
                const listed = await listDurableRuns({ data: {} }).catch(() => null);
                const next = generated.projection ? generated : { ...generated, projection: created.projection };
                return listed ? { ...next, runs: listed.runs, truncated: listed.truncated } : next;
              })
            }
            className="mt-3 inline-flex min-h-11 items-center rounded-lg bg-primary px-4 text-sm font-medium text-primary-fg disabled:opacity-40"
          >
            {busy ? "正在向 Grok 请求一次" : "生成并接纳"}
          </button>
        </section>
      ) : null}

      {showRun && run ? (
        <section className="mx-4 mt-4 rounded-2xl border border-border bg-surface p-3">
          <p className="font-mono text-xs tracking-widest text-muted">服务器投影 · 不是页面计时</p>
          <div className="mt-2 flex items-start justify-between gap-3">
            <h2 className="text-lg font-semibold text-fg">{stateLabel(run)}</h2>
            <p className="shrink-0 rounded-lg border border-border px-2 py-1 font-mono text-xs text-muted">{activityLabel(run.activity)}</p>
          </div>
          {run.notice ? <p className="mt-2 text-sm leading-6 text-muted">{run.notice} 刷新不会领取执行，也不会把它当成活进程。</p> : null}
          {run.activity === "uncertain" && !run.notice ? <p className="mt-2 text-sm leading-6 text-muted">活性不确定。过时的 Running 不是正在跑的进程。</p> : null}

          <ol className="mt-3 grid grid-cols-5 gap-1">
            {STAGES.map((label, index) => {
              const here = index === current;
              const blocked = here && (unknown || run.store_state === "Failed");
              const tone = blocked ? "bg-raised text-danger" : here ? "bg-raised text-fg" : index < current ? "text-fg" : "text-muted";
              return (
                <li key={label} className={`rounded-lg px-1 py-2 text-center font-mono text-xs ${tone}`}>
                  {label}
                </li>
              );
            })}
          </ol>
          <p className="mt-2 font-mono text-xs leading-5 text-muted">
            原始状态 {run.store_state ?? "无"} · epoch {run.epoch ?? "—"} · revision {run.revision ?? "—"}
          </p>

          <dl className="mt-3 grid gap-3 font-mono text-xs leading-5">
            <div className="min-w-0">
              <dt className="text-muted">run</dt>
              <dd className="mt-1 break-all text-fg">{run.run_id}</dd>
            </div>
            <div className="min-w-0">
              <dt className="text-muted">execution</dt>
              <dd className="mt-1 break-all text-fg">{run.execution_hash ?? "尚未接纳"}</dd>
            </div>
            <div className="min-w-0">
              <dt className="text-muted">artifact</dt>
              <dd className="mt-1 break-all text-fg">{run.artifact_hash ?? "—"}</dd>
            </div>
          </dl>

          {run.material ? (
            <div className="mt-3">
              <p className="font-mono text-xs text-muted">冻结材料</p>
              <p className="mt-1 whitespace-pre-wrap text-sm leading-6 text-fg">{run.material}</p>
              {run.task ? <p className="mt-1 text-sm leading-6 text-muted">{run.task}</p> : null}
            </div>
          ) : null}

          {run.reply ? (
            <div className="mt-3 rounded-xl bg-bg px-3 py-3">
              <p className="font-mono text-xs tracking-widest text-muted">{run.reply.tag}</p>
              <p className="mt-1 whitespace-pre-wrap text-sm leading-6 text-fg">{run.reply.text}</p>
              <p className="mt-2 text-sm leading-6 text-muted">{replyNote(run.reply.tag)}</p>
            </div>
          ) : null}

          {unknown ? (
            <div className="mt-3 rounded-xl border border-danger px-3 py-3">
              <p className="text-sm font-medium text-danger">可能已经执行，禁止自动重试</p>
              <p className="mt-1 text-sm leading-6 text-muted">{run.error?.message ?? "结果未知。"} 没有「重试 Fetch」。刷新只回读记录。</p>
            </div>
          ) : null}

          {run.error && !unknown ? (
            <div className="mt-3 rounded-xl border border-border px-3 py-3">
              <p className="text-sm text-danger">
                {run.error.layer} · {run.error.code}：{run.error.message}
              </p>
              <p className="mt-1 text-sm leading-6 text-muted">{run.error.retry_advice}</p>
            </div>
          ) : null}

          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              disabled={!canResume}
              onClick={() => executionHash && void act(() => resumeDurableRun({ data: { runId: run.run_id, executionHash } }))}
              className={`inline-flex min-h-11 items-center rounded-lg px-4 text-sm font-medium disabled:opacity-40 ${
                run.store_state === "Prepared" || decided ? "bg-primary text-primary-fg" : "border border-border text-fg"
              }`}
            >
              {decided ? "恢复执行" : "开始/恢复"}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void act(() => refresh())}
              className={`inline-flex min-h-11 items-center rounded-lg px-4 text-sm disabled:opacity-40 ${
                finished || unknown ? "bg-primary font-medium text-primary-fg" : "border border-border text-fg"
              }`}
            >
              刷新状态
            </button>
            {watching ? (
              <button
                type="button"
                onClick={() => {
                  setWatching(false);
                  setStoppedNote("已停止查看。后台可能仍在运行，这不是取消。");
                }}
                className="inline-flex min-h-11 items-center rounded-lg border border-border px-4 text-sm text-muted"
              >
                停止查看
              </button>
            ) : (
              <button
                type="button"
                onClick={() => {
                  setWatching(true);
                  setStoppedNote("");
                  void act(() => refresh());
                }}
                className="inline-flex min-h-11 items-center rounded-lg border border-border px-4 text-sm text-fg"
              >
                继续查看
              </button>
            )}
          </div>
          <p className="mt-2 text-sm leading-6 text-muted">
            {unknown
              ? "未知结果不会从这里重发外部请求。"
              : finished
                ? "已结束的查看不会启动 worker，也不会重编译。"
                : decided
                  ? "决定已经记下。恢复执行才会继续这条已接纳的产物。"
                  : "开始/恢复只跑已保存的产物，不重新规划，也不重编译。"}
          </p>
          {busy ? <p className="mt-2 text-sm text-muted">正在向服务器确认。按钮点下去还不是完成。</p> : null}

          <details className="mt-3">
            <summary className="min-h-11 text-sm text-muted">工具链、策略与源码</summary>
            <p className="break-all font-mono text-xs leading-5 text-muted">
              compiler {run.compiler_id ?? "—"}
              <br />
              runtime {run.runtime_id ?? "—"}
              <br />
              policy {run.policy_version ?? "—"}
              <br />
              source {run.source_hash ?? "—"}
              <br />
              compile {run.compile_count}
              <br />
              endpoint {run.fetch_url || "服务器配置的 /spec"}
            </p>
            {run.source ? <pre className="mt-3 max-h-48 overflow-auto rounded-lg bg-bg px-3 py-2 font-mono text-xs leading-5 text-fg">{run.source}</pre> : null}
          </details>
        </section>
      ) : null}

      {showRun && run && approval && run.store_state === "AwaitingApproval" ? (
        <section className="mx-4 mt-4 rounded-2xl border border-primary bg-surface p-3">
          <p className="font-mono text-xs tracking-widest text-muted">待审批 · 账本里的请求</p>
          <p className="mt-2 text-sm leading-6 text-muted">参数、序号和请求哈希都来自已保存的记录，不是页面重算的。</p>
          <pre className="mt-3 max-h-48 overflow-auto whitespace-pre-wrap rounded-lg bg-bg px-3 py-2 font-mono text-xs leading-5 text-fg">{approval.params}</pre>
          <p className="mt-2 break-all font-mono text-xs leading-5 text-muted">
            seq {approval.seq}
            <br />
            request {approval.request_hash}
          </p>
          {approval.recorded_decision ? (
            <div className="mt-3">
              <p className="text-sm text-fg">决定已提交。这还不是执行完成。</p>
              <pre className="mt-2 overflow-auto whitespace-pre-wrap rounded-lg bg-bg px-3 py-2 font-mono text-xs leading-5 text-fg">{approval.recorded_decision}</pre>
            </div>
          ) : (
            <>
              <label className="mt-3 flex flex-col gap-2 text-sm text-fg">
                拒绝理由
                <input
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                  placeholder="拒绝时必填"
                  className="min-h-11 rounded-lg border border-border bg-bg px-3 text-sm text-fg outline-none placeholder:text-muted focus:border-primary"
                />
              </label>
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={busy || !executionHash}
                  onClick={() =>
                    executionHash &&
                    void act(() =>
                      decideDurableApproval({
                        data: {
                          runId: run.run_id,
                          executionHash,
                          seq: approval.seq,
                          requestHash: approval.request_hash,
                          callbackId: callbackFor(run.run_id, approval.seq, approval.request_hash, "Approved"),
                          decision: { tag: "Approved" },
                        },
                      }),
                    )
                  }
                  className="inline-flex min-h-11 items-center rounded-lg bg-primary px-4 text-sm font-medium text-primary-fg disabled:opacity-40"
                >
                  批准
                </button>
                <button
                  type="button"
                  disabled={busy || !executionHash || reason.trim().length === 0}
                  onClick={() =>
                    executionHash &&
                    void act(() =>
                      decideDurableApproval({
                        data: {
                          runId: run.run_id,
                          executionHash,
                          seq: approval.seq,
                          requestHash: approval.request_hash,
                          callbackId: callbackFor(run.run_id, approval.seq, approval.request_hash, "Rejected"),
                          decision: { tag: "Rejected", reason: reason.trim() },
                        },
                      }),
                    )
                  }
                  className="inline-flex min-h-11 items-center rounded-lg border border-border px-4 text-sm text-fg disabled:opacity-40"
                >
                  拒绝
                </button>
              </div>
            </>
          )}
          <p className="mt-2 text-sm leading-6 text-muted">批准或拒绝只提交决定。之后要点「恢复执行」，这一步不会自动继续。</p>
        </section>
      ) : null}

      {!showRun && booting ? <p className="mx-4 mt-4 text-sm text-muted">正在读取已保存的 run。</p> : null}

      {stoppedNote ? <p className="mx-4 mt-4 rounded-xl border border-border bg-surface px-3 py-3 text-sm leading-6 text-fg">{stoppedNote}</p> : null}
      {linkNote ? <p className="mx-4 mt-4 text-sm leading-6 text-muted">{linkNote}</p> : null}
      {actionError ? (
        <div className="mx-4 mt-4 rounded-xl border border-danger bg-surface px-3 py-3">
          <p className="text-sm leading-6 text-danger">{actionError}</p>
          {advice ? <p className="mt-1 text-sm leading-6 text-muted">{advice}</p> : null}
        </div>
      ) : null}

      <section className="mx-4 mb-16 mt-4">
        <p className="font-mono text-xs tracking-widest text-muted">已保存的 run</p>
        <p className="mt-2 text-sm leading-6 text-muted">列表来自服务器。浏览器只记住你正在看哪一条。</p>
        {truncated ? <p className="mt-1 text-sm text-muted">这次列表被截断了，不以本地记录补全。</p> : null}
        <div className="mt-3 flex flex-col gap-2">
          {runs.length === 0 && !booting ? <p className="text-sm leading-6 text-muted">还没有耐久 run。</p> : null}
          {runs.map((item) => {
            const selected = !composing && item.run_id === run?.run_id;
            return (
              <button
                key={item.run_id}
                type="button"
                onClick={() => {
                  setWatching(true);
                  setStoppedNote("");
                  setComposing(false);
                  void act(() => getDurableRun({ data: { runId: item.run_id } }));
                }}
                className={`min-h-11 rounded-xl border px-3 py-2 text-left ${selected ? "border-primary bg-surface" : "border-border"}`}
              >
                <span className="block font-mono text-xs text-fg">
                  {shortId(item.run_id)} · {stateLabel(item)}
                </span>
                <span className="mt-1 block truncate text-sm text-muted">{firstLine(item.material) || item.phase}</span>
              </button>
            );
          })}
        </div>
      </section>
    </main>
  );
}
