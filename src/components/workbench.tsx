import { useEffect, useRef, useState } from "react";
import { runDesk } from "@/lib/agent/run";
import { decideDurableApproval, getDurableRun, resumeDurableRun } from "@/lib/agent/durable-api";
import { callbackFor, type DurableProjection } from "@/lib/agent/durable-types";

import { CATALOG, DEFAULT_HARNESSES, checkModule, isHarnessId, type DeskModule, type HarnessId } from "@/lib/agent/harness";
import { type DeskFile, type JournalItem, type ToolStep } from "@/lib/agent/workspace";

type Turn = {
  role: "user" | "agent";
  text: string;
  code?: string;
  steps?: ToolStep[];
  runId?: string;
  run?: DurableProjection;
};

type Saved = {
  task: string;
  files: DeskFile[];
  answer: string;
  steps: ToolStep[];
  harnesses: HarnessId[];
  modules: DeskModule[];
  journal: JournalItem[];
  memory: string;
  turns?: Turn[];
};

const STORAGE_KEY = "ocagent-desk-v6";
const RUN_KEY = "ocagent-durable-run";
const PREFAB = new Set(["README.md", "src/math.ml", "src/greet.ml", "notes/todo.md"]);
const SWITCHES = CATALOG.filter((item) => item.id !== "ocaml");

function keepFile(file: DeskFile): boolean {
  const name = file.path.split("/").pop() ?? "";
  return !PREFAB.has(file.path) && !name.startsWith("ocagent_");
}

function lastCode(journal: JournalItem[]): string {
  for (let i = journal.length - 1; i >= 0; i -= 1) {
    if (journal[i]?.kind === "code" && journal[i]?.text) return journal[i].text;
  }
  return "";
}

