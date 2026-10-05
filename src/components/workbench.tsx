import { useEffect, useRef, useState } from "react";
import { FileText, Play } from "lucide-react";
import { runDesk } from "@/lib/agent/run";
import { CATALOG, DEFAULT_HARNESSES, checkModule, isHarnessId, type DeskModule, type HarnessId } from "@/lib/agent/harness";
import { SEED, type DeskFile, type JournalItem, type ToolStep } from "@/lib/agent/workspace";
import { runProofs, type Proof } from "@/lib/harness/proofs";
import { BUGGY_ADD } from "@/lib/harness/world";

type Tab = "run" | "proofs" | "protocol";

type Saved = {
  task: string;
  files: DeskFile[];
  answer: string;
  steps: ToolStep[];
  harnesses: HarnessId[];
  modules: DeskModule[];
  journal: JournalItem[];
  memory: string;
};

const STORAGE_KEY = "ocagent-desk-v5";

export function Workbench() {
  const [tab, setTab] = useState<Tab>("run");
  const [task, setTask] = useState("");
  const [harnesses, setHarnesses] = useState<HarnessId[]>(DEFAULT_HARNESSES);
  const [modules, setModules] = useState<DeskModule[]>([]);
  const [journal, setJournal] = useState<JournalItem[]>([]);
  const [memory, setMemory] = useState("");
  const [files, setFiles] = useState<DeskFile[]>(SEED);
  const [selected, setSelected] = useState(SEED[0]!.path);
  const [answer, setAnswer] = useState("");
  const [steps, setSteps] = useState<ToolStep[]>([]);
  const [error, setError] = useState("");
  const [running, setRunning] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [ready, setReady] = useState(false);
  const [proofs, setProofs] = useState<Proof[] | null>(null);
  const file = files.find((item) => item.path === selected) ?? files[0];
  const runId = useRef(0);

  useEffect(() => {
    if (!running) return;
    const started = Date.now();
    setSeconds(0);
    const tick = window.setInterval(() => setSeconds(Math.floor((Date.now() - started) / 1000)), 400);
    return () => window.clearInterval(tick);
  }, [running]);

  useEffect(() => {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      try {
        const saved = JSON.parse(raw) as Saved;
        if (typeof saved.task === "string") setTask(saved.task);
        if (Array.isArray(saved.files) && saved.files.length) setFiles(saved.files);
        if (Array.isArray(saved.harnesses)) {
          const ids = (saved.harnesses as string[])
            .map((id) => (id === "search" ? "web" : id))
            .filter(isHarnessId);
          setHarnesses(ids);
        }
        if (Array.isArray(saved.modules)) {
          setModules(saved.modules.flatMap((mod) => {
            if (!mod || typeof mod.name !== "string" || typeof mod.body !== "string") return [];
            const checked = checkModule(mod.name, mod.body);
            return checked ? [checked] : [];
          }));
        }
        if (Array.isArray(saved.journal)) setJournal(saved.journal);
        if (typeof saved.memory === "string") setMemory(saved.memory);
        setAnswer(saved.answer ?? "");
        setSteps(saved.steps ?? []);
      } catch {
        localStorage.removeItem(STORAGE_KEY);
      }
    }
    setReady(true);
  }, []);

  useEffect(() => {
    if (!ready) return;
    const saved: Saved = { task, files, answer, steps, harnesses, modules, journal, memory };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(saved));
  }, [ready, task, files, answer, steps, harnesses, modules, journal, memory]);

  useEffect(() => {
    if (tab === "proofs" && !proofs) setProofs(runProofs());
  }, [tab, proofs]);

  async function go(resume = false) {
    const text = task.trim();
    if (!text || running) return;
    const id = ++runId.current;
    const started = Date.now();
    setRunning(true);
    setError("");
    setAnswer("");
    setSteps([]);
    const nextJournal = resume ? journal : [];
    if (!resume) setJournal([]);
    const watch = window.setTimeout(() => {
      if (runId.current !== id) return;
      setRunning(false);
      setAnswer("太久没有回来。再点一次。若刚才那次稍后做完，结果会自己出现。");
    }, 55_000);
    try {
      const result = await runDesk({ data: { task: text, files, harnesses, modules, journal: nextJournal, memory } });
      if (runId.current !== id) return;
      const spent = Math.max(1, Math.round((Date.now() - started) / 1000));
      setFiles(result.files);
      setSteps(result.steps);
      if (result.journal) setJournal(result.journal);
      if (typeof result.memory === "string") setMemory(result.memory);
      if (result.modules) setModules(result.modules);
      if (result.ok) setAnswer(`${result.answer}\n\n这一次用了 ${spent} 秒。`);
      else setError(`${result.error}（用了 ${spent} 秒）`);
      const touched = [...result.steps].reverse().find((step) => result.files.some((item) => item.path === step.detail));
      if (touched) setSelected(touched.detail);
    } catch (caught) {
      if (runId.current !== id) return;
      setError(caught instanceof Error ? caught.message : "没跑成");
    } finally {
      window.clearTimeout(watch);
      if (runId.current === id) setRunning(false);
    }
  }

  function stop() {
    runId.current += 1;
    setRunning(false);
    setAnswer(journal.length ? "已停下。点继续从日志接着做，或再点一次重做。" : "已停下。再点一次重新做。");
    setError("");
  }

  const passed = proofs?.filter((proof) => proof.pass).length ?? 0;

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-6xl flex-col gap-4 px-4 py-4 sm:px-6">
      <header className="flex flex-col gap-2">
        <p className="font-mono text-xs tracking-widest text-muted">OCAGENT</p>
        <h1 className="text-2xl font-semibold tracking-tight text-fg">让它干活</h1>
        <p className="max-w-xl text-sm leading-6 text-muted">
          做完会停，并把用时写在结果里。太久会把已经做出的部分交回来，也可以中途停下。
        </p>
      </header>

      <nav className="grid grid-cols-3 gap-2" aria-label="视图">
        <TabButton id="run" tab={tab} setTab={setTab} label="任务" />
        <TabButton id="proofs" tab={tab} setTab={setTab} label={proofs ? `验收 ${passed}/${proofs.length}` : "验收"} />
        <TabButton id="protocol" tab={tab} setTab={setTab} label="协议" />
      </nav>

      {tab === "run" ? (
        <div className="grid min-w-0 items-start gap-5 lg:grid-cols-2">
          <section className="flex min-w-0 flex-col gap-3 rounded-3xl border border-border bg-surface p-4 lg:sticky lg:top-4">
            <HarnessBar harnesses={harnesses} setHarnesses={setHarnesses} modules={modules} setModules={setModules} />
            <label className="flex flex-col gap-2">
              <span className="font-mono text-xs tracking-widest text-muted">要它做什么</span>
              <textarea
                value={task}
                onChange={(event) => setTask(event.target.value)}
                rows={4}
                placeholder="写一件要做完的事"
                className="w-full resize-y rounded-lg border border-border bg-bg px-3 py-3 text-sm leading-6 text-fg outline-none placeholder:text-muted focus:border-primary"
              />
            </label>
            <button
              type="button"
              onClick={() => (running ? stop() : void go(false))}
              disabled={!running && task.trim().length === 0}
              className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-primary px-4 text-sm font-medium text-primary-fg disabled:opacity-40"
            >
              <Play className="size-4" aria-hidden />
              {running ? `停下 · ${seconds} 秒` : "去做"}
            </button>
            <button
              type="button"
              onClick={() => void go(true)}
              disabled={running || journal.length === 0}
              className="min-h-11 rounded-lg border border-border bg-bg px-3 text-sm text-fg disabled:opacity-40"
            >
              继续
            </button>
            <button
              type="button"
              onClick={() => {
                setFiles(SEED);
                setSelected(SEED[0]!.path);
                setAnswer("");
                setSteps([]);
                setError("");
                setJournal([]);
                setMemory("");
              }}
              className="min-h-11 rounded-lg border border-border bg-bg px-3 text-sm text-fg"
            >
              恢复初始文件
            </button>
          </section>

          <div className="flex min-w-0 flex-col gap-4">
            {error ? <p className="rounded-3xl border border-danger bg-surface px-4 py-3 text-sm leading-6 text-danger">{error}</p> : null}
            {answer ? (
              <section className="rounded-3xl border border-border bg-surface p-4">
                <h2 className="text-base font-medium text-fg">它说</h2>
                <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-fg">{answer.replaceAll("**", "").replaceAll("`", "")}</p>
              </section>
            ) : (
              <p className="rounded-3xl border border-border bg-surface px-4 py-4 text-sm leading-6 text-muted">
                {running ? `已用 ${seconds} 秒。做完会写在这里；不想等就点停下。` : "还没开始。点继续会从上次日志接着做。"}
              </p>
            )}

            {steps.length ? (
              <ol className="flex flex-col">
                {steps.map((step, index) => (
                  <li key={`${step.tool}-${step.detail}-${index}`} className="grid grid-cols-[2.5rem_1fr] gap-3">
                    <div className="flex flex-col items-center">
                      <span className="mt-3 size-3 rounded-full border border-primary bg-primary" aria-hidden />
                      {index < steps.length - 1 ? <span className="w-px flex-1 bg-border" /> : null}
                    </div>
                    <div className="mb-3 min-w-0 rounded-lg border border-border bg-raised px-3 py-3">
                      <div className="flex items-baseline justify-between gap-3">
                        <h2 className="text-sm font-medium text-fg">{toolLabel(step.tool)}</h2>
                        <span className="truncate font-mono text-xs text-muted">{step.detail}</span>
                      </div>
                      <p className="mt-1 line-clamp-3 font-mono text-xs leading-5 text-muted">{step.output}</p>
                    </div>
                  </li>
                ))}
              </ol>
            ) : null}

            <section className="min-w-0 rounded-3xl border border-border bg-surface p-4">
              <div className="mb-3 flex items-baseline justify-between gap-3">
                <h2 className="font-mono text-sm text-fg">{file?.path ?? "空"}</h2>
                <p className="text-xs text-muted">{file ? mark(file) : ""}</p>
              </div>
              <div className="mb-3 flex min-w-0 gap-2 overflow-x-auto">
                {files.map((item) => (
                  <button
                    key={item.path}
                    type="button"
                    onClick={() => setSelected(item.path)}
                    className={`inline-flex min-h-11 shrink-0 items-center gap-2 rounded-lg border px-3 text-sm ${item.path === file?.path ? "border-primary bg-primary text-primary-fg" : "border-border bg-bg text-fg"}`}
                  >
                    <FileText className="size-4" aria-hidden />
                    {item.path}
                  </button>
                ))}
              </div>
              <pre className="overflow-x-auto rounded-lg bg-bg px-3 py-3 font-mono text-sm leading-6 text-fg">{file?.content ?? ""}</pre>
            </section>
          </div>
        </div>
      ) : null}

      {tab === "proofs" ? <ProofList proofs={proofs} /> : null}
      {tab === "protocol" ? <Protocol /> : null}
    </main>
  );
}

function HarnessBar({
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
    <section className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="font-mono text-xs tracking-widest text-muted">MODULE</h2>
        <p className="text-xs text-muted">{harnesses.length} 个预制开着</p>
      </div>
      <ul className="flex flex-col gap-2">
        {CATALOG.map((item) => {
          const on = harnesses.includes(item.id);
          return (
            <li key={item.id} className="rounded-lg border border-border bg-bg px-3 py-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="font-mono text-sm text-fg">module {item.moduleName}</h3>
                  <p className="mt-1 text-sm leading-6 text-muted">{item.summary}</p>
                </div>
                <button
                  type="button"
                  onClick={() => setHarnesses(on ? harnesses.filter((kept) => kept !== item.id) : [...harnesses, item.id])}
                  className={`inline-flex min-h-11 shrink-0 items-center rounded-md border px-3 text-sm ${on ? "border-border text-fg" : "border-primary bg-primary text-primary-fg"}`}
                >
                  {on ? "拿下" : "加上"}
                </button>
              </div>
              <pre className="mt-2 max-h-28 overflow-auto rounded-md bg-surface px-3 py-2 font-mono text-xs leading-5 text-fg">{item.source}</pre>
            </li>
          );
        })}
      </ul>
      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-medium text-fg">agent 加载的</h3>
        <p className="text-sm leading-6 text-muted">不用手工填。让它写好文件再加载，成功后会出现在这里。</p>
        {modules.length === 0 ? <p className="text-sm text-muted">还没有。</p> : null}
        <ul className="flex flex-col gap-2">
          {modules.map((mod) => (
            <li key={mod.name} className="rounded-lg border border-border bg-bg px-3 py-3">
              <div className="flex items-start justify-between gap-3">
                <h4 className="font-mono text-sm text-fg">module {mod.name}</h4>
                <button
                  type="button"
                  onClick={() => setModules(modules.filter((item) => item.name !== mod.name))}
                  className="inline-flex min-h-11 shrink-0 items-center rounded-md border border-border px-3 text-sm text-fg"
                >
                  拿下
                </button>
              </div>
              <pre className="mt-2 max-h-28 overflow-auto font-mono text-xs leading-5 text-fg">{mod.body}</pre>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

function toolLabel(tool: string): string {
  if (tool === "list_files") return "列出文件";
  if (tool === "read_file") return "读文件";
  if (tool === "search" || tool === "find_in_files") return "在文件里找";
  if (tool === "web_search") return "网上搜";
  if (tool === "http_get") return "请求网络";
  if (tool === "ocaml_run") return "跑 OCaml";
  if (tool === "load_harness") return "加载 harness";
  if (tool === "budget") return "时限";
  if (tool === "write_file") return "写入";
  if (tool === "delete_file") return "删除";
  return tool;
}

function mark(file: DeskFile): string {
  const seed = SEED.find((item) => item.path === file.path);
  if (!seed) return "新建";
  if (seed.content !== file.content) return "改过";
  return "未改";
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
        <h2 className="text-base font-medium text-fg">效果层还在</h2>
        <p className="text-sm leading-6 text-muted">上面的任务走的是模型。下面这套是原来的 effect harness，验收页会再跑一遍。</p>
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
      <p className="text-sm leading-6 text-muted">验收用的初始加法仍是减法：{BUGGY_ADD.trim()}。</p>
    </div>
  );
}
