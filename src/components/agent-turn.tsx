import { useEffect, useState, type ReactNode } from "react";
import {
  Blocks,
  Braces,
  Brain,
  CalendarClock,
  Check,
  ChevronDown,
  ChevronRight,
  Clock,
  CornerDownRight,
  FilePen,
  FileText,
  FolderOpen,
  Globe,
  Hammer,
  ListChecks,
  LoaderCircle,
  MessageCircleQuestion,
  PackagePlus,
  RotateCcw,
  Search,
  ShieldAlert,
  ShieldCheck,
  StickyNote,
  Undo2,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { foldRounds, latestPlan, type AgentEvent, type PlanItem, type Round } from "@/lib/agent/progress";
import { describeWhen } from "@/lib/agent/schedule";
import type { ToolStep } from "@/lib/agent/workspace";

export type AgentStatus = "running" | "done" | "failed" | "stopped" | "paused";

export type AgentTurnData = {
  id: string;
  role: "agent";
  text: string;
  at: number;
  endedAt?: number;
  status: AgentStatus;
  jobId?: string;
  events: AgentEvent[];
  steps: ToolStep[];
  code?: string;
  touched: string[];
  /** Rounds the run took, known even when its timeline has not been fetched. */
  rounds?: number;
  /** The plan as the run left it, for a turn whose timeline is not loaded. */
  plan?: PlanItem[];
  /** The run ended by asking the user something; the next message answers it. */
  asked?: boolean;
};

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}

function seconds(from: number, to: number): string {
  const total = Math.max(0, Math.round((to - from) / 1000));
  if (total < 60) return `${total} 秒`;
  return `${Math.floor(total / 60)} 分 ${total % 60} 秒`;
}

function clean(text: string): string {
  return text.replaceAll("**", "").replaceAll("`", "");
}

