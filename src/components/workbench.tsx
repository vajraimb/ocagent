import { useEffect, useRef, useState } from "react";
import { sweAgent } from "@/lib/harness/agent";
import { runProofs, type Proof } from "@/lib/harness/proofs";
import { describeError, stackNames, startSession, type Session } from "@/lib/harness/runtime";
import { PROFILE_COPY, SCENARIOS, scenarioById, type ScenarioId } from "@/lib/harness/scenarios";
import type {
  CrashWindow,
  Decision,
  JournalEntry,
  LlmMode,
  ProfileName,
  RunResult,
} from "@/lib/harness/types";
import { BUGGY_ADD, exportWorld, fileIsAdd, importWorld, MATH_PATH, type SavedWorld } from "@/lib/harness/world";

type Tab = "run" | "ledger" | "proofs" | "protocol";

type Saved = {
  profile: ProfileName;
  scenario: ScenarioId;
  journal: RunResult["journal"];
  world: SavedWorld;
  prompt: string;
  llmMode: LlmMode;
  budgetMax?: number;
  compactThreshold?: number;
};

type CrashReport = {
  atSeq: number;
  window: CrashWindow;
  crashed: RunResult;
  recovered: RunResult;
};

const STORAGE_KEY = "ocagent-suspend-v1";
const WINDOWS: { id: CrashWindow; label: string }[] = [
  { id: "after-pending", label: "写入 Pending 后" },
  { id: "before-done", label: "执行后、Done 前" },
  { id: "after-done", label: "Done 之后" },
];