export function Workbench() {
  const [task, setTask] = useState("");
  const [harnesses, setHarnesses] = useState<HarnessId[]>(DEFAULT_HARNESSES);
  const [modules, setModules] = useState<DeskModule[]>([]);
  const [journal, setJournal] = useState<JournalItem[]>([]);
  const [memory, setMemory] = useState("");
  const [files, setFiles] = useState<DeskFile[]>([]);
  const [selected, setSelected] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [error, setError] = useState("");
  const [running, setRunning] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [ready, setReady] = useState(false);
  const [settings, setSettings] = useState(false);
  const [filesOpen, setFilesOpen] = useState(false);
  const [keyboardTop, setKeyboardTop] = useState(0);
  const [watching, setWatching] = useState(true);
  const [reason, setReason] = useState("");
  const runId = useRef(0);

  useEffect(() => {
    if (!running) return;
    const started = Date.now();
    setSeconds(0);
    const tick = window.setInterval(() => setSeconds(Math.floor((Date.now() - started) / 1000)), 400);
    return () => window.clearInterval(tick);
  }, [running]);

  useEffect(() => {
    const raw = localStorage.getItem(STORAGE_KEY) ?? localStorage.getItem("ocagent-desk-v5");
    if (raw) {
      try {
        const saved = JSON.parse(raw) as Saved;
        if (typeof saved.task === "string") setTask("");
        const nextFiles = Array.isArray(saved.files) ? saved.files.filter(keepFile) : [];
        setFiles(nextFiles);
        setSelected(nextFiles[0]?.path ?? "");
        if (Array.isArray(saved.harnesses)) {
          const ids = (saved.harnesses as string[]).map((id) => (id === "search" ? "web" : id)).filter(isHarnessId);
          if (ids.length) setHarnesses(ids);
        }
        if (Array.isArray(saved.modules)) {
          setModules(
            saved.modules.flatMap((mod) => {
              if (!mod || typeof mod.name !== "string" || typeof mod.body !== "string") return [];
              const checked = checkModule(mod.name, mod.body);
              return checked ? [checked] : [];
            }),
          );
        }
        if (Array.isArray(saved.journal)) setJournal(saved.journal);
        if (typeof saved.memory === "string") setMemory(saved.memory);
        if (Array.isArray(saved.turns) && saved.turns.length) setTurns(saved.turns);
        else if (saved.task && saved.answer) setTurns([{ role: "user", text: saved.task }, { role: "agent", text: saved.answer, steps: saved.steps ?? [] }]);
      } catch {
        localStorage.removeItem(STORAGE_KEY);
      }
    }
    setReady(true);
  }, []);

  useEffect(() => {
    if (!ready) return;
    const saved: Saved = { task, files, answer: "", steps: [], harnesses, modules, journal, memory, turns };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(saved));
  }, [ready, task, files, harnesses, modules, journal, memory, turns]);

  const live = [...turns].reverse().find((turn) => turn.runId && turn.run && turn.run.store_state !== "Completed" && turn.run.store_state !== "Failed");

  useEffect(() => {
    if (!watching || !live?.runId) return;
    const id = live.runId;
    const timer = window.setInterval(() => {
      void getDurableRun({ data: { runId: id } })
        .then((result) => {
          if (result.projection) applyRun(result.projection);
        })
        .catch(() => setError("这次没有读回来。没有把它改成失败。"));
    }, 4000);
    return () => window.clearInterval(timer);
  }, [watching, live?.runId, live?.run?.store_state]);

  function applyRun(run: DurableProjection, override?: string) {
    if (run.source) {
      setFiles((current) => [{ path: "step.ml", content: run.source }, ...current.filter((file) => file.path !== "step.ml")]);
      setSelected((current) => current || "step.ml");
    }
    localStorage.setItem(RUN_KEY, run.run_id);
    setTurns((current) => {
      let index = -1;
      for (let at = current.length - 1; at >= 0; at -= 1) {
        if (current[at]?.runId === run.run_id) {
          index = at;
          break;
        }
      }
      const text = override || speak(run);
      if (index < 0) return [...current, { role: "agent", text, code: run.source, runId: run.run_id, run }];
      return current.map((turn, at) => (at === index ? { ...turn, text, code: run.source || turn.code, run } : turn));
    });
  }

  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const pin = () => setKeyboardTop(viewport.offsetTop);
    pin();
    viewport.addEventListener("resize", pin);
    viewport.addEventListener("scroll", pin);
    return () => {
      viewport.removeEventListener("resize", pin);
      viewport.removeEventListener("scroll", pin);
    };
  }, []);

  async function go(text: string) {
    if (!text || running) return;
    const id = ++runId.current;
    setTurns((current) => [...current, { role: "user", text }]);
    setTask("");
    setRunning(true);
    setWatching(true);
    setError("");
    const nextJournal = journal;
    const watch = window.setTimeout(() => {
      if (runId.current !== id) return;
      setRunning(false);
      setTurns((current) => [...current, { role: "agent", text: "太久没有回来。再发一次。若刚才那次稍后做完，结果会补在后面。" }]);
    }, 300_000);
    try {
      const result = await runDesk({ data: { task: text, files, harnesses, modules, journal: nextJournal, memory } });
      if (runId.current !== id) return;
      const nextFiles = result.files.filter(keepFile);
      setFiles(nextFiles);
      if (result.journal) setJournal(result.journal);
      if (typeof result.memory === "string") setMemory(result.memory);
      if (result.modules) setModules(result.modules);
      const touched = [...result.steps].reverse().find((step) => nextFiles.some((item) => item.path === step.detail));
      if (touched) setSelected(touched.detail);
      else if (!nextFiles.some((item) => item.path === selected)) setSelected(nextFiles[0]?.path ?? "");
      const spoken = result.ok ? result.answer : result.error;
      const added = (result.journal ?? []).slice(nextJournal.length);
      setTurns((current) => [...current, { role: "agent", text: spoken, code: lastCode(added), steps: result.steps }]);
    } catch (caught) {
      if (runId.current !== id) return;
      const message = caught instanceof Error ? caught.message : "没跑成";
      setError(message);
      setTurns((current) => [...current, { role: "agent", text: message }]);
    } finally {
      window.clearTimeout(watch);
      if (runId.current === id) setRunning(false);
    }
  }

  async function actOn(run: DurableProjection, work: () => Promise<{ projection: DurableProjection | null; error: { message: string } | null }>) {
    setRunning(true);
    setError("");
    try {
      const result = await work();
      if (result.projection) applyRun(result.projection, result.error?.message);
      else if (result.error) setError(result.error.message);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "没有完成");
    } finally {
      setRunning(false);
    }
  }

  function stop() {
    runId.current += 1;
    setRunning(false);
    setWatching(false);
    setTurns((current) => [...current, { role: "agent", text: "已停下查看。这一步没有被取消。" }]);
    setError("");
  }

  function reset() {
    setFiles([]);
    setSelected("");
    setTurns([]);
    setError("");
    setJournal([]);
    setMemory("");
    setModules([]);
    setTask("");
  }

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-2xl flex-col">
      <header className="px-4 pb-2 pt-3">
        <p className="font-mono text-xs tracking-widest text-muted">OCAGENT</p>
        <h1 className="mt-1 text-lg font-semibold text-fg">用 OCaml 行动的 agent</h1>
      </header>

      <div className="sticky z-20 border-b border-border bg-bg px-4 py-3" style={{ top: keyboardTop }}>
        <label className="flex flex-col gap-2">
          <span className="sr-only">对它说</span>
          <textarea
            value={task}
            onChange={(event) => setTask(event.target.value)}
            rows={4}
            placeholder="说一件要做完的事"
            className="w-full resize-y select-text rounded-xl border border-border bg-surface px-3 py-3 text-sm leading-6 text-fg outline-none placeholder:text-muted focus:border-primary"
          />
        </label>
        <div className="mt-2 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => (running ? stop() : void go(task.trim()))}
            disabled={!running && task.trim().length === 0}
            className="inline-flex min-h-11 items-center justify-center rounded-lg bg-primary px-4 text-sm font-medium text-primary-fg disabled:opacity-40"
          >
            {running ? `停下 · ${seconds} 秒` : "发送"}
          </button>
          <button type="button" onClick={() => { setSettings((open) => !open); setFilesOpen(false); }} className="min-h-11 rounded-lg border border-border px-3 text-sm text-fg">
            {settings ? "收起 harness" : `Harness${modules.length ? ` · ${modules.length}` : ""}`}
          </button>
          <button type="button" onClick={() => { setFilesOpen((open) => !open); setSettings(false); }} className="min-h-11 rounded-lg border border-border px-3 text-sm text-fg">
            {filesOpen ? "收起工作区" : `工作区${files.length ? ` · ${files.length}` : ""}`}
          </button>
          <button type="button" onClick={reset} className="min-h-11 rounded-lg border border-border px-3 text-sm text-muted">
            清空
          </button>
        </div>
      </div>

      <div className="flex flex-1 flex-col gap-4 px-4 py-4 pb-16">
        {turns.length === 0 && !running ? (
          <p className="rounded-2xl border border-border bg-surface px-4 py-4 text-sm leading-6 text-muted">
            直接说要做什么。搜索、文件和程序都从这里开始。
          </p>
        ) : null}
        {running ? <p className="text-sm text-muted">正在做 · {seconds} 秒</p> : null}
        {settings ? <HarnessPanel harnesses={harnesses} setHarnesses={setHarnesses} modules={modules} setModules={setModules} /> : null}
        {filesOpen ? <WorkspacePanel files={files} selected={selected} onSelect={setSelected} /> : null}

        {[...turns.entries()].reverse().map(([index, turn]) => (
          <article key={`${turn.role}-${index}`} className={`select-text ${turn.role === "user" ? "ml-8 rounded-2xl bg-raised px-4 py-3" : "mr-6 rounded-2xl border border-border bg-surface px-4 py-3"}`}>
            <p className="font-mono text-xs tracking-widest text-muted">{turn.role === "user" ? "你" : "OCAGENT"}</p>
            <p className="mt-1 whitespace-pre-wrap text-sm leading-6 text-fg">{turn.text.replaceAll("**", "").replaceAll("`", "")}</p>
            {turn.run ? <RunActions run={turn.run} busy={running} reason={reason} setReason={setReason} onAct={actOn} /> : null}
            {turn.steps?.length ? (
              <ul className="mt-3 flex flex-col gap-2">
                {[...turn.steps].reverse().map((step, stepIndex) => (
                  <li key={`${step.tool}-${step.detail}-${stepIndex}`} className="min-w-0">
                    <p className="font-mono text-xs text-fg">
                      {toolLabel(step.tool)}
                      {step.detail ? <span className="text-muted"> {step.detail}</span> : null}
                    </p>
                    {step.output ? <p className="line-clamp-2 font-mono text-xs leading-5 text-muted">{step.output}</p> : null}
                  </li>
                ))}
              </ul>
            ) : null}
            {turn.code ? (
              <pre className="mt-3 max-h-36 overflow-auto rounded-lg bg-bg px-3 py-2 font-mono text-xs leading-5 text-fg">{turn.code}</pre>
            ) : null}
          </article>
        ))}

        {error ? <p className="text-sm text-danger">{error}</p> : null}
      </div>
    </main>
  );
}

