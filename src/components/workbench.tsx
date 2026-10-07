import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { ArrowUp, FilePen, Globe, PanelRight, Play, Search, Square } from "lucide-react";
import { AgentTurn, type AgentTurnData } from "@/components/agent-turn";
import { SidePanel } from "@/components/side-panel";
import { CATALOG, DEFAULT_HARNESSES, checkModule, isHarnessId, type DeskModule, type HarnessId } from "@/lib/agent/harness";
import type { AgentEvent } from "@/lib/agent/progress";
import { pollDesk, runDesk, stopDesk, type DeskResult } from "@/lib/agent/run";
import type { DeskFile, JournalItem, ToolStep } from "@/lib/agent/workspace";

type UserTurn = { id: string; role: "user"; text: string; at: number };
type Turn = UserTurn | AgentTurnData;

type Saved = {
  files: DeskFile[];
  harnesses: HarnessId[];
  modules: DeskModule[];
  journal: JournalItem[];
  memory: string;
  turns: Turn[];
};

type LegacyTurn = { role: "user" | "agent"; text: string; code?: string; steps?: ToolStep[] };
type ActiveJob = { jobId: string; turnId: string; resumed: boolean };

const STORAGE_KEY = "ocagent-desk-v7";
const LEGACY_KEYS = ["ocagent-desk-v6", "ocagent-desk-v5"];
const ACTIVE_KEY = "ocagent-active-job";
const PREFAB = new Set(["README.md", "src/math.ml", "src/greet.ml", "notes/todo.md"]);
const MAX_TURNS = 40;
const MAX_EVENTS_SAVED = 80;

const EXAMPLES = [
  { icon: Search, text: "查一下东京现在的天气，用一句话告诉我。" },
  { icon: FilePen, text: "写一个 src/fib.ml，算出第 30 个斐波那契数，然后运行它。" },
  { icon: Globe, text: "请求 https://example.com，把页面标题记下来。" },
];

const ABILITIES = [
  { icon: FilePen, title: "读写文件", body: "在工作区里新建、修改、查找文件。" },
  { icon: Search, title: "搜索网页", body: "查公开的新闻、天气和事实。" },
  { icon: Globe, title: "请求地址", body: "抓取一个公网页面或接口。" },
  { icon: Play, title: "编译执行", body: "每一步写成 OCaml，编译通过才会跑。" },
];

function keepFile(file: DeskFile): boolean {
  const name = file.path.split("/").pop() ?? "";
  return !PREFAB.has(file.path) && !name.startsWith("ocagent_");
}