export function Workbench() {
  const [tab, setTab] = useState<Tab>("run");
  const [profile, setProfile] = useState<ProfileName>("dev");
  const [scenarioId, setScenarioId] = useState<ScenarioId>("fix");
  const [result, setResult] = useState<RunResult | null>(null);
  const [live, setLive] = useState(false);
  const [selected, setSelected] = useState(0);
  const [proofs, setProofs] = useState<Proof[] | null>(null);
  const [windowId, setWindowId] = useState<CrashWindow>("before-done");
  const [crash, setCrash] = useState<CrashReport | null>(null);
  const [restored, setRestored] = useState(false);
  const [ready, setReady] = useState(false);
  const sessionRef = useRef<Session | null>(null);
  const scenario = scenarioById(scenarioId);

  useEffect(() => {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      try {
        const saved = JSON.parse(raw) as Saved;
        setProfile(saved.profile);
        setScenarioId(saved.scenario);
        setResult(resultFromSaved(saved));
        setRestored(true);
        setLive(false);
      } catch {
        localStorage.removeItem(STORAGE_KEY);
      }
    }
    setReady(true);
  }, []);

  useEffect(() => {
    if (!ready) return;
    if (result?.status !== "suspended") {
      localStorage.removeItem(STORAGE_KEY);
      return;
    }
    const saved: Saved = {
      profile,
      scenario: scenarioId,
      journal: result.journal,
      world: exportWorld(result.world),
      prompt: scenario.prompt,
      llmMode: scenario.llmMode,
      budgetMax: scenario.budgetMax,
      compactThreshold: scenario.compactThreshold,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(saved));
  }, [ready, result, profile, scenarioId, scenario]);

  useEffect(() => {
    if (tab === "proofs" && !proofs) setProofs(runProofs());
  }, [tab, proofs]);

  function show(next: RunResult, session: Session | null) {
    sessionRef.current = session;
    setLive(session?.result.continuation === "held");
    setResult(next);
    setSelected(Math.max(0, next.journal.entries.length - 1));
    setRestored(session === null && next.status === "suspended");
  }

  function run() {
    const session = startSession(runOptions(profile, scenario));
    setCrash(null);
    show(session.result, session.result.status === "suspended" ? session : null);
  }

  function decide(decision: Decision, mode: "fast" | "replay") {
    if (!result || result.suspendSeq === undefined) return;
    if (mode === "fast" && sessionRef.current && live) {
      const next = sessionRef.current.resumeFast(decision);
      setCrash(null);
      show(next.result, next.result.status === "suspended" ? next : null);
      return;
    }
    const current = sessionRef.current;
    const exited = current ? current.exitProcess().result : result;
    const entry = exited.journal.entries[exited.suspendSeq ?? result.suspendSeq];
    if (entry) {
      entry.status = "Done";
      entry.result = decision as JournalEntry["result"];
    }
    const next = startSession({
      ...runOptions(profile, scenario),
      journal: exited.journal,
      world: exited.world,
    });
    setCrash(null);
    show(next.result, next.result.status === "suspended" ? next : null);
  }

  function killAtSelected() {
    const atSeq = result?.journal.entries[selected]?.seq ?? selected;
    const crashed = startSession({
      ...runOptions(profile, scenario),
      crash: { atSeq, window: windowId },
    }).result;
    const recovered = startSession({
      ...runOptions(profile, scenario),
      journal: crashed.journal,
      world: crashed.world,
    }).result;
    setCrash({ atSeq, window: windowId, crashed, recovered });
  }

  const file = result?.world.files[MATH_PATH] ?? BUGGY_ADD;
  const entry = result?.journal.entries[selected];
  const passed = proofs?.filter((proof) => proof.pass).length ?? 0;

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-3xl flex-col gap-6 px-4 py-6 sm:px-6">
      <header className="flex flex-col gap-3">
        <p className="font-mono text-xs tracking-widest text-primary">EFFECT HARNESS · v0.1</p>
        <h1 className="text-3xl font-semibold tracking-tight text-fg">同一份 agent，三种环境</h1>
        <p className="max-w-xl text-sm leading-6 text-muted">
          Agent 只 <span className="font-mono text-fg">perform</span>。Dev、Eval、Prod
          是不同的 handler 栈。进程死掉以后不保存 continuation，把 effect 的结果重放回去。
        </p>
      </header>

      <nav className="grid grid-cols-4 gap-2" aria-label="视图">
        <TabButton id="run" tab={tab} setTab={setTab} label="运行" />
        <TabButton id="ledger" tab={tab} setTab={setTab} label="账本" />
        <TabButton id="proofs" tab={tab} setTab={setTab} label={proofs ? `验收 ${passed}/${proofs.length}` : "验收"} />
        <TabButton id="protocol" tab={tab} setTab={setTab} label="协议" />
      </nav>

      {tab === "run" ? (
        <div className="flex flex-col gap-5">
          {restored ? (
            <p className="rounded-md border border-primary bg-surface px-3 py-3 text-sm leading-6 text-fg">
              上次的审批还挂在日志里。刷新等于进程已经没了，只能重放，不能继续那条内存里的 continuation。
            </p>
          ) : null}

          <fieldset className="flex flex-col gap-2">
            <legend className="font-mono text-xs tracking-widest text-muted">环境</legend>
            <div className="flex flex-wrap gap-2">
              {(Object.keys(PROFILE_COPY) as ProfileName[]).map((name) => (
                <Chip key={name} on={profile === name} onClick={() => setProfile(name)}>
                  {PROFILE_COPY[name].title}
                </Chip>
              ))}
            </div>
            <p className="text-sm text-muted">{PROFILE_COPY[profile].detail}</p>
          </fieldset>

          <fieldset className="flex flex-col gap-2">
            <legend className="font-mono text-xs tracking-widest text-muted">任务</legend>
            <div className="flex flex-wrap gap-2">
              {SCENARIOS.map((item) => (
                <Chip key={item.id} on={scenarioId === item.id} onClick={() => setScenarioId(item.id)}>
                  {item.title}
                </Chip>
              ))}
            </div>
            <p className="text-sm text-muted">{scenario.detail}</p>
          </fieldset>

          <button
            type="button"
            onClick={run}
            className="min-h-11 rounded-md bg-primary px-4 text-sm font-medium text-primary-fg"
          >
            运行到断点
          </button>

          <Stack names={result?.stack ?? stackNames(profile, scenario.compactThreshold ? { compact: true, compactThreshold: scenario.compactThreshold } : undefined)} active={entry?.path ?? []} />

          {result ? <ResultCard result={result} profile={profile} scenarioId={scenarioId} /> : null}

          {result?.status === "suspended" && result.approval ? (
            <section className="flex flex-col gap-3 rounded-md border border-danger bg-surface p-3">
              <h2 className="text-base font-medium text-fg">需要人点头</h2>
              <p className="font-mono text-sm text-fg">
                {result.approval.action} · {result.approval.risk}
              </p>
              <p className="text-sm leading-6 text-muted">
                {live
                  ? "进程还在。快路径直接 continue；重放会先释放资源，再从头跑到这条日志。"
                  : "continuation 已经不在了。批准或拒绝都会写进日志，然后整段重放。"}
              </p>
              <div className="grid gap-2 sm:grid-cols-3">
                <button type="button" className="min-h-11 rounded-md border border-border bg-raised px-3 text-sm text-fg" onClick={() => decide({ tag: "Rejected", reason: "先不要发布" }, "replay")}>
                  拒绝并重放
                </button>
                <button type="button" className="min-h-11 rounded-md bg-primary px-3 text-sm font-medium text-primary-fg" onClick={() => decide({ tag: "Approved" }, "replay")}>
                  批准并重放
                </button>
                <button
                  type="button"
                  disabled={!live}
                  className="min-h-11 rounded-md border border-border bg-surface px-3 text-sm text-fg disabled:opacity-40"
                  onClick={() => decide({ tag: "Approved" }, "fast")}
                >
                  进程内继续
                </button>
              </div>
            </section>
          ) : null}

          <section className="rounded-md border border-border bg-surface">
            <div className="flex items-baseline justify-between gap-3 border-b border-border px-3 py-3">
              <h2 className="font-mono text-sm text-fg">{MATH_PATH}</h2>
              <p className="text-xs text-muted">{fileIsAdd(file) ? "已是加法" : "仍是减法"}</p>
            </div>
            <pre className="overflow-x-auto px-3 py-3 font-mono text-sm leading-6 text-fg">{file}</pre>
          </section>

          <Ledger result={result} selected={selected} onSelect={setSelected} />

          {entry ? <EntryDetail entry={entry} /> : null}

          <details className="rounded-md border border-border bg-surface">
            <summary className="min-h-11 px-3 py-3 text-sm text-fg">在某一条杀掉进程</summary>
            <div className="flex flex-col gap-3 border-t border-border px-3 py-3">
              <p className="text-sm leading-6 text-muted">
                当前选中 seq {entry?.seq ?? 0}。杀掉不会跑 Fun.protect。恢复时用同一份日志和幂等键，副作用不重复。
              </p>
              <div className="flex flex-wrap gap-2">
                {WINDOWS.map((item) => (
                  <Chip key={item.id} on={windowId === item.id} onClick={() => setWindowId(item.id)}>
                    {item.label}
                  </Chip>
                ))}
              </div>
              <button type="button" onClick={killAtSelected} className="min-h-11 rounded-md bg-danger px-3 text-sm font-medium text-danger-fg">
                杀掉并重放
              </button>
              {crash ? <CrashCard crash={crash} /> : null}
            </div>
          </details>
        </div>
      ) : null}

      {tab === "ledger" ? <LedgerDump result={result} /> : null}
      {tab === "proofs" ? <ProofList proofs={proofs} /> : null}
      {tab === "protocol" ? <Protocol /> : null}
    </main>
  );
}

