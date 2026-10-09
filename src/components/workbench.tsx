import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { ArrowUp, Bell, Blocks, CalendarClock, FilePen, Globe, PackagePlus, PanelRight, Play, Search, Square, X } from "lucide-react";
import { AgentTurn, type AgentTurnData } from "@/components/agent-turn";
import { SidePanel } from "@/components/side-panel";
import { CATALOG, DEFAULT_HARNESSES, MAX_MODULES, checkModule, isHarnessId, moduleNameFor, type DeskModule, type HarnessId } from "@/lib/agent/harness";
import type { AgentEvent } from "@/lib/agent/progress";
import {
  MAX_FILE_BYTES,
  MAX_WORKSPACE_BYTES,
  carriesOn,
  clearDesk,
  continueRun,
  getRun,
  installFromUrl,
  installModule,
  loadDesk,
  pollRun,
  removeSchedule,
  saveDesk,
  setNotify,
  startRun,
  stopRun,
  tryNotify,
  type InstallVerdict,
  type NotifyInfo,
  type PublicDesk,
  type RunRecord,
  type RunReply,
  type ScheduleRecord,
} from "@/lib/agent/run";
import { describeWhen } from "@/lib/agent/schedule";
import { MAX_FILES, batchPuts, fileDelta, isImageFile, isScratchFile, safePath, type DeskFile } from "@/lib/agent/workspace";

// The browser keeps only the desk's key and a cache for the first paint; the
// desk itself (files, harnesses, modules) and every run live on the server.
type Cache = { deskId: string; files: DeskFile[]; harnesses: HarnessId[]; modules: DeskModule[]; notes: string[]; runs: RunRecord[] };

type LegacySaved = { files?: DeskFile[]; harnesses?: string[]; modules?: DeskModule[] };

const DESK_KEY = "ocagent-desk-id";
// When this browser last looked at the desk's scheduled results (per desk).
const SEEN_KEY = "ocagent-seen";
const CACHE_KEY = "ocagent-desk-v8";
const LEGACY_KEYS = ["ocagent-desk-v7", "ocagent-desk-v6", "ocagent-desk-v5"];
const PREFAB = new Set(["README.md", "src/math.ml", "src/greet.ml", "notes/todo.md"]);
const RECOVER_MS = 120_000;
// How long the page waits for the server to continue a paused run on its own.
const CARRY_GRACE_MS = 8_000;
const RUNS_CACHED = 12;
const EVENTS_CACHED = 80;

const EXAMPLES = [
  { icon: Search, text: "查一下东京现在的天气，用一句话告诉我。" },
  { icon: Blocks, text: "写一个 src/fib.ml，里面有 fib n，装成 harness，再用它算 fib 30。" },
  { icon: PackagePlus, text: "把 https://raw.githubusercontent.com/ocaml/ocaml/trunk/stdlib/option.ml 装成 Myopt，然后用 Myopt.value 试一下。" },
  { icon: Globe, text: "请求 https://example.com，把页面标题记下来。" },
];

const ABILITIES = [
  { icon: FilePen, title: "读写文件", body: "读你放进工作区的文件；新建、修改、查找。" },
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
  return !PREFAB.has(file.path) && !name.startsWith("ocagent_") && !isScratchFile(file.path);
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
      notes: Array.isArray(parsed.notes) ? parsed.notes.filter((note): note is string => typeof note === "string") : [],
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

function isPicture(item: File): boolean {
  return item.type.startsWith("image/") || /\.(jpe?g|png|webp|gif|bmp|heic|heif)$/i.test(item.name);
}

// The longest edge a picture is shrunk to, and the biggest encoded size that
// fits a file slot (base64 grows it by a third) and a model call.
const PICTURE_EDGE = 1024;
const PICTURE_MAX_CHARS = 360_000;

// Re-encodes a picture as a JPEG data URL small enough for the workspace.
async function shrinkPicture(item: File): Promise<string | null> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(item);
  } catch {
    return null;
  }
  try {
    const scale = Math.min(1, PICTURE_EDGE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    for (const quality of [0.85, 0.75, 0.65, 0.5, 0.4]) {
      const url = canvas.toDataURL("image/jpeg", quality);
      if (url.length <= PICTURE_MAX_CHARS) return url;
    }
    // Still too big: halve the edge and try once more.
    const half = document.createElement("canvas");
    half.width = Math.max(1, Math.round(canvas.width / 2));
    half.height = Math.max(1, Math.round(canvas.height / 2));
    half.getContext("2d")?.drawImage(canvas, 0, 0, half.width, half.height);
    const url = half.toDataURL("image/jpeg", 0.6);
    return url.length <= PICTURE_MAX_CHARS ? url : null;
  } finally {
    bitmap.close();
  }
}