function uid(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

function lastCode(journal: JournalItem[]): string {
  for (let i = journal.length - 1; i >= 0; i -= 1) {
    if (journal[i]?.kind === "code" && journal[i]?.text) return journal[i].text;
  }
  return "";
}

// The loop reports "done" even when the model never answered; the timeline
// knows better, so a run with a model error and no executed step counts as failed.
function statusOf(result: DeskResult, events: AgentEvent[]): AgentTurnData["status"] {
  if (result.stopped) return "stopped";
  if (!result.ok) return "failed";
  const modelFailed = events.some((event) => event.kind === "model_error");
  const stepped = events.some((event) => event.kind === "step" || event.kind === "effect");
  return modelFailed && !stepped ? "failed" : "done";
}

function isTurn(value: unknown): value is Turn {
  if (!value || typeof value !== "object") return false;
  const turn = value as Partial<Turn>;
  if (typeof turn.id !== "string" || typeof turn.text !== "string" || typeof turn.at !== "number") return false;
  if (turn.role === "user") return true;
  if (turn.role !== "agent") return false;
  const agent = turn as Partial<AgentTurnData>;
  return Array.isArray(agent.events) && Array.isArray(agent.steps) && Array.isArray(agent.touched) && typeof agent.status === "string";
}

function tasksOf(turns: Turn[]): Turn[][] {
  const groups: Turn[][] = [];
  for (let i = 0; i < turns.length; i += 1) {
    const turn = turns[i];
    if (!turn) continue;
    const next = turns[i + 1];
    if (turn.role === "user" && next?.role === "agent") {
      groups.push([turn, next]);
      i += 1;
    } else groups.push([turn]);
  }
  return groups.reverse();
}

function fromLegacy(turns: LegacyTurn[]): Turn[] {
  const base = Date.now() - turns.length * 1000;
  return turns.flatMap((turn, index): Turn[] => {
    if (!turn || typeof turn.text !== "string") return [];
    const at = base + index * 1000;
    if (turn.role === "user") return [{ id: uid("u"), role: "user", text: turn.text, at }];
    return [{ id: uid("a"), role: "agent", text: turn.text, at, endedAt: at, status: "done", events: [], steps: turn.steps ?? [], code: turn.code, touched: [] }];
  });
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
  const [active, setActive] = useState<ActiveJob | null>(null);
  const [ready, setReady] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const [examplesOpen, setExamplesOpen] = useState(false);
  const finished = useRef(new Set<string>());
  const input = useRef<HTMLTextAreaElement>(null);
  const running = active !== null;

  useEffect(() => {
    const raw = localStorage.getItem(STORAGE_KEY);
    try {
      if (raw) {
        const saved = JSON.parse(raw) as Partial<Saved>;
        const nextFiles = Array.isArray(saved.files) ? saved.files.filter(keepFile) : [];
        setFiles(nextFiles);
        if (Array.isArray(saved.harnesses)) {
          const ids = (saved.harnesses as string[]).filter(isHarnessId);
          if (ids.length) setHarnesses(ids);
        }
        if (Array.isArray(saved.modules)) {
          setModules(saved.modules.flatMap((mod) => (mod && typeof mod.name === "string" && typeof mod.body === "string" ? (checkModule(mod.name, mod.body) ?? []) : [])));
        }
        if (Array.isArray(saved.journal)) setJournal(saved.journal);
        if (typeof saved.memory === "string") setMemory(saved.memory);
        if (Array.isArray(saved.turns)) setTurns(saved.turns.filter(isTurn));
      } else {
        for (const key of LEGACY_KEYS) {
          const legacy = localStorage.getItem(key);
          if (!legacy) continue;
          const saved = JSON.parse(legacy) as { files?: DeskFile[]; harnesses?: string[]; modules?: DeskModule[]; journal?: JournalItem[]; memory?: string; turns?: LegacyTurn[] };
          const nextFiles = Array.isArray(saved.files) ? saved.files.filter(keepFile) : [];
          setFiles(nextFiles);
          if (Array.isArray(saved.harnesses)) {
            const ids = saved.harnesses.map((id) => (id === "search" ? "web" : id)).filter(isHarnessId);
            if (ids.length) setHarnesses(ids);
          }
          if (Array.isArray(saved.modules)) setModules(saved.modules.flatMap((mod) => checkModule(mod.name, mod.body) ?? []));
          if (Array.isArray(saved.journal)) setJournal(saved.journal);
          if (typeof saved.memory === "string") setMemory(saved.memory);
          if (Array.isArray(saved.turns)) setTurns(fromLegacy(saved.turns));
          localStorage.removeItem(key);
          break;
        }
      }
      const live = localStorage.getItem(ACTIVE_KEY);
      if (live) {
        const parsed = JSON.parse(live) as Partial<ActiveJob>;
        if (typeof parsed.jobId === "string" && typeof parsed.turnId === "string") setActive({ jobId: parsed.jobId, turnId: parsed.turnId, resumed: true });
        else localStorage.removeItem(ACTIVE_KEY);
      }
    } catch {
      localStorage.removeItem(STORAGE_KEY);
      localStorage.removeItem(ACTIVE_KEY);
    }
    setReady(true);
  }, []);

  useEffect(() => {
    if (!ready) return;
    const trimmed = turns.slice(-MAX_TURNS).map((turn) => (turn.role === "agent" && turn.events.length > MAX_EVENTS_SAVED ? { ...turn, events: turn.events.slice(-MAX_EVENTS_SAVED) } : turn));
    const saved: Saved = { files, harnesses, modules, journal, memory, turns: trimmed };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(saved));
    } catch {
      /* storage full: the run itself is unaffected */
    }
  }, [ready, files, harnesses, modules, journal, memory, turns]);

  const patchTurn = useCallback((turnId: string, patch: (turn: AgentTurnData) => AgentTurnData) => {
    setTurns((current) => current.map((turn) => (turn.id === turnId && turn.role === "agent" ? patch(turn) : turn)));
  }, []);

  const settle = useCallback(
    (job: ActiveJob, patch: (turn: AgentTurnData) => AgentTurnData): boolean => {
      if (finished.current.has(job.jobId)) return false;
      finished.current.add(job.jobId);
      patchTurn(job.turnId, patch);
      setActive((current) => (current?.jobId === job.jobId ? null : current));
      localStorage.removeItem(ACTIVE_KEY);
      return true;
    },
    [patchTurn],
  );

  const finish = useCallback(
    (job: ActiveJob, result: DeskResult | null | undefined) => {
      if (finished.current.has(job.jobId)) return;
      if (!result || !Array.isArray(result.files) || !Array.isArray(result.steps)) {
        settle(job, (turn) => ({
          ...turn,
          status: "failed",
          endedAt: Date.now(),
          text: "结果没有完整传回来。上面的过程还在，可以再发一次。",
        }));
        return;
      }
      const nextFiles = result.files.filter(keepFile);
      setFiles(nextFiles);
      if (result.journal) setJournal(result.journal);
      if (typeof result.memory === "string") setMemory(result.memory);
      if (result.modules) setModules(result.modules);
      const touched = [...new Set(result.steps.filter((step) => nextFiles.some((item) => item.path === step.detail)).map((step) => step.detail))];
      if (touched.length) setSelected(touched[touched.length - 1] ?? "");
      else setSelected((current) => (nextFiles.some((item) => item.path === current) ? current : ""));
      const added = (result.journal ?? []).slice(journal.length);
      settle(job, (turn) => {
        const events = result.events && result.events.length >= turn.events.length ? result.events : turn.events;
        return {
          ...turn,
          text: result.ok ? result.answer : result.error,
          status: statusOf(result, events),
          endedAt: Date.now(),
          steps: result.steps,
          code: lastCode(added) || turn.code,
          touched,
          events,
        };
      });
    },
    [journal.length, settle],
  );

  useEffect(() => {
    if (!active) return;
    const job = active;
    let after = 0;
    let cancelled = false;
    let misses = 0;
    const tick = async () => {
      try {
        const snapshot = await pollDesk({ data: { jobId: job.jobId, after } });
        if (cancelled) return;
        if (!snapshot.found) {
          misses += 1;
          if (job.resumed && misses >= 2) {
            settle(job, (turn) => ({ ...turn, status: "failed", endedAt: Date.now(), text: "页面刷新后，服务器已经不记得这次运行了。再发一次就好。" }));
          }
          return;
        }
        if (snapshot.events.length) {
          after = snapshot.events[snapshot.events.length - 1]?.seq ?? after;
          const fresh: AgentEvent[] = snapshot.events;
          patchTurn(job.turnId, (turn) => ({ ...turn, events: [...turn.events, ...fresh] }));
        }
        if (snapshot.done && snapshot.result) finish(job, snapshot.result);
      } catch {
        /* a missed poll only delays the timeline; the run itself continues */
      }
    };
    void tick();
    const timer = window.setInterval(() => void tick(), 1000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [active, finish, patchTurn, settle]);

  async function go(raw: string) {
    const text = raw.trim();
    if (!text || running) return;
    const job: ActiveJob = { jobId: uid("job"), turnId: uid("a"), resumed: false };
    const at = Date.now();
    setTurns((current) => [
      ...current,
      { id: uid("u"), role: "user", text, at },
      { id: job.turnId, role: "agent", text: "", at, status: "running", jobId: job.jobId, events: [], steps: [], touched: [] },
    ]);
    setTask("");
    localStorage.setItem(ACTIVE_KEY, JSON.stringify({ jobId: job.jobId, turnId: job.turnId }));
    setActive(job);
    try {
      const result = await runDesk({ data: { task: text, files, harnesses, modules, journal, memory, jobId: job.jobId } });
      finish(job, result ?? null);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "没跑成";
      finish(job, { ok: false, error: message, files, steps: [], modules, journal, memory });
    }
  }

  async function stop() {
    if (!active) return;
    const job = active;
    try {
      const outcome = await stopDesk({ data: { jobId: job.jobId, after: 0 } });
      if (outcome.stopped) return;
    } catch {
      /* fall through to the local stop */
    }
    settle(job, (turn) => ({ ...turn, status: "stopped", endedAt: Date.now(), text: "已停止查看。这一步可能还在后台跑完，结果不会再显示。" }));
  }

  function reset() {
    if (running) return;
    setFiles([]);
    setSelected("");
    setTurns([]);
    setJournal([]);
    setMemory("");
    setModules([]);
    setTask("");
    setPanelOpen(false);
  }

  function openFile(path: string) {
    setSelected(path);
    setPanelOpen(true);
  }

  function onKey(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void go(task);
    }
  }

  const enabled = CATALOG.filter((item) => item.id === "ocaml" || harnesses.includes(item.id)).map((item) => item.name);
  const showExamples = turns.length === 0;

  return (
    <div className="min-h-screen lg:grid lg:grid-cols-[minmax(0,1fr)_21rem]">
      <main className="flex min-h-screen min-w-0 flex-col">
        <div className="sticky top-0 z-20 border-b border-border bg-bg/95 backdrop-blur">
          <header>
            <div className="mx-auto flex w-full max-w-3xl items-center justify-between px-4 py-3">
              <div className="min-w-0">
                <p className="font-mono text-xs tracking-widest text-muted">OCAGENT</p>
                <h1 className="truncate text-base font-semibold text-fg">用 OCaml 行动的 agent</h1>
              </div>
              <button
                type="button"
                onClick={() => setPanelOpen(true)}
                className="inline-flex min-h-10 items-center gap-2 rounded-lg border border-border px-3 text-sm text-fg lg:hidden"
              >
                <PanelRight className="h-4 w-4" aria-hidden />
                工作区{files.length ? <span className="font-mono text-xs text-muted">{files.length}</span> : null}
              </button>
            </div>
          </header>
          <div className="mx-auto w-full max-w-3xl px-4 pb-3">
            <div className="flex items-end gap-2 rounded-2xl border border-border bg-surface p-2 focus-within:border-primary">
              <label className="min-w-0 flex-1">
                <span className="sr-only">对它说</span>
                <textarea
                  ref={input}
                  value={task}
                  onChange={(event) => setTask(event.target.value)}
                  onKeyDown={onKey}
                  rows={Math.min(6, Math.max(2, task.split("\n").length))}
                  placeholder={running ? "它还在做，做完再说下一件。" : "说一件要做完的事"}
                  disabled={running}
                  className="block w-full resize-none select-text bg-transparent px-2 py-2 text-[15px] leading-6 text-fg outline-none placeholder:text-muted disabled:opacity-60"
                />
              </label>
              {running ? (
                <button type="button" onClick={() => void stop()} aria-label="停下" className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-border text-fg hover:border-danger hover:text-danger">
                  <Square className="h-4 w-4" aria-hidden />
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => void go(task)}
                  disabled={task.trim().length === 0}
                  aria-label="发送"
                  className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-fg disabled:opacity-40"
                >
                  <ArrowUp className="h-4 w-4" aria-hidden />
                </button>
              )}
            </div>
            <div className="mt-1.5 flex items-center justify-between gap-3 px-1">
              <p className="min-w-0 truncate text-xs text-muted">开着：{enabled.join(" · ")}</p>
              {turns.length > 0 ? (
                <button type="button" onClick={() => setExamplesOpen((open) => !open)} className="shrink-0 text-xs text-fg">
                  {examplesOpen ? "收起示例" : "试试"}
                </button>
              ) : null}
            </div>
            {turns.length > 0 && examplesOpen ? (
              <div className="mt-3 flex max-h-[40vh] flex-col gap-3 overflow-y-auto pb-1">
                <ul className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                  {ABILITIES.map((item) => (
                    <li key={item.title} className="rounded-xl border border-border bg-surface px-3 py-3">
                      <item.icon className="h-4 w-4 text-muted" aria-hidden />
                      <p className="mt-2 text-sm font-medium text-fg">{item.title}</p>
                      <p className="mt-0.5 text-xs leading-5 text-muted">{item.body}</p>
                    </li>
                  ))}
                </ul>
                <div className="flex flex-col gap-2">
                  {EXAMPLES.map((item) => (
                    <button
                      key={item.text}
                      type="button"
                      disabled={running}
                      onClick={() => void go(item.text)}
                      className="flex min-h-11 items-center gap-3 rounded-xl border border-border bg-bg px-3 text-left text-sm text-fg hover:border-primary disabled:opacity-50"
                    >
                      <item.icon className="h-4 w-4 shrink-0 text-muted" aria-hidden />
                      <span className="min-w-0 flex-1">{item.text}</span>
                      <ArrowUp className="h-3.5 w-3.5 shrink-0 rotate-45 text-muted" aria-hidden />
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        </div>

        <section className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-5 px-4 py-5">
          {ready && showExamples ? (
            <div className={turns.length === 0 ? "flex flex-1 flex-col justify-center gap-6 py-6" : "flex flex-col gap-4"}>
              {turns.length === 0 ? (
                <div>
                  <h2 className="text-2xl font-semibold text-fg">说一件事，它去做。</h2>
                  <p className="mt-2 max-w-xl text-sm leading-6 text-muted">每一步都写成一段 OCaml，编译通过才执行；搜了什么、写了什么、下一步为什么继续，都会实时显示在这里。</p>
                </div>
              ) : null}
              <ul className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {ABILITIES.map((item) => (
                  <li key={item.title} className="rounded-xl border border-border bg-surface px-3 py-3">
                    <item.icon className="h-4 w-4 text-muted" aria-hidden />
                    <p className="mt-2 text-sm font-medium text-fg">{item.title}</p>
                    <p className="mt-0.5 text-xs leading-5 text-muted">{item.body}</p>
                  </li>
                ))}
              </ul>
              <div>
                <p className="font-mono text-xs tracking-widest text-muted">试试</p>
                <div className="mt-2 flex flex-col gap-2">
                  {EXAMPLES.map((item) => (
                    <button
                      key={item.text}
                      type="button"
                      disabled={running}
                      onClick={() => void go(item.text)}
                      className="flex min-h-11 items-center gap-3 rounded-xl border border-border bg-surface px-3 text-left text-sm text-fg hover:border-primary disabled:opacity-50"
                    >
                      <item.icon className="h-4 w-4 shrink-0 text-muted" aria-hidden />
                      <span className="min-w-0 flex-1">{item.text}</span>
                      <ArrowUp className="h-3.5 w-3.5 shrink-0 rotate-45 text-muted" aria-hidden />
                    </button>
                  ))}
                </div>
              </div>
            </div>
          ) : null}

          {tasksOf(turns).map((taskTurns) => (
            <div key={taskTurns[0]?.id} className="flex flex-col gap-5">
              {taskTurns.map((turn) =>
                turn.role === "user" ? (
                  <article key={turn.id} className="ml-10 select-text self-end rounded-2xl bg-raised px-4 py-3">
                    <p className="whitespace-pre-wrap text-[15px] leading-7 text-fg">{turn.text}</p>
                  </article>
                ) : (
                  <AgentTurn key={turn.id} turn={turn} onOpenFile={openFile} />
                ),
              )}
            </div>
          ))}
        </section>
      </main>

      <aside className="hidden border-l border-border bg-bg lg:block">
        <div className="sticky top-0 h-screen overflow-y-auto">
          <SidePanel harnesses={harnesses} setHarnesses={setHarnesses} modules={modules} setModules={setModules} files={files} selected={selected} onSelect={setSelected} onReset={reset} busy={running} />
        </div>
      </aside>

      {panelOpen ? (
        <div className="fixed inset-0 z-30 lg:hidden">
          <button type="button" aria-label="收起工作区" onClick={() => setPanelOpen(false)} className="absolute inset-0 bg-black/50" />
          <div className="absolute inset-y-0 right-0 w-[min(22rem,100%)] overflow-y-auto border-l border-border bg-bg shadow-2xl">
            <SidePanel harnesses={harnesses} setHarnesses={setHarnesses} modules={modules} setModules={setModules} files={files} selected={selected} onSelect={setSelected} onReset={reset} onClose={() => setPanelOpen(false)} busy={running} />
          </div>
        </div>
      ) : null}
    </div>
  );
}