function runOptions(profile: ProfileName, scenario: ReturnType<typeof scenarioById>) {
  return {
    profile,
    prompt: scenario.prompt,
    llmMode: scenario.llmMode,
    budgetMax: scenario.budgetMax,
    compactThreshold: scenario.compactThreshold,
    compact: scenario.id === "compact" ? true : undefined,
    agent: sweAgent,
    runId: `${profile}:${scenario.id}`,
  };
}

function resultFromSaved(saved: Saved): RunResult {
  const pending = saved.journal.entries.find((entry) => entry.kind === "AskHuman" && entry.status === "Pending");
  const req = pending?.req as { action?: string; risk?: "Low" | "High"; payload?: Record<string, string> } | undefined;
  return {
    status: "suspended",
    journal: saved.journal,
    world: importWorld(saved.world),
    trace: [],
    protectReleased: false,
    continuation: "discontinued",
    profile: saved.profile,
    llmUsed: 0,
    suspendSeq: pending?.seq,
    approval: req?.action
      ? { action: req.action, risk: req.risk ?? "High", payload: req.payload ?? {} }
      : undefined,
    stack: stackNames(saved.profile),
  };
}

function TabButton({ id, tab, setTab, label }: { id: Tab; tab: Tab; setTab: (tab: Tab) => void; label: string }) {
  const on = tab === id;
  return (
    <button
      type="button"
      aria-selected={on}
      onClick={() => setTab(id)}
      className={`min-h-11 rounded-md border px-2 text-sm ${on ? "border-primary bg-primary text-primary-fg" : "border-border bg-surface text-fg"}`}
    >
      {label}
    </button>
  );
}

