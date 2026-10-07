import { useEffect, useState, type ReactNode } from "react";
import {
  Braces,
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
  LoaderCircle,
  Search,
  StickyNote,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { foldRounds, type AgentEvent, type Round } from "@/lib/agent/progress";
import type { ToolStep } from "@/lib/agent/workspace";

export type AgentStatus = "running" | "done" | "failed" | "stopped";

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

export function AgentTurn({ turn, onOpenFile }: { turn: AgentTurnData; onOpenFile: (path: string) => void }) {
  const running = turn.status === "running";
  const now = useNow(running);
  const [open, setOpen] = useState(false);
  const rounds = foldRounds(turn.events);
  const calls = rounds.reduce((sum, round) => sum + round.effects.length, 0);
  const hasProcess = rounds.length > 0 || turn.steps.length > 0;
  const showProcess = running || open;
  const elapsed = seconds(turn.at, running ? now : (turn.endedAt ?? turn.at));
  const current = rounds[rounds.length - 1];

  return (
    <article className="select-text">
      <header className="flex items-center gap-2 text-xs">
        <span className={`inline-block h-2 w-2 rounded-full ${running ? "animate-pulse bg-accent" : turn.status === "failed" ? "bg-danger" : "bg-muted"}`} />
        <span className="font-mono tracking-widest text-muted">OCAGENT</span>
        <span className="text-muted">·</span>
        <span className="text-muted">{statusLine(turn.status, current, elapsed)}</span>
      </header>

      <div className="mt-2 rounded-2xl border border-border bg-surface">
        {hasProcess && showProcess ? (
          <div className="border-b border-border px-4 py-3">
            {rounds.length > 0 ? <Timeline rounds={rounds} running={running} /> : <LegacySteps steps={turn.steps} />}
          </div>
        ) : null}
        {running && !hasProcess ? (
          <div className="flex items-center gap-2 border-b border-border px-4 py-3 text-sm text-muted">
            <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden />
            正在接上 Grok
          </div>
        ) : null}

        {!running && turn.text ? (
          <p className={`whitespace-pre-wrap px-4 py-3 text-[15px] leading-7 ${turn.status === "failed" ? "text-danger" : "text-fg"}`}>{clean(turn.text)}</p>
        ) : null}

        {!running && (turn.touched.length > 0 || hasProcess) ? (
          <footer className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-border px-4 py-2 text-xs text-muted">
            {hasProcess ? (
              <button type="button" onClick={() => setOpen((value) => !value)} className="inline-flex min-h-8 items-center gap-1 rounded-md px-1 -ml-1 text-xs text-muted hover:text-fg">
                {open ? <ChevronDown className="h-3.5 w-3.5" aria-hidden /> : <ChevronRight className="h-3.5 w-3.5" aria-hidden />}
                {rounds.length > 0 ? `${rounds.length} 轮 · ${calls} 次调用 · ${elapsed}` : `${turn.steps.length} 步`}
              </button>
            ) : null}
            {turn.touched.map((path) => (
              <button key={path} type="button" onClick={() => onOpenFile(path)} className="inline-flex min-h-8 items-center gap-1 rounded-md border border-border bg-bg px-2 font-mono text-[11px] text-fg hover:border-primary">
                <FileText className="h-3 w-3" aria-hidden />
                {path}
              </button>
            ))}
          </footer>
        ) : null}
      </div>
    </article>
  );
}

function statusLine(status: AgentStatus, current: Round | undefined, elapsed: string): string {
  if (status === "running") {
    const round = current ? `第 ${current.round} 轮 · ` : "";
    return `${round}${elapsed}`;
  }
  if (status === "failed") return "没做成";
  if (status === "stopped") return "已停下";
  return "完成";
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
        {round.modelError ? <Row icon={<TriangleAlert className="h-3.5 w-3.5" aria-hidden />} label="模型没有回应" detail={round.modelError} tone="danger" /> : null}
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
        {round.effects.map((effect, index) => (
          <EffectRow key={`${effect.tool}-${index}`} tool={effect.tool} detail={effect.detail} output={effect.output} />
        ))}
        {round.calls.map((call, index) => (
          <Row key={`call-${index}`} icon={<LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden />} label={`${toolLabel(call.tool)}中`} detail={call.detail} tone="muted" />
        ))}
        {round.reply ? <ReplyRow kind={round.reply.kind} live={live} /> : null}
      </div>
    </li>
  );
}

function ReplyRow({ kind, live }: { kind: string; live: boolean }) {
  if (kind === "continue") {
    return <Row icon={<CornerDownRight className="h-3.5 w-3.5" aria-hidden />} label={live ? "还要再来一轮" : "继续下一轮"} tone="muted" />;
  }
  if (kind === "done") return <Row icon={<Check className="h-3.5 w-3.5" aria-hidden />} label="做完了" tone="accent" />;
  if (kind === "ask") return <Row icon={<CornerDownRight className="h-3.5 w-3.5" aria-hidden />} label="需要你回答" tone="fg" />;
  return <Row icon={<TriangleAlert className="h-3.5 w-3.5" aria-hidden />} label="只做到一半" tone="warn" />;
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
  const failed = output.startsWith("Error");
  const shown = output.replace(/^(Ok|Error)\s?/, "");
  const icon = iconFor(tool);
  const isNote = tool === "Trace.note";
  return (
    <div className="min-w-0 text-sm">
      <p className={`flex min-w-0 items-start gap-1.5 ${failed ? "text-danger" : "text-fg"}`}>
        <span className="mt-1 shrink-0 text-muted">{icon}</span>
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
    case "http_get":
      return <Globe className={cls} aria-hidden />;
    case "Files.write_file":
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
    case "Trace.note":
      return <StickyNote className={cls} aria-hidden />;
    case "Clock.now":
      return <Clock className={cls} aria-hidden />;
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
    ocaml_run: "运行",
    load_harness: "加载 module",
  };
  return labels[tool] ?? tool;
}
