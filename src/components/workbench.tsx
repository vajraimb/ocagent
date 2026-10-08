import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { ArrowUp, Blocks, FilePen, Globe, PackagePlus, PanelRight, Play, Search, Square } from "lucide-react";
import { AgentTurn, type AgentTurnData } from "@/components/agent-turn";
import { SidePanel } from "@/components/side-panel";
import { CATALOG, DEFAULT_HARNESSES, MAX_MODULES, checkModule, isHarnessId, moduleNameFor, type DeskModule, type HarnessId } from "@/lib/agent/harness";
import { foldRounds, type AgentEvent } from "@/lib/agent/progress";
import { installModule, pollDesk, runDesk, stopDesk, type DeskResult } from "@/lib/agent/run";
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
// One request to the server. A long task is several of these in a row
// (segments): the server pauses when its time budget runs out and the page
// starts the next segment with the carried journal, under the same turn.
type ActiveJob = { jobId: string; turnId: string; resumed: boolean; task: string; segment: number; roundBase: number; eventsBefore: number };

const STORAGE_KEY = "ocagent-desk-v7";
const LEGACY_KEYS = ["ocagent-desk-v6", "ocagent-desk-v5"];
const ACTIVE_KEY = "ocagent-active-job";
const PREFAB = new Set(["README.md", "src/math.ml", "src/greet.ml", "notes/todo.md"]);
const MAX_TURNS = 40;
const MAX_EVENTS_SAVED = 80;
const MAX_SEGMENTS = 6;
const RECOVER_MS = 120_000;

const EXAMPLES = [
  { icon: Search, text: "查一下东京现在的天气，用一句话告诉我。" },
  { icon: Blocks, text: "写一个 src/fib.ml，里面有 fib n，装成 harness，再用它算 fib 30。" },
  { icon: PackagePlus, text: "把 https://raw.githubusercontent.com/ocaml/ocaml/trunk/stdlib/option.ml 装成 Myopt，然后用 Myopt.value 试一下。" },
  { icon: Globe, text: "请求 https://example.com，把页面标题记下来。" },
];

const ABILITIES = [
  { icon: FilePen, title: "读写文件", body: "在工作区里新建、修改、查找文件。" },
  { icon: Search, title: "搜索与请求", body: "查公开的事实，抓一个公网页面或接口。" },
  { icon: Play, title: "编译执行", body: "每一步写成 OCaml，编译通过才会跑。" },
  { icon: Blocks, title: "装 harness", body: "写好的 .ml 或网上的库，装上后每一步都能直接调用。" },
];

const CONTINUE_TEXT = "接着上一次没做完的继续做，先看看工作区里已经有什么。";

// The newest agent turn that stopped short of an answer gets a one-tap follow-up.
function unfinished(turn: AgentTurnData): boolean {
  if (turn.status === "stopped" || turn.status === "failed" || turn.status === "paused") return true;
  const rounds = foldRounds(turn.events);
  return rounds[rounds.length - 1]?.reply?.kind === "partial";
}

// Rounds of a later segment continue the numbering of the earlier ones.
function shiftRounds(events: AgentEvent[], base: number): AgentEvent[] {
  if (!base) return events;
  return events.map((event) => ("round" in event ? { ...event, round: event.round + base } : event));
}

function lastRound(events: AgentEvent[]): number {
  let max = 0;
  for (const event of events) if ("round" in event && event.round > max) max = event.round;
  return max;
}

function readActive(raw: string | null): ActiveJob | null {
  if (!raw) return null;
  const parsed = JSON.parse(raw) as Partial<ActiveJob>;
  if (typeof parsed.jobId !== "string" || typeof parsed.turnId !== "string") return null;
  return {
    jobId: parsed.jobId,
    turnId: parsed.turnId,
    resumed: true,
    task: typeof parsed.task === "string" ? parsed.task : "",
    segment: typeof parsed.segment === "number" ? parsed.segment : 1,
    roundBase: typeof parsed.roundBase === "number" ? parsed.roundBase : 0,
    eventsBefore: typeof parsed.eventsBefore === "number" ? parsed.eventsBefore : 0,
  };
}

function isDeskResult(value: unknown): value is DeskResult {
  if (!value || typeof value !== "object") return false;
  const result = value as Partial<DeskResult>;
  return typeof result.ok === "boolean" && Array.isArray(result.files) && Array.isArray(result.steps);
}

