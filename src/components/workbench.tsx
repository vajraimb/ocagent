import { useEffect, useState } from "react";
import { FileText, Play, Plus, X } from "lucide-react";
import { runDesk } from "@/lib/agent/run";
import { CATALOG, DEFAULT_HARNESSES, isHarnessId, type HarnessId } from "@/lib/agent/harness";
import { SEED, type DeskFile, type ToolStep } from "@/lib/agent/workspace";
import { runProofs, type Proof } from "@/lib/harness/proofs";
import { BUGGY_ADD } from "@/lib/harness/world";

type Tab = "run" | "proofs" | "protocol";

type Saved = {
  task: string;
  files: DeskFile[];
  answer: string;
  steps: ToolStep[];
  harnesses: HarnessId[];
};

const STORAGE_KEY = "ocagent-desk-v4";

export function Workbench() {
  const [tab, setTab] = useState<Tab>("run");
  const [task, setTask] = useState("");
  const [harnesses, setHarnesses] = useState<HarnessId[]>(DEFAULT_HARNESSES);
  const [files, setFiles] = useState<DeskFile[]>(SEED);
  const [selected, setSelected] = useState(SEED[0]!.path);
  const [answer, setAnswer] = useState("");
  const [steps, setSteps] = useState<ToolStep[]>([]);
  const [error, setError] = useState("");
  const [running, setRunning] = useState(false);
  const [ready, setReady] = useState(false);
  const [proofs, setProofs] = useState<Proof[] | null>(null);
  const file = files.find((item) => item.path === selected) ?? files[0];

  useEffect(() => {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      try {
        const saved = JSON.parse(raw) as Saved;
        if (typeof saved.task === "string") setTask(saved.task);
        if (Array.isArray(saved.files) && saved.files.length) setFiles(saved.files);
        if (Array.isArray(saved.harnesses)) setHarnesses(saved.harnesses.filter(isHarnessId));
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
    const saved: Saved = { task, files, answer, steps, harnesses };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(saved));
  }, [ready, task, files, answer, steps, harnesses]);

  useEffect(() => {
    if (tab === "proofs" && !proofs) setProofs(runProofs());
  }, [tab, proofs]);

  async function go() {
    const text = task.trim();
    if (!text || running) return;
    setRunning(true);
    setError("");
    setAnswer("");
    setSteps([]);
    try {
      const result = await runDesk({ data: { task: text, files, harnesses } });
      setFiles(result.files);
      setSteps(result.steps);
      if (result.ok) setAnswer(result.answer);
      else setError(result.error);
      const touched = [...result.steps].reverse().find((step) => result.files.some((item) => item.path === step.detail));
      if (touched) setSelected(touched.detail);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "没跑成");
    } finally {
      setRunning(false);
    }
  }

  const passed = proofs?.filter((proof) => proof.pass).length ?? 0;

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-6xl flex-col gap-4 px-4 py-4 sm:px-6">
      <header className="flex flex-col gap-2">
        <p className="font-mono text-xs tracking-widest text-muted">OCAGENT</p>
        <h1 className="text-2xl font-semibold tracking-tight text-fg">让它干活</h1>
        <p className="max-w-xl text-sm leading-6 text-muted">
          写一句任务。它按你装上的 harness 改文件、上网、发请求、跑 OCaml。
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
            <HarnessBar harnesses={harnesses} setHarnesses={setHarnesses} />
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
              onClick={() => void go()}
              disabled={running || task.trim().length === 0}
              className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-primary px-4 text-sm font-medium text-primary-fg disabled:opacity-40"
            >
              <Play className="size-4" aria-hidden />
              {running ? "正在做" : "去做"}
            </button>
            <button
              type="button"
              onClick={() => {
                setFiles(SEED);
                setSelected(SEED[0]!.path);
                setAnswer("");
                setSteps([]);
                setError("");
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
                <p className="mt-2 text-sm leading-6 text-fg">{answer.replaceAll("**", "").replaceAll("`", "")}</p>
              </section>
            ) : (
              <p className="rounded-3xl border border-border bg-surface px-4 py-4 text-sm leading-6 text-muted">
                {running ? "正在做。每一步单独计时，超时也会把已经拿到的结果留下。" : "还没开始。点「添加 harness」装能力，再写任务。"}
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

function HarnessBar({ harnesses, setHarnesses }: { harnesses: HarnessId[]; setHarnesses: (next: HarnessId[]) => void }) {
  const [adding, setAdding] = useState(false);
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <h2 className="font-mono text-xs tracking-widest text-muted">HARNESS</h2>
        <button
          type="button"
          aria-expanded={adding}
          onClick={() => setAdding((open) => !open)}
          className="inline-flex min-h-11 items-center gap-2 rounded-md border border-primary bg-primary px-3 text-sm font-medium text-primary-fg"
        >
          <Plus className="size-4" aria-hidden />
          添加 harness
        </button>
      </div>
      <div className="rounded-lg border border-border bg-bg px-3 py-3">
        <h3 className="text-sm font-medium text-fg">时限</h3>
        <p className="mt-1 text-sm leading-6 text-muted">每一步最多 12 秒，整次最多 40 秒。某一步超时就停那一步，已经拿到的结果照常交出来。</p>
      </div>
      {adding ? (
        <ul className="flex flex-col gap-2 rounded-lg border border-border bg-bg p-2">
          {CATALOG.map((item) => {
            const on = harnesses.includes(item.id);
            return (
              <li key={item.id} className="flex items-center justify-between gap-3 px-2 py-1">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-fg">{item.name}</p>
                  <p className="text-sm leading-6 text-muted">{item.summary}</p>
                </div>
                {on ? (
                  <span className="shrink-0 font-mono text-xs text-muted">已装上</span>
                ) : (
                  <button
                    type="button"
                    onClick={() => setHarnesses([...harnesses, item.id])}
                    className="inline-flex min-h-11 shrink-0 items-center rounded-md border border-border px-3 text-sm text-fg"
                  >
                    加上
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      ) : null}
      <ul className="flex flex-col gap-2">
        {harnesses.map((id) => {
          const item = CATALOG.find((spec) => spec.id === id);
          if (!item) return null;
          return (
            <li key={id} className="rounded-lg border border-border bg-bg px-3 py-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="text-sm font-medium text-fg">{item.name}</h3>
                  <p className="mt-1 text-sm leading-6 text-muted">{item.summary}</p>
                </div>
                <button
                  type="button"
                  aria-label={`拿下${item.name}`}
                  onClick={() => setHarnesses(harnesses.filter((kept) => kept !== id))}
                  className="inline-flex size-11 shrink-0 items-center justify-center rounded-md border border-border text-muted"
                >
                  <X className="size-4" aria-hidden />
                </button>
              </div>
              <p className="mt-2 font-mono text-xs text-primary">{item.signature}</p>
              <pre className="mt-2 max-h-36 overflow-auto rounded-md bg-surface px-3 py-2 font-mono text-xs leading-5 text-fg">{item.source}</pre>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function toolLabel(tool: string): string {
  if (tool === "list_files") return "列出文件";
  if (tool === "read_file") return "读文件";
  if (tool === "search") return "在文件里找";
  if (tool === "web_search") return "网上搜";
  if (tool === "http_get") return "请求网络";
  if (tool === "ocaml_run") return "跑 OCaml";
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