// The path a dropped or picked file gets: its folder path when a folder was
// dropped, otherwise just the name; spaces become underscores.
function filePathFor(item: File): string {
  const rel = "webkitRelativePath" in item && typeof item.webkitRelativePath === "string" && item.webkitRelativePath ? item.webkitRelativePath : item.name;
  return rel.replace(/\s+/g, "_");
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
    plan: run.result?.plan?.items,
    asked: run.result?.asked,
  };
}

// The newest run that stopped short of an answer gets a one-tap follow-up.
// The badge over a run a schedule started: its time when the schedule is still
// around, plainly "定时任务" once it has been cancelled.
function scheduleLabel(run: RunRecord, schedules: ScheduleRecord[]): string {
  const from = schedules.find((item) => item.lastRunId === run.id);
  return from ? `定时任务 · ${describeWhen(from.time, from.tz)}` : "定时任务 · 到点自动开始";
}

function seenKey(deskId: string): string {
  return `${SEEN_KEY}:${deskId}`;
}

function readSeen(deskId: string): number {
  const raw = Number(localStorage.getItem(seenKey(deskId)));
  return Number.isFinite(raw) ? raw : 0;
}

/** Scheduled runs that finished since this browser last looked, newest first. */
function unseenScheduled(runs: RunRecord[], seen: number): RunRecord[] {
  return runs.filter((run) => run.trigger === "schedule" && run.status !== "running" && (run.endedAt ?? run.updatedAt) > seen).reverse();
}

