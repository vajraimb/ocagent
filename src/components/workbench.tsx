import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { ArrowUp, Blocks, FilePen, Globe, PackagePlus, PanelRight, Play, Search, Square } from "lucide-react";
import { AgentTurn, type AgentTurnData } from "@/components/agent-turn";
import { SidePanel } from "@/components/side-panel";
import { CATALOG, DEFAULT_HARNESSES, MAX_MODULES, checkModule, isHarnessId, moduleNameFor, type DeskModule, type HarnessId } from "@/lib/agent/harness";
import type { AgentEvent } from "@/lib/agent/progress";
import {
  clearDesk,
  continueRun,
  getRun,
  installFromUrl,
  installModule,
  loadDesk,
  pollRun,
  saveDesk,
  startRun,
  stopRun,
  type InstallVerdict,
  type PublicDesk,
  type RunRecord,
  type RunReply,
} from "@/lib/agent/run";
import type { DeskFile } from "@/lib/agent/workspace";

// The browser keeps only the desk's key and a cache for the first paint; the
// desk itself (files, harnesses, modules) and every run live on the server.
type Cache = { deskId: string; files: DeskFile[]; harnesses: HarnessId[]; modules: DeskModule[]; runs: RunRecord[] };

type LegacySaved = { files?: DeskFile[]; harnesses?: string[]; modules?: DeskModule[] };

const DESK_KEY = "ocagent-desk-id";
const CACHE_KEY = "ocagent-desk-v8";
const LEGACY_KEYS = ["ocagent-desk-v7", "ocagent-desk-v6", "ocagent-desk-v5"];
const PREFAB = new Set(["README.md", "src/math.ml", "src/greet.ml", "notes/todo.md"]);
const MAX_SEGMENTS = 6;
const RECOVER_MS = 120_000;
const RUNS_CACHED = 12;
const EVENTS_CACHED = 80;

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

function uid(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

function keepFile(file: DeskFile): boolean {
  const name = file.path.split("/").pop() ?? "";
  return !PREFAB.has(file.path) && !name.startsWith("ocagent_");
}

function isRun(value: unknown): value is RunRecord {
  if (!value || typeof value !== "object") return false;
  const run = value as Partial<RunRecord>;
  return typeof run.id === "string" && typeof run.task === "string" && typeof run.status === "string" && Array.isArray(run.events) && typeof run.createdAt === "number";
}

function readCache(raw: string | null): Cache | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<Cache>;
    if (typeof parsed.deskId !== "string") return null;
    return {
      deskId: parsed.deskId,
      files: Array.isArray(parsed.files) ? parsed.files.filter(keepFile) : [],
      harnesses: Array.isArray(parsed.harnesses) ? (parsed.harnesses as string[]).filter(isHarnessId) : DEFAULT_HARNESSES,
      modules: Array.isArray(parsed.modules)
        ? parsed.modules.flatMap((mod) => {
            const ok = mod && typeof mod.name === "string" && typeof mod.body === "string" ? checkModule(mod.name, mod.body) : null;
            return ok ? [{ ...ok, source: mod.source, at: mod.at }] : [];
          })
        : [],
      runs: Array.isArray(parsed.runs) ? parsed.runs.filter(isRun) : [],
    };
  } catch {
    return null;
  }
}

// An older page kept the whole desk in the browser; its files and modules move
// to the server, its chat history does not.
function readLegacy(): { files: DeskFile[]; harnesses: HarnessId[]; modules: DeskModule[] } | null {
  for (const key of LEGACY_KEYS) {
    const raw = localStorage.getItem(key);
    if (!raw) continue;
    try {
      const saved = JSON.parse(raw) as LegacySaved;
      const files = Array.isArray(saved.files) ? saved.files.filter(keepFile) : [];
      const harnesses = Array.isArray(saved.harnesses) ? saved.harnesses.map((id) => (id === "search" ? "web" : id)).filter(isHarnessId) : DEFAULT_HARNESSES;
      const modules = Array.isArray(saved.modules) ? saved.modules.flatMap((mod) => (mod && typeof mod.name === "string" && typeof mod.body === "string" ? (checkModule(mod.name, mod.body) ?? []) : [])) : [];
      for (const gone of LEGACY_KEYS) localStorage.removeItem(gone);
      return { files, harnesses: harnesses.length ? harnesses : DEFAULT_HARNESSES, modules };
    } catch {
      localStorage.removeItem(key);
    }
  }
  return null;
}