function speak(run: DurableProjection): string {
  if (!run.store_state && run.error?.message) return "没写成。网络返回的是记录，要读 body，不能整段拼成文字。查天气或新闻，再发一次就会走搜索。";
  if (run.store_state === "Completed") return run.reply?.text || "做完了。";
  if (run.store_state === "Failed") return run.reply?.text || run.error?.message || "这一步失败了。";
  if (run.store_state === "BlockedUnknown" || run.error?.code === "Unknown_result") return "结果未知，不会自动再请求。";
  if (run.store_state === "AwaitingApproval" && run.pending_approval?.recorded_decision) return "决定已经记下。点继续才会往下走。";
  if (run.store_state === "AwaitingApproval") return "要发出请求之前，先等你批准。";
  if (run.store_state === "Prepared") return "写好了。点开始才会跑。";
  if (run.store_state === "Running") return "还在跑。这不是又开始一次。";
  if (run.phase === "generation") return "已经问过 Grok，结果还不知道。不要重发同一句。";
  if (run.error?.message) return run.error.message;
  if (run.notice) return run.notice;
  return "还没有写成可运行的一步。";
}

function RunActions({
  run,
  busy,
  reason,
  setReason,
  onAct,
}: {
  run: DurableProjection;
  busy: boolean;
  reason: string;
  setReason: (value: string) => void;
  onAct: (run: DurableProjection, work: () => Promise<{ projection: DurableProjection | null; error: { message: string } | null }>) => Promise<void>;
}) {
  const approval = run.pending_approval;
  const executionHash = run.execution_hash;
  const finished = run.store_state === "Completed" || run.store_state === "Failed" || run.store_state === "BlockedUnknown";
  const unknown = run.error?.code === "Unknown_result";
  if (finished || unknown || !executionHash) return null;
  const decided = Boolean(approval?.recorded_decision);
  if (run.store_state === "Prepared" || (run.store_state === "AwaitingApproval" && decided)) {
    return (
      <button
        type="button"
        disabled={busy}
        onClick={() => void onAct(run, () => resumeDurableRun({ data: { runId: run.run_id, executionHash } }))}
        className="mt-3 inline-flex min-h-11 items-center rounded-lg bg-primary px-4 text-sm font-medium text-primary-fg disabled:opacity-40"
      >
        {decided ? "继续" : "开始"}
      </button>
    );
  }
  if (run.store_state !== "AwaitingApproval" || !approval) return null;
  return (
    <div className="mt-3">
      <label className="flex flex-col gap-2 text-sm text-fg">
        拒绝理由
        <input
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          placeholder="拒绝时要写理由"
          className="min-h-11 rounded-lg border border-border bg-bg px-3 text-sm text-fg outline-none placeholder:text-muted focus:border-primary"
        />
      </label>
      <div className="mt-2 flex flex-wrap gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            void onAct(run, () =>
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
          disabled={busy || reason.trim().length === 0}
          onClick={() =>
            void onAct(run, () =>
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
    </div>
  );
}

function WorkspacePanel({ files, selected, onSelect }: { files: DeskFile[]; selected: string; onSelect: (path: string) => void }) {
  const file = files.find((item) => item.path === selected) ?? files[0];
  return (
    <section className="rounded-2xl border border-border bg-surface p-3">
      {files.length === 0 ? <p className="text-sm text-muted">还没有文件。</p> : null}
      <div className="flex flex-wrap gap-2">
        {files.map((item) => (
          <button
            key={item.path}
            type="button"
            onClick={() => onSelect(item.path)}
            className={`inline-flex min-h-11 items-center rounded-lg border px-3 font-mono text-xs ${item.path === file?.path ? "border-primary bg-primary text-primary-fg" : "border-border bg-bg text-fg"}`}
          >
            {item.path}
          </button>
        ))}
      </div>
      {file ? <pre className="mt-3 max-h-36 overflow-auto rounded-lg bg-bg px-3 py-2 font-mono text-xs leading-5 text-fg">{file.content}</pre> : null}
    </section>
  );
}

function HarnessPanel({
  harnesses,
  setHarnesses,
  modules,
  setModules,
}: {
  harnesses: HarnessId[];
  setHarnesses: (next: HarnessId[]) => void;
  modules: DeskModule[];
  setModules: (next: DeskModule[]) => void;
}) {
  return (
    <section className="rounded-2xl border border-border bg-surface p-3">
      <div className="flex flex-wrap gap-2">
        {SWITCHES.map((item) => {
          const on = harnesses.includes(item.id);
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => setHarnesses(on ? harnesses.filter((kept) => kept !== item.id) : [...harnesses, item.id])}
              className={`inline-flex min-h-11 items-center rounded-lg border px-3 font-mono text-sm ${on ? "border-primary bg-primary text-primary-fg" : "border-border bg-bg text-muted"}`}
            >
              {item.moduleName}
            </button>
          );
        })}
      </div>
      <div className="mt-2 flex flex-wrap gap-2">
        {modules.length === 0 ? <p className="text-sm text-muted">还没有加载的 module。</p> : null}
        {modules.map((mod) => (
          <button
            key={mod.name}
            type="button"
            onClick={() => setModules(modules.filter((item) => item.name !== mod.name))}
            className="inline-flex min-h-11 items-center rounded-lg border border-border bg-bg px-3 font-mono text-sm text-fg"
          >
            {mod.name} · 拿下
          </button>
        ))}
      </div>
    </section>
  );
}

function toolLabel(tool: string): string {
  const labels: Record<string, string> = {
    "Files.list_files": "列出文件",
    "Files.read_file": "读文件",
    "Files.find_in_files": "查找",
    "Files.write_file": "写入",
    "Files.delete_file": "删除",
    "Search.query": "搜索",
    "Net.get": "请求",
    "Trace.note": "记下",
    "Clock.now": "计时",
    compile: "编译未通过",
    list_files: "列出文件",
    read_file: "读文件",
    find_in_files: "查找",
    write_file: "写入",
    delete_file: "删除",
    web_search: "搜索",
    http_get: "请求",
  };
  return labels[tool] ?? tool;
}