function unfinished(run: RunRecord): boolean {
  if (run.status === "stopped" || run.status === "failed" || run.status === "paused") return true;
  const last = [...run.events].reverse().find((event) => event.kind === "step");
  // A Partial because the task asked for something it cannot do: trying again changes nothing.
  if (last?.kind === "step" && run.events.some((event) => event.kind === "limit" && event.round === last.round)) return false;
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
  // What the agent has remembered about this desk (Memory.remember).
  const [notes, setNotes] = useState<string[]>([]);
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [schedules, setSchedules] = useState<ScheduleRecord[]>([]);
  const [notify, setNotifyInfo] = useState<NotifyInfo | null>(null);
  // Scheduled results this browser has not looked at yet (a timestamp per desk).
  const [seen, setSeen] = useState(Number.MAX_SAFE_INTEGER);
  const [selected, setSelected] = useState("");
  const [ready, setReady] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const [examplesOpen, setExamplesOpen] = useState(false);
  const [notice, setNotice] = useState("");
  // False when the server keeps desks only in its embedded database (no Neon):
  // everything still works, but nothing outlives that instance.
  const [durable, setDurable] = useState(true);
  // The run this page is driving (sending its segments and polling it).
  const [driving, setDriving] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  // Whether the server has this desk, and whether the page has changes it has
  // not stored yet (settings edited between runs).
  const synced = useRef(false);
  const dirty = useRef(false);
  const latest = useRef({ files, harnesses, modules, notes });
  latest.current = { files, harnesses, modules, notes };
  const finished = useRef(new Set<string>());
  // Runs whose request died mid-flight; polling keeps looking for them on the
  // server until the deadline, then they are marked failed with this message.
  const recovering = useRef(new Map<string, { until: number; message: string }>());
  // Runs that paused for time: the server continues them by itself, and the
  // page watches; if the next segment has not shown up after a grace period,
  // the page asks for it (whoever asks first gets it, so this is safe).
  const awaiting = useRef(new Map<string, { segment: number; since: number }>());
  const input = useRef<HTMLTextAreaElement>(null);
  // drive (send a segment) and absorb (take its reply) call each other — a
  // paused segment the server did not pick up starts the next one — so each
  // is reached through a ref.
  const absorbRef = useRef<(reply: RunReply) => void>(() => {});
  const driveRef = useRef<(runId: string, call: () => Promise<RunReply>) => Promise<void>>(async () => {});
  const live = runs.find((run) => run.status === "running") ?? null;
  const running = starting || live !== null || driving !== null;

  const patchRun = useCallback((runId: string, patch: (run: RunRecord) => RunRecord) => {
    setRuns((current) => current.map((run) => (run.id === runId ? patch(run) : run)));
  }, []);

  // What the server is known to hold, so a save sends only the difference.
  const stored = useRef<{ files: Map<string, string>; modules: DeskModule[] | null }>({ files: new Map(), modules: null });
  // Saves that failed on the connection are retried with growing pauses.
  const saveAttempts = useRef(0);
  const [retryTick, setRetryTick] = useState(0);

  const absorbDesk = useCallback((desk: PublicDesk) => {
    const kept = desk.files.filter(keepFile);
    setFiles(kept);
    setHarnesses(desk.harnesses.length ? desk.harnesses : DEFAULT_HARNESSES);
    setModules(desk.modules);
    setNotes(desk.notes ?? []);
    setNotifyInfo(desk.notify ?? null);
    stored.current = { files: new Map(kept.map((file) => [file.path, file.content])), modules: desk.modules };
    synced.current = true;
    dirty.current = false;
  }, []);

  // Stores the page's settings on the server as changes (new or edited files,
  // removed paths, modules when they changed); creates the desk the first time.
  const saveFailed = useRef(false);
  const sync = useCallback(async (): Promise<boolean> => {
    if (!deskId) return false;
    const snapshot = latest.current;
    const delta = fileDelta(stored.current.files, snapshot.files);
    const modulesChanged = stored.current.modules !== snapshot.modules;
    const batches = batchPuts(delta.put);
    const requests = batches.length ? batches : [[]];
    try {
      for (const [index, put] of requests.entries()) {
        const last = index === requests.length - 1;
        const saved = await saveDesk({
          data: { deskId, harnesses: snapshot.harnesses, notes: snapshot.notes, modules: modulesChanged ? snapshot.modules : undefined, put, remove: last ? delta.remove : [] },
        });
        if (!saved.ok) {
          saveFailed.current = true;
          setNotice(saved.error);
          return false;
        }
        for (const file of put) stored.current.files.set(file.path, file.content);
        if (last) {
          for (const path of delta.remove) stored.current.files.delete(path);
          if (modulesChanged) stored.current.modules = snapshot.modules;
        }
      }
      synced.current = true;
      saveAttempts.current = 0;
      if (latest.current === snapshot) dirty.current = false;
      // Only a save error of our own is cleared here; other notices stay.
      if (saveFailed.current) {
        saveFailed.current = false;
        setNotice("");
      }
      return true;
    } catch (caught) {
      saveFailed.current = true;
      if (isConnectionLoss(caught)) {
        // The connection dropped (phone locked, network changed): what went up
        // in earlier batches is kept; the rest goes again after a pause.
        saveAttempts.current += 1;
        const wait = Math.min(20_000, 2_000 * 2 ** (saveAttempts.current - 1));
        setNotice(`工作区还没存上：网络断了一下，${Math.round(wait / 1000)} 秒后再试。`);
        window.setTimeout(() => setRetryTick((tick) => tick + 1), wait);
      } else {
        setNotice(`工作区没有存上：${caught instanceof Error ? caught.message : "连不上服务器"}`);
      }
      return false;
    }
  }, [deskId]);

  const markDirty = useCallback(() => {
    dirty.current = true;
  }, []);

  useEffect(() => {
    const id = chooseDeskId();
    setDeskId(id);
    setSeen(readSeen(id));
    const cache = readCache(localStorage.getItem(CACHE_KEY));
    const legacy = cache ? null : readLegacy();
    if (cache && cache.deskId === id) {
      setFiles(cache.files);
      setHarnesses(cache.harnesses.length ? cache.harnesses : DEFAULT_HARNESSES);
      setModules(cache.modules);
      setNotes(cache.notes);
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
        setDurable(loaded.durable);
        if (!loaded.found) {
          synced.current = false;
          // Nothing stored yet: whatever the browser brought along becomes the desk.
          if (dirty.current) void sync();
          return;
        }
        absorbDesk(loaded.desk);
        setRuns(loaded.runs);
        setSchedules(loaded.schedules);
        const open = loaded.runs.find((run) => run.status === "running" || run.status === "paused");
        if (open?.status === "running") setDriving(open.id);
        else if (open && carriesOn(open)) {
          awaiting.current.set(open.id, { segment: open.segment, since: Date.now() });
          setDriving(open.id);
        }
      } catch (caught) {
        if (!cancelled) setNotice(`读取工作区失败：${caught instanceof Error ? caught.message : "连不上服务器"}`);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [deskId, absorbDesk, sync]);

  // A desk with schedules gets runs it did not start from this page: when one
  // is due, and when the page comes back to the foreground, ask the server
  // again so the new run (and the run it is in the middle of) shows up.
  useEffect(() => {
    if (!deskId || running || schedules.length === 0) return;
    let cancelled = false;
    const refresh = async () => {
      try {
        const loaded = await loadDesk({ data: { deskId } });
        if (cancelled || !loaded.found) return;
        setSchedules(loaded.schedules);
        setRuns((current) => (loaded.runs.length >= current.length ? loaded.runs : current));
        // A scheduled run that already finished changed the files; take the
        // server's copy unless this page has edits of its own waiting.
        if (!dirty.current) absorbDesk(loaded.desk);
        const open = loaded.runs.find((run) => run.status === "running");
        if (open) setDriving(open.id);
      } catch {
        /* the next due time or visit tries again */
      }
    };
    const soonest = Math.min(...schedules.map((item) => item.nextAt));
    // A little after the due time, so the server's wake-up has started the run.
    const overdue = Date.now() - soonest;
    const wait = overdue > 600_000 ? 60_000 : Math.min(6 * 3_600_000, Math.max(5_000, 8_000 - overdue));
    const timer = window.setTimeout(() => void refresh(), wait);
    const onVisible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [deskId, running, schedules, absorbDesk]);

  useEffect(() => {
    if (!ready || !deskId) return;
    const cache: Cache = {
      deskId,
      files,
      harnesses,
      modules,
      notes,
      runs: runs.slice(-RUNS_CACHED).map((run) => ({ ...run, events: run.events.slice(-EVENTS_CACHED) })),
    };
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
    } catch {
      /* storage full: the server copy is unaffected */
    }
  }, [ready, deskId, files, harnesses, modules, notes, runs]);

  // Settings edited between runs are stored shortly after; a save that lost
  // its connection is tried again (retryTick), and when the page comes back
  // to the foreground or the network returns.
  useEffect(() => {
    if (!ready || !deskId || running || !dirty.current) return;
    const timer = window.setTimeout(() => void sync(), 600);
    return () => window.clearTimeout(timer);
  }, [ready, deskId, running, files, harnesses, modules, notes, retryTick, sync]);

  useEffect(() => {
    const again = () => {
      if (dirty.current && document.visibilityState === "visible") setRetryTick((tick) => tick + 1);
    };
    document.addEventListener("visibilitychange", again);
    window.addEventListener("online", again);
    return () => {
      document.removeEventListener("visibilitychange", again);
      window.removeEventListener("online", again);
    };
  }, []);

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
      if (reply.schedules) setSchedules(reply.schedules);
      recovering.current.delete(reply.run.id);
      // A segment that only paused is followed by the next one right away, so
      // the page keeps showing the run as live rather than flashing "没做完".
      const carryOn = carriesOn(reply.run);
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
        awaiting.current.set(reply.run.id, { segment: reply.run.segment, since: Date.now() });
        return;
      }
      awaiting.current.delete(reply.run.id);
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
        if (!snapshot.done) {
          awaiting.current.delete(runId);
          return;
        }
        if (!snapshot.reply) return;
        const waiting = awaiting.current.get(runId);
        if (waiting && snapshot.reply.run.status === "paused" && snapshot.reply.run.segment === waiting.segment) {
          // Still paused where we left it: give the server its grace, then ask.
          if (Date.now() - waiting.since >= CARRY_GRACE_MS) {
            awaiting.current.delete(runId);
            void driveRef.current(runId, () => continueRun({ data: { runId, after: 0 } }));
          }
          return;
        }
        absorbRef.current(snapshot.reply);
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
      setRuns((current) => [...current, { id: runId, deskId, task: text, trigger: "user", status: "running", segment: 1, rounds: 0, events: [], result: null, stopRequested: false, createdAt: now, updatedAt: now, endedAt: null }]);
      setTask("");
      if (unseen.length) markSeen();
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
    awaiting.current.delete(runId);
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

  // Files the user brings in (picker or drop): text only, same caps as a run.
  async function addFiles(list: FileList | File[]) {
    if (running) {
      setNotice("它还在做上一件事，做完再加文件。");
      return;
    }
    const incoming = Array.from(list);
    if (incoming.length === 0) return;
    const refused: string[] = [];
    const accepted: DeskFile[] = [];
    for (const item of incoming) {
      if (isPicture(item)) {
        // Pictures are shrunk here so they fit a file slot and a model call.
        const picture = await shrinkPicture(item);
        if (!picture) {
          refused.push(`${item.name}：这张图读不出来（HEIC 等格式请先转成 JPG）`);
          continue;
        }
        const path = filePathFor(item).replace(/\.[^.]+$/, "") + ".jpg";
        if (!safePath(path)) {
          refused.push(`${item.name}：名字只能用字母、数字、点、下划线和横线`);
          continue;
        }
        accepted.push({ path, content: picture });
        continue;
      }
      const path = filePathFor(item);
      if (!safePath(path)) {
        refused.push(`${item.name}：名字只能用字母、数字、点、下划线和横线`);
        continue;
      }
      if (item.size > MAX_FILE_BYTES) {
        refused.push(`${item.name}：${Math.round(item.size / 1024)} KB，单个最多 ${MAX_FILE_BYTES / 1024} KB`);
        continue;
      }
      const content = await item.text();
      if (content.includes("\u0000")) {
        refused.push(`${item.name}：看起来是二进制文件，只收文本和图片`);
        continue;
      }
      accepted.push({ path, content });
    }
    const merged = [...files.filter((file) => !accepted.some((next) => next.path === file.path)), ...accepted];
    const total = merged.reduce((sum, file) => sum + new TextEncoder().encode(file.content).length, 0);
    if (merged.length > MAX_FILES) {
      setNotice(`工作区最多 ${MAX_FILES} 个文件，现在会有 ${merged.length} 个；先删掉一些。`);
      return;
    }
    if (total > MAX_WORKSPACE_BYTES) {
      setNotice(`加上这些工作区会有 ${(total / 1024 / 1024).toFixed(1)} MB，最多 ${MAX_WORKSPACE_BYTES / 1024 / 1024} MB。`);
      return;
    }
    if (accepted.length) {
      setFiles(merged);
      markDirty();
      setSelected(accepted[accepted.length - 1]?.path ?? "");
    }
    const replaced = accepted.filter((next) => files.some((file) => file.path === next.path)).length;
    const pictures = accepted.filter(isImageFile).length;
    const parts = [];
    if (accepted.length) parts.push(`加了 ${accepted.length} 个文件${pictures ? `（${pictures} 张图片，它每一轮都能直接看到）` : ""}${replaced ? `（覆盖 ${replaced} 个同名）` : ""}`);
    if (refused.length) parts.push(`没收：${refused.join("；")}`);
    setNotice(parts.join("。"));
  }

  function removeFile(path: string) {
    if (running) return;
    setFiles((current) => current.filter((file) => file.path !== path));
    if (selected === path) setSelected("");
    markDirty();
  }

  function forgetNote(index: number) {
    if (running) return;
    setNotes((current) => current.filter((_, at) => at !== index));
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

  function markSeen() {
    if (!deskId) return;
    const now = Date.now();
    localStorage.setItem(seenKey(deskId), String(now));
    setSeen(now);
  }

  function showUnseen() {
    const [newest] = unseenScheduled(runs, seen);
    markSeen();
    if (newest) document.getElementById(`run-${newest.id}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  async function changeNotify(url: string): Promise<string | null> {
    if (!deskId) return "工作区还没准备好。";
    try {
      const saved = await setNotify({ data: { deskId, url } });
      if (!saved.ok) return saved.error;
      setNotifyInfo(saved.notify);
      synced.current = true;
      return null;
    } catch (caught) {
      return `没存上：${caught instanceof Error ? caught.message : "连不上服务器"}`;
    }
  }

  async function testNotify(): Promise<string> {
    if (!deskId) return "工作区还没准备好。";
    try {
      const tried = await tryNotify({ data: { deskId } });
      return tried.ok ? `发出去了，去${tried.where}看一眼。` : tried.error;
    } catch (caught) {
      return `没发成：${caught instanceof Error ? caught.message : "连不上服务器"}`;
    }
  }

  async function unschedule(scheduleId: string) {
    if (!deskId) return;
    try {
      const outcome = await removeSchedule({ data: { deskId, scheduleId } });
      setSchedules(outcome.schedules);
    } catch (caught) {
      setNotice(`没取消：${caught instanceof Error ? caught.message : "连不上服务器"}`);
    }
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
  const awaitingReply = Boolean(lastRun && !running && lastRun.status === "done" && lastRun.result?.asked);
  const shareUrl = deskId && typeof window !== "undefined" ? `${window.location.origin}/?desk=${deskId}` : "";
  const unseen = unseenScheduled(runs, seen);

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
      durable={durable}
      onAddFiles={(list) => void addFiles(list)}
      onRemoveFile={removeFile}
      notes={notes}
      onForget={forgetNote}
      schedules={schedules}
      onUnschedule={(id) => void unschedule(id)}
      notify={notify}
      onSetNotify={changeNotify}
      onTryNotify={testNotify}
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
                  placeholder={running ? "它还在做，做完再说下一件。" : awaitingReply ? "它在等你回答，接着说就行" : runs.length > 0 ? "接着说，或说下一件事" : "说一件要做完的事"}
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
            {unseen.length > 0 ? (
              <div className="mt-2 flex items-center gap-2 rounded-xl border border-accent/40 bg-accent/10 px-3 py-2 text-xs leading-5 text-fg">
                <Bell className="h-3.5 w-3.5 shrink-0 text-accent" aria-hidden />
                <span className="min-w-0 flex-1">
                  有 {unseen.length} 个定时结果你还没看过
                  {unseen.length === 1 && unseen[0] ? `：${scheduleLabel(unseen[0], schedules).replace(/^定时任务 · /, "")}` : ""}
                </span>
                <button type="button" onClick={showUnseen} className="shrink-0 rounded-md bg-accent px-2 py-0.5 text-xs font-medium text-bg">
                  去看看
                </button>
                <button type="button" onClick={markSeen} aria-label="知道了" className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted hover:text-fg">
                  <X className="h-3.5 w-3.5" aria-hidden />
                </button>
              </div>
            ) : null}
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
            <div key={run.id} id={`run-${run.id}`} className="flex scroll-mt-40 flex-col gap-5">
              <article className="ml-10 select-text self-end rounded-2xl bg-raised px-4 py-3">
                {run.trigger === "schedule" ? (
                  <p className="mb-1 flex items-center gap-1.5 font-mono text-[11px] tracking-wide text-muted">
                    <CalendarClock className="h-3.5 w-3.5" aria-hidden />
                    {scheduleLabel(run, schedules)}
                    {unseen.some((item) => item.id === run.id) ? <span className="rounded bg-accent/15 px-1 text-accent">新</span> : null}
                  </p>
                ) : null}
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