// What came back was not a desk result at all: typically a gateway error page
// after a connection timed out. Say so, with whatever it did say.
function brokenReplyText(result: unknown, startedAt: number): string {
  const seconds = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
  let said = "";
  if (result && typeof result === "object") {
    for (const key of ["error", "message", "detail"]) {
      const value = (result as Record<string, unknown>)[key];
      if (typeof value === "string" && value.trim()) {
        said = value.trim().slice(0, 200);
        break;
      }
    }
  }
  return `连接在 ${seconds} 秒后断开了，结果没有完整传回来${said ? `（对方说：${said}）` : ""}。上面的过程还在，工作区里写好的也还在；点「接着做」会从那里继续。`;
}

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
  if (result.paused) return "paused";
  if (!result.ok) return "failed";
  // Rounds happened but no step ever ran to completion: whatever text came
  // back is an error the loop relayed, not an answer.
  const rounds = events.some((event) => event.kind === "think");
  const stepped = events.some((event) => event.kind === "step" || event.kind === "effect");
  return rounds && !stepped ? "failed" : "done";
}

function progressed(events: AgentEvent[]): boolean {
  return events.some((event) => event.kind === "step" || event.kind === "effect");
}

// fetch() failed before any response: the connection dropped (phone locked,
// network changed, gateway reset). The server may well still be running.
function isConnectionLoss(caught: unknown): boolean {
  return caught instanceof TypeError || (caught instanceof Error && /load failed|failed to fetch|network/i.test(caught.message));
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
  // The running turn's event log, kept outside React state so the poll loop
  // and segment hand-offs read what was actually appended, not a stale render.
  const logs = useRef(new Map<string, AgentEvent[]>());
  // Jobs whose request died mid-flight; polling keeps looking for their result
  // until the deadline, then the turn is marked failed with this message.
  const recovering = useRef(new Map<string, { until: number; message: string }>());
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
        if (Array.isArray(saved.turns)) {
          const kept = saved.turns.filter(isTurn);
          setTurns(kept);
          for (const turn of kept) if (turn.role === "agent" && turn.status === "running") logs.current.set(turn.id, turn.events);
        }
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
      const live = readActive(localStorage.getItem(ACTIVE_KEY));
      if (live) setActive(live);
      else localStorage.removeItem(ACTIVE_KEY);
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

  const setLog = useCallback(
    (turnId: string, events: AgentEvent[]) => {
      logs.current.set(turnId, events);
      patchTurn(turnId, (turn) => ({ ...turn, events }));
    },
    [patchTurn],
  );

  const settle = useCallback(
    (job: ActiveJob, patch: (turn: AgentTurnData) => AgentTurnData): boolean => {
      if (finished.current.has(job.jobId)) return false;
      finished.current.add(job.jobId);
      recovering.current.delete(job.jobId);
      patchTurn(job.turnId, patch);
      setActive((current) => (current?.jobId === job.jobId ? null : current));
      localStorage.removeItem(ACTIVE_KEY);
      return true;
    },
    [patchTurn],
  );

  // startSegment and finish call each other (a paused segment starts the next
  // one), so finish is reached through a ref.
  const finishRef = useRef<(job: ActiveJob, result: unknown) => void>(() => {});

  const startSegment = useCallback(
    async (job: ActiveJob, input: { task: string; files: DeskFile[]; harnesses: HarnessId[]; modules: DeskModule[]; journal: JournalItem[]; memory: string }) => {
      localStorage.setItem(ACTIVE_KEY, JSON.stringify(job));
      setActive(job);
      try {
        const result = await runDesk({ data: { ...input, jobId: job.jobId } });
        finishRef.current(job, result ?? null);
      } catch (caught) {
        if (isConnectionLoss(caught)) {
          // Keep polling: the server is likely still working and will hold the result.
          const said = caught instanceof Error ? caught.message : String(caught);
          recovering.current.set(job.jobId, { until: Date.now() + RECOVER_MS, message: `连接断开了（${said}），之后也没等到结果。工作区里写好的都还在；点「接着做」会从那里继续。` });
          return;
        }
        // A thrown string or a bare object is the gateway talking, not the desk.
        if (caught instanceof Error && caught.message.trim()) {
          finishRef.current(job, { ok: false, error: caught.message, files: input.files, steps: [], modules: input.modules, journal: input.journal, memory: input.memory });
        } else finishRef.current(job, typeof caught === "string" ? { error: caught } : caught);
      }
    },
    [],
  );

  const finish = useCallback(
    (job: ActiveJob, raw: unknown) => {
      if (finished.current.has(job.jobId)) return;
      if (!isDeskResult(raw)) {
        settle(job, (turn) => ({ ...turn, status: "failed", endedAt: Date.now(), text: brokenReplyText(raw, turn.at) }));
        return;
      }
      const result = raw;
      const nextFiles = result.files.filter(keepFile);
      setFiles(nextFiles);
      if (result.journal) setJournal(result.journal);
      if (typeof result.memory === "string") setMemory(result.memory);
      if (result.modules) setModules(result.modules);
      const touched = [...new Set(result.steps.filter((step) => nextFiles.some((item) => item.path === step.detail)).map((step) => step.detail))];
      if (touched.length) setSelected(touched[touched.length - 1] ?? "");
      else setSelected((current) => (nextFiles.some((item) => item.path === current) ? current : ""));
      const added = (result.journal ?? []).slice(journal.length);
      // Prefer the server's full log for this segment over what polling caught,
      // keeping the earlier segments' events in front of it.
      const current = logs.current.get(job.turnId) ?? [];
      const polled = current.slice(job.eventsBefore);
      const sent = shiftRounds(result.events ?? [], job.roundBase);
      const events = sent.length >= polled.length ? [...current.slice(0, job.eventsBefore), ...sent] : current;
      logs.current.set(job.turnId, events);
      // Carry on only if this segment got somewhere; a segment that spent its
      // whole budget without one completed step would just spin again.
      const carryOn = result.paused && job.segment < MAX_SEGMENTS && job.task.trim().length > 0 && progressed(sent);
      if (carryOn) {
        finished.current.add(job.jobId);
        patchTurn(job.turnId, (turn) => ({ ...turn, events, steps: result.steps, touched }));
        const next: ActiveJob = { jobId: uid("job"), turnId: job.turnId, resumed: false, task: job.task, segment: job.segment + 1, roundBase: lastRound(events), eventsBefore: events.length };
        void startSegment(next, { task: job.task, files: nextFiles, harnesses, modules: result.modules ?? [], journal: result.journal ?? [], memory: result.memory ?? "" });
        return;
      }
      logs.current.delete(job.turnId);
      settle(job, (turn) => {
        const text = result.ok ? result.answer : result.error;
        return {
          ...turn,
          text: result.paused && job.segment >= MAX_SEGMENTS ? `${text}\n已经连着做了 ${job.segment} 段，先停一下；点「接着做」继续。` : text,
          status: statusOf(result, events),
          endedAt: Date.now(),
          steps: result.steps,
          code: lastCode(added) || turn.code,
          touched,
          events,
        };
      });
    },
    [harnesses, journal.length, patchTurn, settle, startSegment],
  );
  finishRef.current = finish;

  useEffect(() => {
    if (!active) return;
    const job = active;
    let after = 0;
    let cancelled = false;
    let misses = 0;
    const giveUp = (text: string) => {
      recovering.current.delete(job.jobId);
      settle(job, (turn) => ({ ...turn, status: "failed", endedAt: Date.now(), text }));
    };
    const tick = async () => {
      const lost = recovering.current.get(job.jobId);
      if (lost && Date.now() > lost.until) {
        giveUp(lost.message);
        return;
      }
      try {
        const snapshot = await pollDesk({ data: { jobId: job.jobId, after } });
        if (cancelled) return;
        if (!snapshot.found) {
          misses += 1;
          if (job.resumed && misses >= 2) giveUp("页面刷新后，服务器已经不记得这次运行了。再发一次就好。");
          else if (lost && misses >= 4) giveUp(lost.message);
          return;
        }
        misses = 0;
        if (snapshot.events.length) {
          after = snapshot.events[snapshot.events.length - 1]?.seq ?? after;
          const fresh = shiftRounds(snapshot.events, job.roundBase);
          setLog(job.turnId, [...(logs.current.get(job.turnId) ?? []), ...fresh]);
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
  }, [active, finish, setLog, settle]);

  async function go(raw: string) {
    const text = raw.trim();
    if (!text || running) return;
    const job: ActiveJob = { jobId: uid("job"), turnId: uid("a"), resumed: false, task: text, segment: 1, roundBase: 0, eventsBefore: 0 };
    const at = Date.now();
    setTurns((current) => [
      ...current,
      { id: uid("u"), role: "user", text, at },
      { id: job.turnId, role: "agent", text: "", at, status: "running", jobId: job.jobId, events: [], steps: [], touched: [] },
    ]);
    setTask("");
    logs.current.set(job.turnId, []);
    await startSegment(job, { task: text, files, harnesses, modules, journal, memory });
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

  async function installFromFile(file: DeskFile): Promise<string | null> {
    const name = moduleNameFor(file.path);
    if (!name) return "这个文件名不能当 module 名。";
    const replacing = modules.some((mod) => mod.name === name);
    if (!replacing && modules.length >= MAX_MODULES) return `最多装 ${MAX_MODULES} 个，先卸下一个。`;
    try {
      const verdict = await installModule({ data: { name, body: file.content } });
      if (!verdict.ok) return verdict.error;
      setModules((current) => [...current.filter((mod) => mod.name !== name), verdict.module]);
      return null;
    } catch (caught) {
      return caught instanceof Error ? caught.message : "没装上。";
    }
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
  const loadedLine = modules.length ? ` · 已装 ${modules.map((mod) => mod.name).join("、")}` : "";
  const showExamples = turns.length === 0;
  const lastAgent = [...turns].reverse().find((turn): turn is AgentTurnData => turn.role === "agent");
  const continueFor = lastAgent && !running && unfinished(lastAgent) ? lastAgent.id : null;

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
              <p className="min-w-0 truncate text-xs text-muted">
                开着：{enabled.join(" · ")}
                {loadedLine}
              </p>
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
                      className="flex min-h-11 items-center gap-3 rounded-xl border border-border bg-bg px-3 py-2 text-left text-sm text-fg hover:border-primary disabled:opacity-50"
                    >
                      <item.icon className="h-4 w-4 shrink-0 text-muted" aria-hidden />
                      <span className="min-w-0 flex-1 break-words [overflow-wrap:anywhere]">{item.text}</span>
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
                  <p className="mt-2 max-w-xl text-sm leading-6 text-muted">每一步都写成一段 OCaml，编译通过才执行；搜了什么、写了什么、装了哪个 module，都会实时显示在这里。它还能把写好的代码或网上的库装成 harness，后面的步骤直接调用。</p>
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
                      className="flex min-h-11 items-center gap-3 rounded-xl border border-border bg-surface px-3 py-2 text-left text-sm text-fg hover:border-primary disabled:opacity-50"
                    >
                      <item.icon className="h-4 w-4 shrink-0 text-muted" aria-hidden />
                      <span className="min-w-0 flex-1 break-words [overflow-wrap:anywhere]">{item.text}</span>
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
                  <AgentTurn key={turn.id} turn={turn} onOpenFile={openFile} onContinue={turn.id === continueFor ? () => void go(CONTINUE_TEXT) : undefined} />
                ),
              )}
            </div>
          ))}
        </section>
      </main>

      <aside className="hidden border-l border-border bg-bg lg:block">
        <div className="sticky top-0 h-screen overflow-y-auto">
          <SidePanel harnesses={harnesses} setHarnesses={setHarnesses} modules={modules} setModules={setModules} onInstall={installFromFile} files={files} selected={selected} onSelect={setSelected} onReset={reset} busy={running} />
        </div>
      </aside>

      {panelOpen ? (
        <div className="fixed inset-0 z-30 lg:hidden">
          <button type="button" aria-label="收起工作区" onClick={() => setPanelOpen(false)} className="absolute inset-0 bg-black/50" />
          <div className="absolute inset-y-0 right-0 w-[min(22rem,100%)] overflow-y-auto border-l border-border bg-bg shadow-2xl">
            <SidePanel harnesses={harnesses} setHarnesses={setHarnesses} modules={modules} setModules={setModules} onInstall={installFromFile} files={files} selected={selected} onSelect={setSelected} onReset={reset} onClose={() => setPanelOpen(false)} busy={running} />
          </div>
        </div>
      ) : null}
    </div>
  );
}