// A desk opened from a shared link replaces the one this browser had.
function chooseDeskId(): string {
  const url = new URL(window.location.href);
  const shared = url.searchParams.get("desk");
  if (shared && /^desk-[a-z0-9-]{8,48}$/.test(shared)) {
    localStorage.setItem(DESK_KEY, shared);
    url.searchParams.delete("desk");
    window.history.replaceState(null, "", url.toString());
    return shared;
  }
  const kept = localStorage.getItem(DESK_KEY);
  if (kept && /^desk-[a-z0-9-]{8,48}$/.test(kept)) return kept;
  const fresh = uid("desk");
  localStorage.setItem(DESK_KEY, fresh);
  return fresh;
}

function turnOf(run: RunRecord): AgentTurnData {
  return {
    id: run.id,
    role: "agent",
    text: run.result?.answer ?? "",
    at: run.createdAt,
    endedAt: run.endedAt ?? (run.status === "running" ? undefined : run.updatedAt),
    status: run.status,
    jobId: run.id,
    events: run.events,
    steps: run.result?.steps ?? [],
    touched: run.result?.touched ?? [],
    rounds: run.rounds,
  };
}

// Whether the latest segment got somewhere: a segment that spent its whole
// budget without one completed step would just spin again.
function segmentProgressed(run: RunRecord): boolean {
  const events = run.events;
  let start = 0;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    if (events[i]?.kind === "start") {
      start = i;
      break;
    }
  }
  return events.slice(start).some((event) => event.kind === "step" || event.kind === "effect");
}

function shouldCarryOn(run: RunRecord): boolean {
  return run.status === "paused" && run.segment < MAX_SEGMENTS && segmentProgressed(run);
}

// The newest run that stopped short of an answer gets a one-tap follow-up.
function unfinished(run: RunRecord): boolean {
  if (run.status === "stopped" || run.status === "failed" || run.status === "paused") return true;
  const last = [...run.events].reverse().find((event) => event.kind === "step");
  return last?.kind === "step" && last.reply === "partial";
}

// fetch() failed before any response: the connection dropped (phone locked,
// network changed, gateway reset). The server may well still be running.
function isConnectionLoss(caught: unknown): boolean {
  return caught instanceof TypeError || (caught instanceof Error && /load failed|failed to fetch|network/i.test(caught.message));
}

function brokenReplyText(caught: unknown, startedAt: number): string {
  const seconds = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
  let said = "";
  if (caught instanceof Error && caught.message.trim()) said = caught.message.trim().slice(0, 200);
  else if (typeof caught === "string" && caught.trim()) said = caught.trim().slice(0, 200);
  else if (caught && typeof caught === "object") {
    for (const key of ["error", "message", "detail"]) {
      const value = (caught as Record<string, unknown>)[key];
      if (typeof value === "string" && value.trim()) {
        said = value.trim().slice(0, 200);
        break;
      }
    }
  }
  return `连接在 ${seconds} 秒后断开了，结果没有完整传回来${said ? `（对方说：${said}）` : ""}。上面的过程还在，工作区里写好的也还在；点「接着做」会从那里继续。`;
}

function mergeEvents(current: AgentEvent[], incoming: AgentEvent[]): AgentEvent[] {
  if (!incoming.length) return current;
  const lastSeq = current.length ? (current[current.length - 1]?.seq ?? 0) : 0;
  const fresh = incoming.filter((event) => event.seq > lastSeq);
  return fresh.length ? [...current, ...fresh] : current;
}

