import { useEffect, useRef, useState } from "react";
import { runDesk } from "@/lib/agent/run";
import { CATALOG, DEFAULT_HARNESSES, checkModule, isHarnessId, type DeskModule, type HarnessId } from "@/lib/agent/harness";
import { type DeskFile, type JournalItem, type ToolStep } from "@/lib/agent/workspace";

type Turn = {
  role: "user" | "agent";
  text: string;
  code?: string;
  steps?: ToolStep[];
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
  const runId = useRef(0);
  const bottom = useRef<HTMLDivElement>(null);
  const file = files.find((item) => item.path === selected) ?? files[0];

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

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [turns, running, files.length]);

  async function go(text: string, resume: boolean) {
    if (!text || running) return;
    const id = ++runId.current;
    setTurns((current) => [...current, { role: "user", text }]);
    setTask("");
    setRunning(true);
    setError("");
    const nextJournal = resume ? journal : [];
    if (!resume) {
      setJournal([]);
      setMemory("");
    }
    const watch = window.setTimeout(() => {
      if (runId.current !== id) return;
      setRunning(false);
      setTurns((current) => [...current, { role: "agent", text: "太久没有回来。再发一次。若刚才那次稍后做完，结果会补在后面。" }]);
    }, 300_000);
    try {
      const result = await runDesk({ data: { task: text, files, harnesses, modules, journal: nextJournal, memory: resume ? memory : "" } });
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
      setTurns((current) => [...current, { role: "agent", text: spoken, code: lastCode(result.journal ?? []), steps: result.steps }]);
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

  function stop() {
    runId.current += 1;
    setRunning(false);
    setTurns((current) => [...current, { role: "agent", text: "已停下。" }]);
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
      <header className="sticky top-0 z-10 border-b border-border bg-bg/95 px-4 py-3 backdrop-blur">
        <p className="font-mono text-xs tracking-widest text-muted">OCAGENT</p>
        <h1 className="mt-1 text-lg font-semibold text-fg">用 OCaml 行动的 agent</h1>
        <p className="mt-1 text-sm leading-6 text-muted">每一轮只执行它写下的一段 OCaml。编译不过，就不行动。它看不见返回值，除非自己用 Trace.note 记下。</p>
      </header>

      <div className="flex flex-1 flex-col gap-4 px-4 py-4">
        {turns.length === 0 && !running ? (
          <p className="rounded-2xl border border-border bg-surface px-4 py-4 text-sm leading-6 text-muted">
            工作区是空的。直接说要做什么。它会把结果写成文件；说「加载进 harness」，写好的 .ml 会出现在设置里。
          </p>
        ) : null}

        {turns.map((turn, index) => (
          <article key={`${turn.role}-${index}`} className={turn.role === "user" ? "ml-8 rounded-2xl bg-raised px-4 py-3" : "mr-6 rounded-2xl border border-border bg-surface px-4 py-3"}>
            <p className="font-mono text-[11px] tracking-widest text-muted">{turn.role === "user" ? "你" : "OCAGENT"}</p>
            <p className="mt-1 whitespace-pre-wrap text-sm leading-6 text-fg">{turn.text.replaceAll("**", "").replaceAll("`", "")}</p>
            {turn.code ? (
              <pre className="mt-3 max-h-48 overflow-auto rounded-lg bg-bg px-3 py-2 font-mono text-xs leading-5 text-fg">{turn.code}</pre>
            ) : null}
            {turn.steps?.length ? (
              <ul className="mt-3 flex flex-col gap-2">
                {turn.steps.map((step, stepIndex) => (
                  <li key={`${step.tool}-${step.detail}-${stepIndex}`} className="min-w-0">
                    <p className="font-mono text-xs text-fg">
                      {toolLabel(step.tool)}
                      {step.detail ? <span className="text-muted"> {step.detail}</span> : null}
                    </p>
                    {step.output ? <p className="line-clamp-3 font-mono text-xs leading-5 text-muted">{step.output}</p> : null}
                  </li>
                ))}
              </ul>
            ) : null}
          </article>
        ))}

        {running ? <p className="text-sm text-muted">正在编译并执行 · {seconds} 秒</p> : null}
        {error ? <p className="text-sm text-danger">{error}</p> : null}

        <section className="rounded-2xl border border-border bg-surface p-4">
          <div className="flex items-baseline justify-between gap-3">
            <h2 className="text-sm font-medium text-fg">工作区</h2>
            <p className="text-xs text-muted">{files.length ? `${files.length} 个文件` : "空"}</p>
          </div>
          {files.length === 0 ? <p className="mt-2 text-sm text-muted">还没有文件。</p> : null}
          {files.length ? (
            <div className="mt-3 flex gap-2 overflow-x-auto">
              {files.map((item) => (
                <button
                  key={item.path}
                  type="button"
                  onClick={() => setSelected(item.path)}
                  className={`inline-flex min-h-11 shrink-0 items-center rounded-lg border px-3 font-mono text-xs ${item.path === file?.path ? "border-primary bg-primary text-primary-fg" : "border-border bg-bg text-fg"}`}
                >
                  {item.path}
                </button>
              ))}
            </div>
          ) : null}
          {file ? <pre className="mt-3 max-h-64 overflow-auto rounded-lg bg-bg px-3 py-3 font-mono text-xs leading-5 text-fg">{file.content}</pre> : null}
        </section>
        <div ref={bottom} />
      </div>

      <footer className="sticky bottom-0 border-t border-border bg-bg px-4 py-3">
        {settings ? (
          <HarnessPanel harnesses={harnesses} setHarnesses={setHarnesses} modules={modules} setModules={setModules} />
        ) : null}
        <label className="flex flex-col gap-2">
          <span className="sr-only">对它说</span>
          <textarea
            value={task}
            onChange={(event) => setTask(event.target.value)}
            rows={2}
            placeholder="说一件要做完的事"
            className="w-full resize-none rounded-xl border border-border bg-surface px-3 py-3 text-sm leading-6 text-fg outline-none placeholder:text-muted focus:border-primary"
          />
        </label>
        <div className="mt-2 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => (running ? stop() : void go(task.trim(), journal.length > 0))}
            disabled={!running && task.trim().length === 0}
            className="inline-flex min-h-11 items-center justify-center rounded-lg bg-primary px-4 text-sm font-medium text-primary-fg disabled:opacity-40"
          >
            {running ? `停下 · ${seconds} 秒` : "发送"}
          </button>
          <button type="button" onClick={() => setSettings((open) => !open)} className="min-h-11 rounded-lg border border-border px-3 text-sm text-fg">
            {settings ? "收起 harness" : `Harness ${modules.length ? `· ${modules.length}` : ""}`}
          </button>
          <button type="button" onClick={reset} className="min-h-11 rounded-lg border border-border px-3 text-sm text-muted">
            清空
          </button>
        </div>
      </footer>
    </main>
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
    <section className="mb-3 rounded-2xl border border-border bg-surface p-3">
      <p className="text-xs leading-5 text-muted">Step 里永远有 Trace 和 Clock。下面三个可以开关。加载的 module 来自它写的 .ml。</p>
      <ul className="mt-2 flex flex-col gap-2">
        {SWITCHES.map((item) => {
          const on = harnesses.includes(item.id);
          return (
            <li key={item.id} className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="font-mono text-sm text-fg">{item.moduleName}</p>
                <p className="text-xs text-muted">{item.summary}</p>
              </div>
              <button
                type="button"
                onClick={() => setHarnesses(on ? harnesses.filter((kept) => kept !== item.id) : [...harnesses, item.id])}
                className={`inline-flex min-h-11 shrink-0 items-center rounded-md border px-3 text-sm ${on ? "border-border text-fg" : "border-primary bg-primary text-primary-fg"}`}
              >
                {on ? "开" : "关"}
              </button>
            </li>
          );
        })}
      </ul>
      <h3 className="mt-3 text-sm text-fg">已加载</h3>
      {modules.length === 0 ? <p className="mt-1 text-sm text-muted">还没有。</p> : null}
      <ul className="mt-2 flex flex-col gap-2">
        {modules.map((mod) => (
          <li key={mod.name} className="rounded-lg border border-border bg-bg px-3 py-2">
            <div className="flex items-center justify-between gap-3">
              <p className="font-mono text-sm text-fg">module {mod.name}</p>
              <button type="button" onClick={() => setModules(modules.filter((item) => item.name !== mod.name))} className="min-h-11 px-2 text-sm text-muted">
                拿下
              </button>
            </div>
          </li>
        ))}
      </ul>
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