function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: string }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={`min-h-11 rounded-md border px-3 text-sm ${on ? "border-primary bg-primary text-primary-fg" : "border-border bg-surface text-fg"}`}
    >
      {children}
    </button>
  );
}

function Stack({ names, active }: { names: string[]; active: string[] }) {
  const seen = new Set(active);
  return (
    <div className="flex flex-col gap-2">
      <p className="font-mono text-xs tracking-widest text-muted">栈 · 内到外</p>
      <ol className="flex gap-2 overflow-x-auto pb-1">
        {names.map((name) => (
          <li
            key={name}
            className={`shrink-0 rounded-md border px-2 py-2 font-mono text-xs ${seen.has(name) ? "border-primary text-primary" : "border-border text-muted"}`}
          >
            {name}
          </li>
        ))}
      </ol>
    </div>
  );
}

function ResultCard({ result, profile, scenarioId }: { result: RunResult; profile: ProfileName; scenarioId: ScenarioId }) {
  const headline =
    result.status === "done"
      ? result.value?.ok
        ? "跑完了"
        : "跑完了，但校验没过"
      : result.status === "suspended"
        ? "停在审批"
        : result.status === "crashed"
          ? "进程被杀掉了"
          : "停在错误";
  const evalShell = scenarioId === "publish" && profile === "eval" && result.status === "done";
  return (
    <section className="flex flex-col gap-2 rounded-md border border-border bg-raised px-3 py-3">
      <h2 className="text-base font-medium text-fg">{headline}</h2>
      {result.error ? <p className="text-sm text-danger">{describeError(result.error)}</p> : null}
      {result.value ? (
        <p className="font-mono text-xs leading-5 text-muted">
          ok={String(result.value.ok)} · attempts={result.value.attempts} · stamp={result.value.stamp} · published={result.value.published}
          {result.value.diagnostics.length ? ` · ${result.value.diagnostics.join(" ")}` : ""}
        </p>
      ) : null}
      <p className="font-mono text-xs text-muted">
        llm {result.llmUsed} · protect {result.protectReleased ? "released" : "held"} · continuation {result.continuation}
      </p>
      {evalShell ? <p className="text-sm leading-6 text-muted">Eval 没有 policy，shell 直接执行。换到 Dev 或 Prod 会停下来等你。</p> : null}
    </section>
  );
}