export function Workbench() {
  const [task, setTask] = useState("");
  const [deskId, setDeskId] = useState("");
  const [harnesses, setHarnesses] = useState<HarnessId[]>(DEFAULT_HARNESSES);
  const [modules, setModules] = useState<DeskModule[]>([]);
  const [files, setFiles] = useState<DeskFile[]>([]);
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [selected, setSelected] = useState("");
  const [ready, setReady] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const [examplesOpen, setExamplesOpen] = useState(false);
  const [notice, setNotice] = useState("");
  // The run this page is driving (sending its segments and polling it).
  const [driving, setDriving] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  // Whether the server has this desk, and whether the page has changes it has
  // not stored yet (settings edited between runs).
  const synced = useRef(false);
  const dirty = useRef(false);
  const latest = useRef({ files, harnesses, modules });
  latest.current = { files, harnesses, modules };
  const finished = useRef(new Set<string>());
  // Runs whose request died mid-flight; polling keeps looking for them on the
  // server until the deadline, then they are marked failed with this message.
  const recovering = useRef(new Map<string, { until: number; message: string }>());
  const input = useRef<HTMLTextAreaElement>(null);
  // drive (send a segment) and absorb (take its reply) call each other — a
  // paused segment starts the next one — so each is reached through a ref.
  const absorbRef = useRef<(reply: RunReply) => void>(() => {});
  const driveRef = useRef<(runId: string, call: () => Promise<RunReply>) => Promise<void>>(async () => {});
  const live = runs.find((run) => run.status === "running") ?? null;
  const running = starting || live !== null || driving !== null;

  const patchRun = useCallback((runId: string, patch: (run: RunRecord) => RunRecord) => {
    setRuns((current) => current.map((run) => (run.id === runId ? patch(run) : run)));
  }, []);

  const absorbDesk = useCallback((desk: PublicDesk) => {
    setFiles(desk.files.filter(keepFile));
    setHarnesses(desk.harnesses.length ? desk.harnesses : DEFAULT_HARNESSES);
    setModules(desk.modules);
    synced.current = true;
    dirty.current = false;
  }, []);

  // Stores the page's settings on the server; creates the desk the first time.
  const sync = useCallback(async (): Promise<boolean> => {
    if (!deskId) return false;
    const snapshot = latest.current;
    try {
      const saved = await saveDesk({ data: { deskId, files: snapshot.files, harnesses: snapshot.harnesses, modules: snapshot.modules } });
      if (!saved.ok) {
        setNotice(saved.error);
        return false;
      }
      synced.current = true;
      if (latest.current === snapshot) dirty.current = false;
      setNotice("");
      return true;
    } catch (caught) {
      setNotice(`工作区没有存上：${caught instanceof Error ? caught.message : "连不上服务器"}`);
      return false;
    }
  }, [deskId]);

  const markDirty = useCallback(() => {
    dirty.current = true;
  }, []);

  useEffect(() => {
    const id = chooseDeskId();
    setDeskId(id);
    const cache = readCache(localStorage.getItem(CACHE_KEY));
    const legacy = cache ? null : readLegacy();
    if (cache && cache.deskId === id) {
      setFiles(cache.files);
      setHarnesses(cache.harnesses.length ? cache.harnesses : DEFAULT_HARNESSES);
      setModules(cache.modules);
      setRuns(cache.runs);
    } else if (legacy) {
      setFiles(legacy.files);
      setHarnesses(legacy.harnesses);
      setModules(legacy.modules);
      dirty.current = legacy.files.length > 0 || legacy.modules.length > 0;
    }
    setReady(true);
  }, []);

  // The server is the source of truth: once it answers, its desk and runs
  // replace the cache, and a run still going gets picked up again.
  useEffect(() => {
    if (!deskId) return;
    let cancelled = false;
    void (async () => {
      try {
        const loaded = await loadDesk({ data: { deskId } });
        if (cancelled) return;
        if (!loaded.found) {
          synced.current = false;
          // Nothing stored yet: whatever the browser brought along becomes the desk.
          if (dirty.current) void sync();
          return;
        }
        absorbDesk(loaded.desk);
        setRuns(loaded.runs);
        const open = loaded.runs.find((run) => run.status === "running" || run.status === "paused");
        if (open?.status === "running") setDriving(open.id);
        else if (open && shouldCarryOn(open)) void driveRef.current(open.id, () => continueRun({ data: { runId: open.id, after: 0 } }));
      } catch (caught) {
        if (!cancelled) setNotice(`读取工作区失败：${caught instanceof Error ? caught.message : "连不上服务器"}`);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [deskId, absorbDesk, sync]);

  useEffect(() => {
    if (!ready || !deskId) return;
    const cache: Cache = {
      deskId,
      files,
      harnesses,
      modules,
      runs: runs.slice(-RUNS_CACHED).map((run) => ({ ...run, events: run.events.slice(-EVENTS_CACHED) })),
    };
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
    } catch {
      /* storage full: the server copy is unaffected */
    }
  }, [ready, deskId, files, harnesses, modules, runs]);

  // Settings edited between runs are stored shortly after.
  useEffect(() => {
    if (!ready || !deskId || running || !dirty.current) return;
    const timer = window.setTimeout(() => void sync(), 600);
    return () => window.clearTimeout(timer);
  }, [ready, deskId, running, files, harnesses, modules, sync]);

  const settle = useCallback(
    (runId: string, patch: (run: RunRecord) => RunRecord) => {
      recovering.current.delete(runId);
      patchRun(runId, patch);
      setDriving((current) => (current === runId ? null : current));
    },
    [patchRun],
  );

  // A segment's reply: the desk as the server left it, the run as it stands,
  // and — when it only paused — the next segment.
  const drive = useCallback(async (runId: string, call: () => Promise<RunReply>) => {
    setDriving(runId);
    const startedAt = Date.now();
    try {
      const reply = await call();
      absorbRef.current(reply);
    } catch (caught) {
      if (isConnectionLoss(caught)) {
        // Keep polling: the server is likely still working and will hold the result.
        const said = caught instanceof Error ? caught.message : String(caught);
        recovering.current.set(runId, { until: Date.now() + RECOVER_MS, message: `连接断开了（${said}），之后也没等到结果。工作区里写好的都还在；点「接着做」会从那里继续。` });
        return;
      }
      const text = brokenReplyText(caught, startedAt);
      const plain = caught instanceof Error && caught.message.trim() ? caught.message : text;
      settle(runId, (run) => ({ ...run, status: "failed", endedAt: Date.now(), result: { ok: false, answer: plain, steps: run.result?.steps ?? [], touched: run.result?.touched ?? [] } }));
    }
  }, [settle]);
  driveRef.current = drive;

  const absorb = useCallback(
    (reply: RunReply) => {
      const key = `${reply.run.id}:${reply.run.segment}:${reply.run.status}`;
      if (finished.current.has(key)) return;
      finished.current.add(key);
      absorbDesk(reply.desk);
      recovering.current.delete(reply.run.id);
      // A segment that only paused is followed by the next one right away, so
      // the page keeps showing the run as live rather than flashing "没做完".
      const carryOn = shouldCarryOn(reply.run);
      setRuns((current) => {
        const known = current.find((run) => run.id === reply.run.id);
        const events = known && known.events.length > reply.run.events.length ? known.events : reply.run.events;
        const merged: RunRecord = { ...reply.run, events, ...(carryOn ? { status: "running" as const } : {}) };
        return known ? current.map((run) => (run.id === reply.run.id ? merged : run)) : [...current, merged];
      });
      const touched = reply.run.result?.touched ?? [];
      if (touched.length) setSelected(touched[touched.length - 1] ?? "");
      else setSelected((current) => (reply.desk.files.some((item) => item.path === current) ? current : ""));
      if (reply.run.status === "running") return;
      if (carryOn) {
        void driveRef.current(reply.run.id, () => continueRun({ data: { runId: reply.run.id, after: 0 } }));
        return;
      }
      setDriving((current) => (current === reply.run.id ? null : current));
    },
    [absorbDesk],
  );
  absorbRef.current = absorb;

  useEffect(() => {
    if (!driving) return;
    const runId = driving;
    let after = 0;
    let cancelled = false;
    let misses = 0;
    const giveUp = (text: string) => settle(runId, (run) => ({ ...run, status: "failed", endedAt: Date.now(), result: { ok: false, answer: text, steps: run.result?.steps ?? [], touched: run.result?.touched ?? [] } }));
    const tick = async () => {
      const lost = recovering.current.get(runId);
      if (lost && Date.now() > lost.until) {
        giveUp(lost.message);
        return;
      }
      try {
        const snapshot = await pollRun({ data: { runId, after } });
        if (cancelled) return;
        if (!snapshot.found) {
          misses += 1;
          if (misses >= 8) giveUp(lost?.message ?? "服务器上找不到这次运行了。再发一次就好。");
          return;
        }
        misses = 0;
        if (snapshot.events.length) {
          after = snapshot.events[snapshot.events.length - 1]?.seq ?? after;
          const fresh = snapshot.events;
          patchRun(runId, (run) => ({ ...run, events: mergeEvents(run.events, fresh) }));
        }
        if (snapshot.done && snapshot.reply) absorbRef.current(snapshot.reply);
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
  }, [driving, patchRun, settle]);

  async function go(raw: string) {
    const text = raw.trim();
    if (!text || running || !deskId) return;
    setStarting(true);
    try {
      if (!synced.current || dirty.current) {
        const ok = await sync();
        if (!ok) return;
      }
      const runId = uid("run");
      const now = Date.now();
      setRuns((current) => [...current, { id: runId, deskId, task: text, status: "running", segment: 1, rounds: 0, events: [], result: null, stopRequested: false, createdAt: now, updatedAt: now, endedAt: null }]);
      setTask("");
      await drive(runId, () => startRun({ data: { deskId, runId, task: text } }));
    } finally {
      setStarting(false);
    }
  }

  async function stop() {
    const target = driving ?? live?.id ?? null;
    if (!target) return;
    try {
      const outcome = await stopRun({ data: { runId: target, after: 0 } });
      if (outcome.stopped) return;
    } catch {
      /* fall through to the local stop */
    }
    settle(target, (run) => ({ ...run, status: "stopped", endedAt: Date.now(), result: { ok: true, answer: "已停止查看。这一步可能还在后台跑完，结果不会再显示。", steps: run.result?.steps ?? [], touched: run.result?.touched ?? [] } }));
  }

  function resumeRun(runId: string) {
    if (running) return;
    void drive(runId, () => continueRun({ data: { runId, after: 0 } }));
  }

  async function expandRun(runId: string) {
    try {
      const run = await getRun({ data: { runId, after: 0 } });
      if (run) patchRun(runId, (current) => ({ ...current, events: run.events.length ? run.events : current.events }));
    } catch {
      /* the summary line stays; the timeline just is not available */
    }
  }

  function acceptModule(verdict: InstallVerdict): string | null {
    if (!verdict.ok) return verdict.error;
    setModules((current) => [...current.filter((mod) => mod.name !== verdict.module.name), verdict.module]);
    markDirty();
    return null;
  }

  async function installFromFile(file: DeskFile): Promise<string | null> {
    const name = moduleNameFor(file.path);
    if (!name) return "这个文件名不能当 module 名。";
    const replacing = modules.some((mod) => mod.name === name);
    if (!replacing && modules.length >= MAX_MODULES) return `最多装 ${MAX_MODULES} 个，先卸下一个。`;
    try {
      return acceptModule(await installModule({ data: { name, body: file.content, context: modules.filter((mod) => mod.name !== name), source: file.path } }));
    } catch (caught) {
      return caught instanceof Error ? caught.message : "没装上。";
    }
  }

  async function installUrl(name: string | null, url: string): Promise<string | null> {
    const others = modules.filter((mod) => mod.name !== name);
    if (!name && modules.length >= MAX_MODULES) return `最多装 ${MAX_MODULES} 个，先卸下一个。`;
    if (name && !modules.some((mod) => mod.name === name) && modules.length >= MAX_MODULES) return `最多装 ${MAX_MODULES} 个，先卸下一个。`;
    try {
      return acceptModule(await installFromUrl({ data: { name, url, context: others } }));
    } catch (caught) {
      return caught instanceof Error ? caught.message : "没装上。";
    }
  }

  async function importModule(mod: DeskModule): Promise<string | null> {
    if (!modules.some((item) => item.name === mod.name) && modules.length >= MAX_MODULES) return `最多装 ${MAX_MODULES} 个，先卸下一个。`;
    try {
      return acceptModule(await installModule({ data: { name: mod.name, body: mod.body, context: modules.filter((item) => item.name !== mod.name), source: mod.source } }));
    } catch (caught) {
      return caught instanceof Error ? caught.message : "没装上。";
    }
  }

  function changeHarnesses(next: HarnessId[]) {
    setHarnesses(next);
    markDirty();
  }

  function changeModules(next: DeskModule[]) {
    setModules(next);
    markDirty();
  }

  async function reset() {
    if (running || !deskId) return;
    try {
      const cleared = await clearDesk({ data: { deskId } });
      if (!cleared.ok) {
        setNotice(cleared.error);
        return;
      }
      absorbDesk(cleared.desk);
    } catch (caught) {
      setNotice(`没清空：${caught instanceof Error ? caught.message : "连不上服务器"}`);
      return;
    }
    setRuns((current) => current.filter((run) => run.status === "running"));
    setSelected("");
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
  const showExamples = runs.length === 0;
  const lastRun = runs[runs.length - 1];
  const continueFor = lastRun && !running && unfinished(lastRun) ? lastRun : null;
  const shareUrl = deskId && typeof window !== "undefined" ? `${window.location.origin}/?desk=${deskId}` : "";

  const panel = (onClose?: () => void) => (
    <SidePanel
      harnesses={harnesses}
      setHarnesses={changeHarnesses}
      modules={modules}
      setModules={changeModules}
      onInstall={installFromFile}
      onInstallUrl={installUrl}
      onImport={importModule}
      files={files}
      selected={selected}
      onSelect={setSelected}
      onReset={() => void reset()}
      onClose={onClose}
      shareUrl={shareUrl}
      busy={running}
    />
  );

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
              {runs.length > 0 ? (
                <button type="button" onClick={() => setExamplesOpen((open) => !open)} className="shrink-0 text-xs text-fg">
                  {examplesOpen ? "收起示例" : "试试"}
                </button>
              ) : null}
            </div>
            {notice ? <p className="mt-1.5 px-1 text-xs leading-5 text-warn">{notice}</p> : null}
            {runs.length > 0 && examplesOpen ? (
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
            <div className="flex flex-1 flex-col justify-center gap-6 py-6">
              <div>
                <h2 className="text-2xl font-semibold text-fg">说一件事，它去做。</h2>
                <p className="mt-2 max-w-xl text-sm leading-6 text-muted">每一步都写成一段 OCaml，编译通过才执行；搜了什么、写了什么、装了哪个 module，都会实时显示在这里。工作区和装好的 harness 存在服务器上，换个设备打开同一个工作区链接也能接着用。</p>
              </div>
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

          {[...runs].reverse().map((run) => (
            <div key={run.id} className="flex flex-col gap-5">
              <article className="ml-10 select-text self-end rounded-2xl bg-raised px-4 py-3">
                <p className="whitespace-pre-wrap text-[15px] leading-7 text-fg">{run.task}</p>
              </article>
              <AgentTurn
                turn={turnOf(run)}
                onOpenFile={openFile}
                onExpand={run.events.length === 0 && run.rounds > 0 ? () => void expandRun(run.id) : undefined}
                onContinue={continueFor?.id === run.id ? () => (run.status === "paused" ? resumeRun(run.id) : void go(CONTINUE_TEXT)) : undefined}
              />
            </div>
          ))}
        </section>
      </main>

      <aside className="hidden border-l border-border bg-bg lg:block">
        <div className="sticky top-0 h-screen overflow-y-auto">{panel()}</div>
      </aside>

      {panelOpen ? (
        <div className="fixed inset-0 z-30 lg:hidden">
          <button type="button" aria-label="收起工作区" onClick={() => setPanelOpen(false)} className="absolute inset-0 bg-black/50" />
          <div className="absolute inset-y-0 right-0 w-[min(22rem,100%)] overflow-y-auto border-l border-border bg-bg shadow-2xl">{panel(() => setPanelOpen(false))}</div>
        </div>
      ) : null}
    </div>
  );
}