export function AgentTurn({ turn, onOpenFile, onContinue, onExpand }: { turn: AgentTurnData; onOpenFile: (path: string) => void; onContinue?: () => void; onExpand?: () => void }) {
  const running = turn.status === "running";
  const now = useNow(running);
  const [open, setOpen] = useState(false);
  const rounds = foldRounds(turn.events);
  const calls = rounds.reduce((sum, round) => sum + round.effects.length, 0);
  const loaded = rounds.flatMap((round) => round.modules.map((mod) => mod.name));
  // An older run's timeline is fetched when it is first opened.
  const unfetched = rounds.length === 0 && (turn.rounds ?? 0) > 0;
  const hasProcess = rounds.length > 0 || turn.steps.length > 0 || unfetched;
  const showProcess = running || open;
  const toggle = () => {
    if (!open && unfetched) onExpand?.();
    setOpen((value) => !value);
  };
  const elapsed = seconds(turn.at, running ? now : (turn.endedAt ?? turn.at));
  const current = rounds[rounds.length - 1];
  const plan = latestPlan(turn.events) ?? turn.plan ?? null;
  const dropped = turn.events.flatMap((event) => (event.kind === "module_dropped" ? [event] : []));
  const lastTrouble = !running && turn.status !== "done" && turn.status !== "stopped" ? troubleOf(current) : "";

  return (
    <article className="select-text">
      <header className="flex items-center gap-2 text-xs">
        <span className={`inline-block h-2 w-2 rounded-full ${running ? "animate-pulse bg-accent" : turn.status === "failed" ? "bg-danger" : turn.status === "paused" ? "bg-warn" : "bg-muted"}`} />
        <span className="font-mono tracking-widest text-muted">OCAGENT</span>
        <span className="text-muted">·</span>
        <span className={turn.asked ? "text-fg" : "text-muted"}>{turn.asked ? "等你回答" : statusLine(turn.status, current, elapsed, plan)}</span>
      </header>

      <div className="mt-2 rounded-2xl border border-border bg-surface">
        {dropped.length > 0 ? (
          <div className="flex flex-col gap-1.5 border-b border-border px-4 py-3">
            {dropped.map((gone) => (
              <Row key={gone.name} icon={<Blocks className="h-3.5 w-3.5" aria-hidden />} label={`这次没带上 ${gone.name}：它现在编译不过`} detail={gone.reason} tone="warn" />
            ))}
          </div>
        ) : null}
        {plan && plan.length > 0 && (running || open) ? (
          <div className="border-b border-border px-4 py-3">
            <PlanView items={plan} running={running} />
          </div>
        ) : null}
        {hasProcess && showProcess ? (
          <div className="border-b border-border px-4 py-3">
            {rounds.length > 0 ? (
              <Timeline rounds={rounds} running={running} />
            ) : unfetched ? (
              <p className="flex items-center gap-2 text-sm text-muted">
                <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden />
                正在取回过程
              </p>
            ) : (
              <LegacySteps steps={turn.steps} />
            )}
          </div>
        ) : null}
        {running && !hasProcess ? (
          <div className="flex items-center gap-2 border-b border-border px-4 py-3 text-sm text-muted">
            <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden />
            正在接上 Grok
          </div>
        ) : null}

        {!running && turn.text ? (
          <div className="px-4 py-3">
            <p className={`whitespace-pre-wrap text-[15px] leading-7 ${turn.status === "failed" ? "text-danger" : "text-fg"}`}>{clean(turn.text)}</p>
            {lastTrouble && !turn.text.includes(lastTrouble.slice(0, 40)) ? (
              <p className="mt-1.5 whitespace-pre-wrap break-words font-mono text-xs leading-5 text-muted">最近一次出错：{lastTrouble}</p>
            ) : null}
          </div>
        ) : null}

        {!running && (turn.touched.length > 0 || hasProcess || onContinue) ? (
          <footer className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-border px-4 py-2 text-xs text-muted">
            {hasProcess ? (
              <button type="button" onClick={toggle} className="inline-flex min-h-8 items-center gap-1 rounded-md px-1 -ml-1 text-xs text-muted hover:text-fg">
                {open ? <ChevronDown className="h-3.5 w-3.5" aria-hidden /> : <ChevronRight className="h-3.5 w-3.5" aria-hidden />}
                {rounds.length > 0 ? summaryLine(rounds.length, calls, loaded, elapsed, plan) : unfetched ? `${turn.rounds} 轮 · ${elapsed}` : `${turn.steps.length} 步`}
              </button>
            ) : null}
            {turn.touched.map((path) => (
              <button key={path} type="button" onClick={() => onOpenFile(path)} className="inline-flex min-h-8 items-center gap-1 rounded-md border border-border bg-bg px-2 font-mono text-[11px] text-fg hover:border-primary">
                <FileText className="h-3 w-3" aria-hidden />
                {path}
              </button>
            ))}
            {loaded.map((name) => (
              <span key={name} className="inline-flex min-h-8 items-center gap-1 rounded-md border border-accent/40 bg-bg px-2 font-mono text-[11px] text-accent">
                <Blocks className="h-3 w-3" aria-hidden />
                {name}
              </span>
            ))}
            {onContinue ? (
              <button type="button" onClick={onContinue} className="ml-auto inline-flex min-h-8 items-center gap-1 rounded-md border border-border px-2 text-xs text-fg hover:border-primary">
                <RotateCcw className="h-3 w-3" aria-hidden />
                接着做
              </button>
            ) : null}
          </footer>
        ) : null}
      </div>
    </article>
  );
}

function summaryLine(roundCount: number, calls: number, loaded: string[], elapsed: string, plan: PlanItem[] | null): string {
  const parts = [`${roundCount} 轮`, `${calls} 次调用`];
  if (plan && plan.length) parts.push(`计划 ${plan.filter((item) => item.done).length}/${plan.length}`);
  if (loaded.length) parts.push(`装了 ${loaded.length} 个 module`);
  parts.push(elapsed);
  return parts.join(" · ");
}