function Ledger({
  result,
  selected,
  onSelect,
}: {
  result: RunResult | null;
  selected: number;
  onSelect: (index: number) => void;
}) {
  const entries = result?.journal.entries ?? [];
  return (
    <section className="overflow-hidden rounded-md border border-border bg-surface">
      <div className="border-b border-border px-3 py-3">
        <h2 className="text-sm font-medium text-fg">效应日志</h2>
      </div>
      {entries.length === 0 ? (
        <p className="px-3 py-4 text-sm text-muted">还没有记录。运行之后，每一条 effect 会按顺序落在这里。</p>
      ) : (
        <ol>
          {entries.map((item, index) => (
            <li key={`${item.seq}-${item.reqHash}`}>
              <button
                type="button"
                onClick={() => onSelect(index)}
                aria-pressed={selected === index}
                className={`flex min-h-11 w-full items-baseline gap-3 border-b border-border px-3 py-3 text-left last:border-b-0 ${selected === index ? "bg-raised" : "bg-surface"}`}
              >
                <span className="w-8 shrink-0 font-mono text-sm text-primary tabular-nums">{String(item.seq).padStart(2, "0")}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-fg">{item.label}</span>
                  <span className="block font-mono text-xs text-muted">{item.status}</span>
                </span>
                <Hit hit={item.lastHit} />
              </button>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function Hit({ hit }: { hit: JournalEntry["lastHit"] }) {
  const className = hit === "replay" ? "text-primary" : hit === "suspend" ? "text-danger" : "text-muted";
  const label = hit === "replay" ? "重放" : hit === "suspend" ? "挂起" : "执行";
  return <span className={`shrink-0 font-mono text-xs ${className}`}>{label}</span>;
}

function EntryDetail({ entry }: { entry: JournalEntry }) {
  return (
    <section className="flex flex-col gap-2 rounded-md border border-border bg-surface px-3 py-3">
      <h2 className="font-mono text-sm text-fg">{entry.label}</h2>
      <p className="font-mono text-xs leading-5 text-muted">
        hash {entry.reqHash} · key {entry.idempotencyKey}
      </p>
      <p className="text-sm text-muted">经过 {entry.path.join(" → ") || "—"}</p>
      <pre className="overflow-x-auto font-mono text-xs leading-5 text-fg">{JSON.stringify(entry.result, null, 2)}</pre>
    </section>
  );
}

function CrashCard({ crash }: { crash: CrashReport }) {
  const sameFile = JSON.stringify(crash.recovered.world.files) === JSON.stringify(crash.crashed.world.files) || crash.recovered.status === "done";
  const dups = crash.recovered.world.log.filter((item) => item.duplicate).length;
  const writes = crash.recovered.world.log.filter((item) => !item.duplicate && item.name === "apply_patch").length;
  return (
    <div className="flex flex-col gap-2 rounded-md border border-border bg-bg px-3 py-3">
      <p className="text-sm text-fg">
        seq {crash.atSeq} · {crash.window}
      </p>
      <p className="text-sm leading-6 text-muted">
        崩溃时 protect {crash.crashed.protectReleased ? "已释放" : "没跑到"}。恢复状态 {crash.recovered.status}
        {crash.recovered.error ? `，${describeError(crash.recovered.error)}` : ""}。apply_patch 实际写入 {writes} 次，幂等键挡住 {dups} 次。
        {sameFile && crash.recovered.status === "done" ? " 文件和恢复后的账本已对齐。" : ""}
      </p>
    </div>
  );
}

function LedgerDump({ result }: { result: RunResult | null }) {
  if (!result) return <p className="text-sm text-muted">先跑一次，账本才会有内容。</p>;
  const lines = result.journal.entries.map((entry) =>
    JSON.stringify({
      run_id: entry.runId,
      seq: entry.seq,
      kind: entry.kind,
      req_hash: entry.reqHash,
      status: entry.status,
      result: entry.result,
      ts: entry.ts,
    }),
  );
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-base font-medium text-fg">JSONL</h2>
      <p className="text-sm leading-6 text-muted">
        run {result.journal.runId} · {result.journal.agentVersion}。哈希对不上就抛 Nondeterminism，不会把旧结果套到新请求上。
      </p>
      <pre className="overflow-x-auto rounded-md border border-border bg-surface p-3 font-mono text-xs leading-5 text-fg">{lines.join("\n")}</pre>
    </section>
  );
}

function ProofList({ proofs }: { proofs: Proof[] | null }) {
  if (!proofs) return <p className="text-sm text-muted">正在跑验收。</p>;
  return (
    <ol className="flex flex-col gap-3">
      {proofs.map((proof) => (
        <li key={proof.id} className="rounded-md border border-border bg-surface px-3 py-3">
          <p className="font-mono text-xs text-primary">{proof.milestone}</p>
          <h2 className="mt-1 text-base font-medium text-fg">{proof.title}</h2>
          <p className={`mt-2 text-sm leading-6 ${proof.pass ? "text-muted" : "text-danger"}`}>{proof.detail}</p>
        </li>
      ))}
    </ol>
  );
}

function Protocol() {
  const rows = [
    ["trace", "记下 span。重放回来的调用标 replayed，不重复上报。"],
    ["verify", "只拦写入。lint 的结果写进 diagnostics，不改 output。"],
    ["budget", "数 Llm。放在 journal 里面，重放时计数会自己长回来。"],
    ["policy", "高风险改写成 Ask_human。拒绝就不执行。"],
    ["compact", "超阈值先 perform 一次摘要 Llm，摘要自己也进日志。"],
    ["journal", "有记录就核对哈希并返回；没有就先 Pending，再执行，再 Done。"],
    ["world", "唯一碰外部的一层。幂等键相同就不再做第二次。"],
    ["strict", "没人接的 effect 变成 Harness_error，而不是裸的 Unhandled。"],
  ];
  return (
    <div className="flex flex-col gap-5">
      <section className="flex flex-col gap-2">
        <h2 className="text-base font-medium text-fg">先改掉的四件事</h2>
        <ul className="flex flex-col gap-2 text-sm leading-6 text-muted">
          <li>原生 continuation 不能带走。它是一次性的，也序列化不了运行时栈。跨重启只重放日志。</li>
          <li>编译器不检查 effect 有没有 handler。每个 profile 靠验收覆盖，最外层用 strict 兜底。</li>
          <li>子 fiber 不一定继承你的 handler。裸 fork 会 Unhandled；spawn 必须在子 fiber 里重新装栈。</li>
          <li>校验失败不能悄悄改模型看到的内容。只附加诊断，重试有上限。</li>
        </ul>
      </section>
      <section className="overflow-x-auto rounded-md border border-border">
        <table className="w-full text-left text-sm">
          <tbody>
            {rows.map(([name, job]) => (
              <tr key={name} className="border-b border-border last:border-b-0">
                <th className="w-24 px-3 py-3 font-mono text-xs font-medium text-primary">{name}</th>
                <td className="px-3 py-3 text-muted">{job}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <pre className="overflow-x-auto rounded-md border border-border bg-surface p-3 font-mono text-xs leading-5 text-fg">{`type _ Effect.t +=
  | Llm        : Llm.request -> Llm.response Effect.t
  | Tool       : tool_call -> tool_result Effect.t
  | Ask_human  : approval -> decision Effect.t
  | Checkpoint : string -> unit Effect.t
  | Now        : float Effect.t
  | Fresh_id   : string Effect.t

(* 日志里已有：核对 req_hash，continue recorded
   没有：写 Pending，执行，写 Done
   Ask_human：写 Pending，discontinue，进程可以退出 *)`}</pre>
      <p className="text-sm leading-6 text-muted">初始文件是减法：{BUGGY_ADD.trim()}。Eval 不装 policy 和 compact，所以同一 fixture 的日志可以逐字节对比。</p>
    </div>
  );
}