function statusLine(status: AgentStatus, current: Round | undefined, elapsed: string, plan: PlanItem[] | null): string {
  if (status === "running") {
    const round = current ? `第 ${current.round} 轮 · ` : "";
    const progress = plan && plan.length ? `计划 ${plan.filter((item) => item.done).length}/${plan.length} · ` : "";
    return `${round}${progress}${elapsed}`;
  }
  if (status === "failed") return "没做成";
  if (status === "stopped") return "已停下";
  if (status === "paused") return "没做完";
  return "完成";
}

// The last round's error, for a turn that ended without an answer.
function troubleOf(current: Round | undefined): string {
  if (!current) return "";
  return (current.runnerError || current.compileError || current.modelError || "").trim().slice(0, 300);
}

function PlanView({ items, running }: { items: PlanItem[]; running: boolean }) {
  const done = items.filter((item) => item.done).length;
  // While running, the first open item is the one being worked on.
  const activeIndex = running ? items.findIndex((item) => !item.done) : -1;
  return (
    <div>
      <p className="flex items-center gap-1.5 text-xs text-muted">
        <ListChecks className="h-3.5 w-3.5" aria-hidden />
        计划 · {done}/{items.length}
      </p>
      <ol className="mt-1.5 flex flex-col gap-1">
        {items.map((item, index) => {
          const active = index === activeIndex;
          return (
            <li key={`${index}-${item.text}`} className="grid grid-cols-[1rem_minmax(0,1fr)] gap-x-2 text-sm">
              <span className={`mt-1 flex h-3.5 w-3.5 items-center justify-center rounded-sm border ${item.done ? "border-accent bg-accent text-bg" : active ? "border-accent" : "border-border"}`}>
                {item.done ? <Check className="h-2.5 w-2.5" strokeWidth={3} aria-hidden /> : active ? <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" /> : null}
              </span>
              <span className="min-w-0">
                <span className={item.done ? "text-muted" : "text-fg"}>{item.text}</span>
                {item.done && item.note ? <span className="ml-1.5 break-words font-mono text-xs text-muted">{item.note}</span> : null}
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function Timeline({ rounds, running }: { rounds: Round[]; running: boolean }) {
  return (
    <ol className="flex flex-col gap-3">
      {rounds.map((round, index) => (
        <RoundView key={round.round} round={round} last={index === rounds.length - 1} running={running} />
      ))}
    </ol>
  );
}

function RoundView({ round, last, running }: { round: Round; last: boolean; running: boolean }) {
  const [showCode, setShowCode] = useState(false);
  const live = running && last;
  return (
    <li className="grid grid-cols-[1.25rem_minmax(0,1fr)] gap-x-2">
      <span className="mt-0.5 flex h-5 w-5 items-center justify-center rounded-md bg-raised font-mono text-[11px] text-muted">{round.round}</span>
      <div className="flex min-w-0 flex-col gap-1.5">
        {round.thinking ? (
          <Row icon={<LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden />} label="正在想下一步" tone="muted" />
        ) : null}
        {round.modelError && round.budgetCut ? <Row icon={<Clock className="h-3.5 w-3.5" aria-hidden />} label="这一段时间用完了，这轮没等到回复" detail={`下一段从这里重来${spanOf(round)}`} tone="muted" /> : null}
        {round.modelError && !round.budgetCut ? <Row icon={<TriangleAlert className="h-3.5 w-3.5" aria-hidden />} label="模型没有回应" detail={`${round.modelError}${spanOf(round)}`} tone="danger" /> : null}
        {round.code ? (
          <div>
            <button type="button" onClick={() => setShowCode((value) => !value)} className="inline-flex min-h-6 items-center gap-1.5 rounded-md text-left text-sm text-fg hover:text-primary">
              <Braces className="h-3.5 w-3.5 text-muted" aria-hidden />
              写好一步
              <span className="text-xs text-muted">{showCode ? "收起代码" : "看代码"}</span>
            </button>
            {showCode ? <pre className="mt-1.5 max-h-56 overflow-auto rounded-lg bg-bg px-3 py-2 font-mono text-xs leading-5 text-fg">{round.code}</pre> : null}
          </div>
        ) : null}
        {round.running && round.effects.length === 0 && round.calls.length === 0 ? (
          <Row icon={<LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden />} label="编译并执行" tone="muted" />
        ) : null}
        {round.compileError ? <Row icon={<Hammer className="h-3.5 w-3.5" aria-hidden />} label="编译没过，改一下再来" detail={round.compileError} tone="warn" /> : null}
        {round.runnerError ? <Row icon={<TriangleAlert className="h-3.5 w-3.5" aria-hidden />} label="这一步没跑起来" detail={round.runnerError} tone="danger" /> : null}
        {round.effects.map((effect, index) => (
          <EffectRow key={`${effect.tool}-${index}`} tool={effect.tool} detail={effect.detail} output={effect.output} />
        ))}
        {round.calls.map((call, index) => (
          <Row key={`call-${index}`} icon={<LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden />} label={`${toolLabel(call.tool)}中`} detail={call.detail} tone="muted" />
        ))}
        {round.modules.map((mod) => (
          <ModuleRow key={mod.name} name={mod.name} exports={mod.exports} />
        ))}
        {round.remembered.map((change, index) => (
          <Row key={`${change.text}-${index}`} icon={<Brain className="h-3.5 w-3.5" aria-hidden />} label={change.forgot ? "忘掉了" : "记住了"} detail={change.text} tone={change.forgot ? "muted" : "accent"} />
        ))}
        {round.check && round.checkFailed.length === 0 ? <Row icon={<ListChecks className="h-3.5 w-3.5" aria-hidden />} label="想收尾了，先核对一遍再说" detail={round.check} tone="accent" /> : null}
        {round.check && round.checkFailed.length > 0 ? (
          <Row
            icon={<ShieldAlert className="h-3.5 w-3.5" aria-hidden />}
            label={round.checkGaveUp ? `想放弃，但 ${round.checkFailed.length} 条没通过的核对连文件都没看过，先去看一眼` : `想收尾，但有 ${round.checkFailed.length} 条核对没通过，退回去先修`}
            detail={round.checkFailed.join("；")}
            tone="warn"
          />
        ) : null}
        {round.needInput ? <Row icon={<MessageCircleQuestion className="h-3.5 w-3.5" aria-hidden />} label={`结果里用了占位，缺${round.needInput.topics.map((topic) => `你的${topic}`).join("、")}，改成问你`} tone="fg" /> : null}
        {round.limit ? <Row icon={<TriangleAlert className="h-3.5 w-3.5" aria-hidden />} label={`任务要的「${round.limit}」它做不到，不能算完成，改成只做到一半`} tone="warn" /> : null}
        {round.scheduled.map((item, index) => (
          <Row
            key={`${index}-${item.time}-${item.task}`}
            icon={<CalendarClock className="h-3.5 w-3.5" aria-hidden />}
            label={item.kind === "daily" ? `定下了：${describeWhen(item.time, item.tz)}，到点自动做` : `取消了定时：${describeWhen(item.time, item.tz)}`}
            detail={item.task}
            tone="accent"
          />
        ))}
        {round.reply && !round.check ? <ReplyRow kind={round.reply.kind} live={live} span={spanOf(round)} /> : null}
      </div>
    </li>
  );
}

function ModuleRow({ name, exports }: { name: string; exports: string[] }) {
  const shown = exports.slice(0, 6);
  const more = exports.length - shown.length;
  return (
    <div className="min-w-0 text-sm">
      <p className="flex min-w-0 items-start gap-1.5 text-accent">
        <span className="mt-1 shrink-0">
          <Blocks className="h-3.5 w-3.5" aria-hidden />
        </span>
        <span className="min-w-0">
          <span className="text-fg">
            <span className="font-mono">{name}</span> 已就位，后面的步骤可以直接调用
          </span>
        </span>
      </p>
      {shown.length ? (
        <p className="ml-5 mt-1 flex flex-wrap gap-1">
          {shown.map((fn) => (
            <span key={fn} className="rounded border border-border bg-bg px-1.5 py-0.5 font-mono text-[11px] text-muted">
              {name}.{fn}
            </span>
          ))}
          {more > 0 ? <span className="px-1 py-0.5 font-mono text-[11px] text-muted">+{more}</span> : null}
        </p>
      ) : null}
    </div>
  );
}

// How long a finished round took, as " · 38 秒", from its first event to its
// last; nothing for a round still going or one under a second.
function spanOf(round: Round): string {
  const ms = round.endedAt - round.startedAt;
  if (!round.startedAt || ms < 1_000) return "";
  const seconds = Math.round(ms / 1000);
  return seconds >= 60 ? ` · ${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒` : ` · ${seconds} 秒`;
}

function ReplyRow({ kind, live, span }: { kind: string; live: boolean; span: string }) {
  const detail = span ? span.replace(/^ · /, "") : undefined;
  if (kind === "continue") {
    return <Row icon={<CornerDownRight className="h-3.5 w-3.5" aria-hidden />} label={live ? "还要再来一轮" : "继续下一轮"} detail={detail} tone="muted" />;
  }
  if (kind === "done") return <Row icon={<Check className="h-3.5 w-3.5" aria-hidden />} label="做完了" detail={detail} tone="accent" />;
  if (kind === "ask") return <Row icon={<CornerDownRight className="h-3.5 w-3.5" aria-hidden />} label="需要你回答" detail={detail} tone="fg" />;
  return <Row icon={<TriangleAlert className="h-3.5 w-3.5" aria-hidden />} label="只做到一半" detail={detail} tone="warn" />;
}

function Row({ icon, label, detail, output, tone }: { icon: ReactNode; label: string; detail?: string; output?: string; tone: "muted" | "fg" | "accent" | "warn" | "danger" }) {
  const color = tone === "danger" ? "text-danger" : tone === "warn" ? "text-warn" : tone === "accent" ? "text-accent" : tone === "fg" ? "text-fg" : "text-muted";
  return (
    <div className="min-w-0 text-sm">
      <p className={`flex min-w-0 items-start gap-1.5 ${color}`}>
        <span className="mt-1 shrink-0">{icon}</span>
        <span className="min-w-0">
          <span className="text-fg">{label}</span>
          {detail ? <span className="ml-1.5 break-all font-mono text-xs text-muted">{detail}</span> : null}
        </span>
      </p>
      {output ? <p className="ml-5 mt-0.5 line-clamp-2 whitespace-pre-wrap break-all font-mono text-xs leading-5 text-muted">{output}</p> : null}
    </div>
  );
}

function EffectRow({ tool, detail, output }: { tool: string; detail: string; output: string }) {
  const [full, setFull] = useState(false);
  const isCheck = tool.startsWith("Check.");
  const failed = output.startsWith("Error") || (isCheck && !output.startsWith("通过"));
  const shown = isCheck ? output.replace(/^(通过|没通过)[：:]?\s?/, "") : output.replace(/^(Ok|Error)\s?/, "");
  const icon = isCheck ? (failed ? <ShieldAlert className="h-3.5 w-3.5" aria-hidden /> : <ShieldCheck className="h-3.5 w-3.5" aria-hidden />) : iconFor(tool);
  const isNote = tool === "Trace.note";
  return (
    <div className="min-w-0 text-sm">
      <p className={`flex min-w-0 items-start gap-1.5 ${failed ? "text-danger" : "text-fg"}`}>
        <span className={`mt-1 shrink-0 ${isCheck ? (failed ? "text-danger" : "text-accent") : "text-muted"}`}>{icon}</span>
        <span className="min-w-0">
          <span>{toolLabel(tool)}</span>
          {isNote ? <span className="ml-1.5 whitespace-pre-wrap break-words text-muted">{shown}</span> : detail ? <span className="ml-1.5 break-all font-mono text-xs text-muted">{detail}</span> : null}
        </span>
      </p>
      {!isNote && shown ? (
        <button type="button" onClick={() => setFull((value) => !value)} className={`ml-5 mt-0.5 block w-[calc(100%-1.25rem)] text-left font-mono text-xs leading-5 ${failed ? "text-danger" : "text-muted"} ${full ? "whitespace-pre-wrap break-all" : "truncate"}`}>
          {shown}
        </button>
      ) : null}
    </div>
  );
}

function LegacySteps({ steps }: { steps: ToolStep[] }) {
  return (
    <ul className="flex flex-col gap-1.5">
      {steps.map((step, index) => (
        <li key={`${step.tool}-${index}`}>
          <Row icon={iconFor(step.tool)} label={toolLabel(step.tool)} detail={step.detail} output={step.output} tone={step.tool === "compile" ? "warn" : "fg"} />
        </li>
      ))}
    </ul>
  );
}

function iconFor(tool: string): ReactNode {
  const cls = "h-3.5 w-3.5";
  switch (tool) {
    case "Search.query":
    case "web_search":
      return <Search className={cls} aria-hidden />;
    case "Net.get":
    case "Net.post":
    case "http_get":
      return <Globe className={cls} aria-hidden />;
    case "Files.write_file":
    case "Files.replace":
    case "Files.append":
    case "write_file":
      return <FilePen className={cls} aria-hidden />;
    case "Files.read_file":
    case "read_file":
    case "Files.find_in_files":
    case "find_in_files":
      return <FileText className={cls} aria-hidden />;
    case "Files.list_files":
    case "list_files":
      return <FolderOpen className={cls} aria-hidden />;
    case "Files.delete_file":
    case "delete_file":
      return <Trash2 className={cls} aria-hidden />;
    case "Files.restore":
      return <Undo2 className={cls} aria-hidden />;
    case "Trace.note":
      return <StickyNote className={cls} aria-hidden />;
    case "Clock.now":
      return <Clock className={cls} aria-hidden />;
    case "Harness.load":
    case "load_harness":
      return <Blocks className={cls} aria-hidden />;
    case "Harness.install":
      return <PackagePlus className={cls} aria-hidden />;
    case "compile":
      return <Hammer className={cls} aria-hidden />;
    default:
      return <Braces className={cls} aria-hidden />;
  }
}

function toolLabel(tool: string): string {
  const labels: Record<string, string> = {
    "Files.list_files": "列出文件",
    "Files.read_file": "读文件",
    "Files.find_in_files": "查找",
    "Files.write_file": "写入",
    "Files.replace": "改文件",
    "Files.append": "追加",
    "Files.delete_file": "删除",
    "Files.restore": "退回开始时的版本",
    "Check.that": "核对",
    "Check.equal": "核对相等",
    "Check.contains": "核对文件里有",
    "Search.query": "搜索",
    "Net.get": "请求",
    "Net.post": "发送",
    "Json.get": "取字段",
    "Json.items": "取数组",
    "Json.keys": "看字段",
    "Trace.note": "记下",
    "Clock.now": "计时",
    "Harness.load": "装为 harness",
    "Harness.install": "安装库",
    compile: "编译未通过",
    list_files: "列出文件",
    read_file: "读文件",
    find_in_files: "查找",
    write_file: "写入",
    delete_file: "删除",
    web_search: "搜索",
    http_get: "请求",
    ocaml_run: "运行",
    load_harness: "加载 module",
  };
  return labels[tool] ?? tool;
}
