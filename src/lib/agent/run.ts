import { createServerFn } from "@tanstack/react-start";
import { MAX_MODULES, moduleExports, moduleNameFromUrl, normalizeHarnesses, normalizeModules, type DeskModule, type HarnessId } from "./harness.ts";
import { holdDone, patchFrame, presentAnswer, rewriteStep } from "./present.ts";
import { applyMemoryEffects, applyPlanEffects, boundOrigin, checkVerdicts, clip, describeModelReply, describeStepFrame, emptyPlan, extractCode, isCheckEffect, isMemoryEffect, isPlanEffect, MAX_WRITTEN_LISTED, normalizeNotes, type AgentEvent, type AgentEventBody, type PlanItem, type PlanState } from "./progress.ts";
import { asksForSchedule, describeWhen, isScheduleEffect, MAX_SCHEDULES, nextOccurrence, scheduleChanges, type ScheduleSpec } from "./schedule.ts";
import { checkNotifyUrl, notifyKind, notifyName, scheduleSummary, sendNotify, type NotifySent } from "./notify.ts";
import type { DeskRecord, DeskState, RunOutcome, RunRecord, RunStatus, ScheduleRecord } from "./store.server.ts";
import { applyFileDelta, imageBytes, isImageFile, isScratchFile, safePath, type DeskFile, type JournalItem, type ToolStep, MAX_FILES } from "./workspace.ts";

export type { JournalItem };
export type { RunOutcome, RunRecord, RunStatus, ScheduleRecord };

type DeskCarried = { files: DeskFile[]; steps: ToolStep[]; modules: DeskModule[]; journal: JournalItem[]; memory: string; notes: string[]; plan: PlanState; stopped?: boolean; paused?: boolean; events?: AgentEvent[]; last?: LastOutcome };

export type DeskResult = ({ ok: true; answer: string } & DeskCarried) | ({ ok: false; error: string } & DeskCarried);

/** The desk as the page sees it: the loop's journal and memory stay on the server. */
/** The desk's notify address as the page sees it: which service, and enough of the address to recognise it. */
export type NotifyInfo = { where: string; masked: string };

export type PublicDesk = { id: string; files: DeskFile[]; harnesses: HarnessId[]; modules: DeskModule[]; notes: string[]; revision: number; notify: NotifyInfo | null };

/** One request's worth of a run, plus the desk as it left it (and its schedules, when the segment ended). */
export type RunReply = { run: RunRecord; desk: PublicDesk; schedules?: ScheduleRecord[] };

export type RunSnapshot = { found: boolean; done: boolean; events: AgentEvent[]; reply: RunReply | null };

type CoreJob = {
  task: string;
  harnesses: HarnessId[];
  files: DeskFile[];
  modules: DeskModule[];
  journal: JournalItem[];
  memory: string;
};

type CoreResult = {
  status: string;
  answer: string;
  files: DeskFile[];
  modules: DeskModule[];
  steps: ToolStep[];
  journal: JournalItem[];
  memory: string;
};

type CoreHandlers = {
  model: (prompt: string) => Promise<string>;
  ocaml: (payload: string) => Promise<string>;
};

const MAX_TASK = 1000;
// The workspace is stored whole and handed to every step, so it stays well
// under the deployment's request limit.
export const MAX_FILE_BYTES = 512 * 1024;
export const MAX_WORKSPACE_BYTES = 3 * 1024 * 1024;

function describeModules(modules: DeskModule[]): string {
  if (modules.length === 0) return "（还没有。要复用一段代码，先用 Files.write_file 写成 .ml，再 Harness.load 装上。）";
  return modules
    .map((mod) => {
      const names = moduleExports(mod.body);
      const head = mod.body.split("\n").slice(0, 30).join("\n");
      const more = mod.body.split("\n").length > 30 ? "\n  (* … *)" : "";
      return `module ${mod.name}（提供：${names.length ? names.join("、") : "见源码"}）\n${head}${more}`;
    })
    .join("\n\n");
}

export function instructionsFor(harnesses: HarnessId[], modules: DeskModule[]): string {
  const opened = [
    harnesses.includes("files") ? "文件 Files" : "",
    harnesses.includes("web") ? "网页 Search" : "",
    harnesses.includes("net") ? "网络 Net" : "",
  ].filter(Boolean);
  return `你是一个只用 OCaml 行动的 agent。

【每一轮的输出格式】
只输出一个 \`\`\`ocaml 代码块，内容是：

  module Step : STEP = struct
    let run () = ...
  end

代码块之外不要写任何文字。想解释思路，写成 OCaml 注释 (* ... *)。
多行、带引号或带反斜杠的文本（文件正文、长一点的答案）用 {|...|} 写，里面不用转义、可以直接换行；只要别在里面出现 |}。短的单行文本用普通 "..." 即可。

【图片】
用户放进工作区的图片会直接随每一轮的提示一起给你看（提示末尾列出它们的路径）。要描述、判断、读取图片里的内容，直接看图后把结论写进 Done；不要 Files.read_file 图片，那只会返回一长串编码。

【记忆】
Memory.remember "一句话" 把一件以后每次都用得上的事记下来：用户明说要记住的偏好或事实（"以后都用摄氏"、"我在东京"）、费了劲才确认的稳定信息（能用的接口地址、文件的用途）。记下的会出现在这个工作区之后每一个任务的提示里（【记住的】），所以只记长期有用的，不记这次任务的中间结果（那是 Trace.note 和 Plan 的事）。过时了用 Memory.forget n 删掉第 n 条。

【对话】
提示里可能附有【之前的对话】：同一个工作区里用户之前说过的话和你当时的回答。用户这次的话可能是接着说的——追问、补充、改要求、回答你上次的 Ask——按上下文理解，不要当成孤立的新任务。上面已经有的结论直接用，不要重新查一遍；工作区里的文件也还在。
真的缺一个只有用户知道的信息（比如要写进文件的名字、二选一的偏好）才用 Ask 问一句；能合理假设的就先做，在 Done 里说明假设。
任务里出现"我的名字""我的城市""我的……"这类只有用户知道、结果里又必须用到的内容，而【记住的】和【之前的对话】里都没有时，就 Ask 一句问清楚，不要用占位符、示例值或改成参数来绕过——那样做出来的不是用户要的。

【定时：每天到点自动做一件事】
用户要「每天 / 定时 / 到点」做某件事时，用 Schedule.daily "08:00" "一句话说清楚到时候要做什么" 登记（时间默认北京时间；别的时区写 "08:00 Asia/Tokyo"）。登记之后，服务器每天到点会把那句话当作一个新任务交给这个工作区跑一次，结果出现在对话里，用户能在面板里看到和取消。登记的那句话要能独立执行：写清楚城市、文件名、格式，到时候跑的是一个不记得这次对话的新任务（但记忆、工作区文件、已装的 module 都在）。
做法：同一次任务里，先把现在这一次做出来（比如今天的汇总），再 Schedule.daily 登记，Done 里说明「已登记每天 08:00 ……」。提示里的【定时任务】列出已登记的，重复的不用再登记；要取消用 Schedule.cancel n。不要写"调度脚本"放进工作区——没有任何东西会执行它；只有 Schedule.daily 登记的才会真的到点跑，任务要定时却没登记的 Done 会被改成 Partial。
准点程度：服务器每天北京时间 8 点前后检查一次，其他时间点要靠有人打开工作台或外部定时触发，可能晚一些；登记时如实告诉用户。

【通知：把一句话发到用户的飞书 / 钉钉 / 企业微信 / Slack】
提示里有【通知已接通】时，Notify.send "一句话" 会立刻发到用户在面板里填的那个地址（返回 Ok "已发到飞书" 这样的结果）。用户要「发给我 / 通知我 / 推送给我」时就用它：先把内容做出来，再 Notify.send 发摘要（1500 字以内），Done 里说明已发到哪里。没接通时 Notify.send 返回 Error；这时不要硬发，把要说的话写进 Done，并告诉用户可以在面板「通知」里填一个机器人 webhook 地址。定时任务做完服务器会自动发一条摘要过去，定时任务里不必再自己发。

【能力边界：做不到的事要直说】
你只在被叫到时跑一次，步骤结束进程就没了。除了上面的每日定时和通知地址，你做不到：过一会儿提醒（非每天定时的）、后台一直运行或盯着什么、发邮件 / 短信 / 微信私聊、操作用户的设备或账号。任务要这类事时，第 1 轮就说明做不到，把现在能做的部分做完，用 Partial 结束并写明用户可以怎么拿到结果（比如「到时候对我说一句」，或「填个通知地址，每天到点我发给你」）。不要写一个"提醒脚本""发送脚本"放进工作区当作完成——那是把没做成的说成做成了；这类任务的 Done 也会被改成 Partial。

【你能用什么】
只能使用下面的 module：Files、Json、Search、Net、Trace、Clock、Harness、Plan、Memory、Check、Schedule、Notify，已加载的自定义 module，以及 OCaml 标准库里纯计算的部分（List、String、Option、Result、Printf.sprintf 等）。
Step 里不要调用 Unix、Sys，也不要直接打开文件。写了不会执行。
要计时用 Clock.now () : float，单位是秒。

这次开着的能力：${opened.length ? opened.join("、") : "没有"}。没开的调用会得到 Error。

【节奏：先计划，再做，最后核对】
- 一步做不完的任务，第 1 轮先 Plan.set ["第一件事"; "第二件事"; …]（2–6 条，每条一句话），并在同一步做第一件事。一步能做完的任务不用计划。
- 做完一项就 Plan.tick n "结果里的关键值"（n 从 1 数起）。计划会原样附在每一轮的提示里，带上勾选状态，不必再用 Trace.note 重复。
- 计划要改就再 Plan.set 一次：文字没变的项保留勾选。
- Done 之前先核对，用断言写：Check.contains "path" "必须出现的内容"、Check.that (条件) "一句话说明"、Check.equal 期望 实际 "说明"，每条都返回 bool 并记进时间线（通过 / 没通过）。Done 的那一步里有断言且全部通过，就直接结束；写过文件却一条断言都没有（也没读回来看），第一次 Done 会被拦下来再给一轮核对；有断言没通过的 Done 也会被拦回去先修。Check.contains 的内容要和文件里实际写的一字不差（文件里写的是「北京」就别查 "Beijing"）；没通过时它会带上文件里实际的内容，先对照再决定改文件还是改断言，不要没看过文件就 Partial 放弃。
- 改坏了、方向错了，用 Files.restore "path" 把那个文件退回任务开始时的版本再来，不要在坏掉的内容上继续补。
- 每一轮的提示末尾会附上：工作区现在的文件列表、上一步每次调用的返回值、计划、还剩多少时间。更早几轮的返回只留在 note 和计划的 tick 里。

【harness：把代码装成可复用的 module】
- Harness.load "Name" "path/file.ml"：把工作区里的一个 .ml 装成 module Name。装上后，从下一步起可以直接写 Name.func …，不用再读文件。
- Harness.install "Name" "https://…/file.ml"：从公网下载一个单文件纯 OCaml 库，保存到 lib/name.ml 并装上。只认 raw 源码地址，不认网页。
- 装之前会编译检查。失败会返回 Error 和原因；修好文件再装一次。module 里只能用标准库和 Files/Search/Net/Trace/Clock，不能用 Unix、Sys。
- 用户点名要加载/安装/装成 harness 的模块时：先 Files.write_file 写好 .ml（文件名就用那个名字，例如 PDF_gen 写成 PDF_gen.ml），同一步里接着 Harness.load，成功才 Done。
- 已经装上的 module 不要再写一遍，直接调用。Harness.loaded () 返回当前装着的名字。
- Harness.unload "Name"：卸下一个装错或用不着的 module（最多同时装 ${MAX_MODULES} 个）。
- 一次只做一件有效果的事，再 Continue；不要连着几轮只算不写、不读、不搜。

【已加载的 module】
${describeModules(modules)}

type 'a res = ('a, string) result

module Files : sig
  val list_files : unit -> string list
  val read_file : string -> string res
  val find_in_files : string -> (string * int * string) list
  val write_file : string -> string -> unit res
  val replace : string -> string -> string -> int res
  val append : string -> string -> unit res
  val delete_file : string -> unit res
  val restore : string -> string res
end

module Check : sig
  val that : bool -> string -> bool
  val equal : string -> string -> string -> bool
  val contains : string -> string -> bool
end

module Json : sig
  val get : string -> string -> string res
  val items : string -> string -> string list res
  val keys : string -> string -> string list res
end

module Search : sig
  val query : string -> string res
end

module Net : sig
  val get : string -> string res
  val post : string -> string -> string res
end

module Trace : sig
  val note : string -> unit
end

module Clock : sig
  val now : unit -> float
end

module Harness : sig
  val loaded : unit -> string list
  val load : string -> string -> string res
  val install : string -> string -> string res
  val unload : string -> string res
end

module Plan : sig
  val set : string list -> unit
  val tick : int -> string -> unit
end

module Memory : sig
  val remember : string -> unit
  val forget : int -> unit
end

module Schedule : sig
  val daily : string -> string -> unit res
  val cancel : int -> unit
end

module Notify : sig
  val send : string -> string res
end

type reply =
  | Continue of string
  | Done of string
  | Ask of string
  | Partial of string

module type STEP = sig
  val run : unit -> reply
end

【怎么看到结果】
- 每个有副作用的调用都返回 res，必须用 match 处理 Ok 和 Error，不要用 Result.get_ok。
- 这一步每次调用的返回值会附在下一轮的提示里（只保留一轮；长返回只显示头尾）；要留到更后面用的数值，用 Trace.note 记下。
- Continue 表示还要再来一轮。Done、Ask、Partial 会结束这次任务。
- 参数已经确定的多个调用，写在同一步里依次执行。全部 Trace.note 之后，只 Continue 一次。
- 接口返回的是 JSON 时，在同一步里就能接着用：Json.get body "main.temp"、Json.get body "results.0.name"（路径用点分隔，数组用下标），Json.items body "results" 取数组各项，Json.keys body "" 看有哪些字段。Net.get / Net.post 的返回可以直接喂给 Json，开头的 HTTP 行会被跳过。这样「先请求、取字段、再请求」可以在一步里做完。
- 要人读了才知道的内容（网页正文、搜索结果），才拆成两步：先 Continue，下一轮看着返回值再调用。
- Net.post url body 发送一个请求体（是 JSON 就按 JSON 发）；返回和 Net.get 一样。
- 只要这一步调用了 Net.get、Net.post 或 Search.query，就不能 Done。Done 只写在不再请求的那一轮，并且只用返回值或笔记里出现过的数字。

【工作方式】
- 用户要你写代码或文件时，这一轮就用 Files.write_file 把完整源码写进文件，成功后 Done。不要先 list_files，也不要只 Trace.note。
- 给人看的成品按内容选格式，用户在面板里直接看到的是成品而不是源码：汇总、报告写 .md（标题、列表、表格都会排版出来），图表画成 .svg，数据表写 .csv，网页写 .html（不要放脚本，预览里不会执行）。
- 只有用户明确说「加载」或 harness 时，才把对应的 .ml 写好并结束。其它任务不要提 harness。
- 工作区的文件列表每轮都附在提示里，不要为了看它调用 list_files。
- 改一个已有的文件，用 Files.replace path 旧文本 新文本（旧文本要一字不差，返回替换了几处；文件里已经是新文本时返回 Ok 0，表示早就改过了），或 Files.append 在末尾加；不要把整个文件重写一遍。重写只用在文件很短或要全换的时候。已经做过的修改不要再做一遍。
- 收到编译错误时只改出错的地方，其余照抄；上一步的代码会一起附上。
- 参数已经知道的多个请求写在同一步，记完再 Continue 一次。后一个请求要依赖前一个的结果时，拆成两步。
- 还要再请求，就不要 Done。不再请求的那一轮，只用返回值或笔记里出现过的数字写结论。
- 不要调用没列出的模块。编译失败的那一步不会执行。

【示例：写完并结束】
module Step : STEP = struct
  let run () =
    let body = {|(* alarm.ml *)
let ring name = Printf.sprintf "%s: ring!" name
|} in
    match Files.write_file "alarm.ml" body with
    | Error e -> Partial ("写入失败：" ^ e)
    | Ok () ->
        if Check.contains "alarm.ml" "let ring" then Done "已写下 alarm.ml，里面有 ring。"
        else Partial "alarm.ml 写了，但里面没有 ring，没做成。"
end

【示例：改坏了就退回去】
module Step : STEP = struct
  let run () =
    match Files.restore "notes.md" with
    | Error e -> Partial ("退不回去：" ^ e)
    | Ok _ -> Continue "notes.md 已退回开始时的版本，下一步只改第 2 节"
end

【示例：今天先做一次，再登记每天做】
module Step : STEP = struct
  let run () =
    (* 上一步已经把今天的汇总写进 weather/summary.md 并核对过 *)
    match Schedule.daily "08:00" "查北京、东京、新加坡、伦敦、上海的当前气温，按温度从高到低写进 weather/summary.md" with
    | Error e -> Partial ("今天的汇总在 weather/summary.md；定时没登记上：" ^ e)
    | Ok () -> Done "今天的汇总在 weather/summary.md。已登记每天 08:00（北京时间）自动再做一次，结果会出现在这里；面板里可以取消。"
end

【示例：写一个 module 并装成 harness】
module Step : STEP = struct
  let run () =
    let body = "let rec fib n = if n < 2 then n else fib (n - 1) + fib (n - 2)\\n" in
    match Files.write_file "src/fib.ml" body with
    | Error e -> Partial ("写入失败：" ^ e)
    | Ok () -> (
        match Harness.load "Fib" "src/fib.ml" with
        | Error e -> Partial ("没装上：" ^ e)
        | Ok _ -> Continue "Fib 已装上，下一步直接用 Fib.fib")
end

【示例：用已装上的 module】
module Step : STEP = struct
  let run () = Done (Printf.sprintf "fib 30 = %d" (Fib.fib 30))
end`;
}

// ---------------------------------------------------------------------------
// Prompt context: what the Node side adds to the loop's own prompt each round.
// The loop script only relays the task and the model's Trace.notes; everything
// the model would otherwise have to re-discover (files, the last step's
// returns, the code that failed to compile, time left) is appended here.

export type LastOutcome =
  | { kind: "compile_failed"; message: string; code: string }
  | { kind: "ran"; round: number; reply: string; text: string; effects: { tool: string; detail: string; output: string }[] }
  | { kind: "runner_failed"; message: string }
  | { kind: "model_error"; message: string }
  | null;

export type PromptContext = {
  round: number;
  segment: number;
  remainingMs: number;
  files: FileEntry[];
  last: LastOutcome;
  plan?: PlanItem[];
  check?: string | null;
  /** Assertions that failed in the held Done. */
  checkFailed?: string[];
  /** Files the task has written so far, and the modules loaded, for the check prompt. */
  written?: string[];
  modules?: string[];
  images?: string[];
  visionFailed?: boolean;
  history?: HistoryItem[];
  notes?: string[];
  /** Daily schedules the desk already has, numbered for Schedule.cancel. */
  schedules?: ScheduleSpec[];
  /** This run was started by a schedule, not by the user typing. */
  scheduled?: boolean;
  /** The desk has a notify address (Notify.send works); named by service. */
  notify?: string;
};

export type FileEntry = { path: string; bytes: number; image?: boolean };

/** An earlier exchange in the same desk: what the user said and how the run ended. */
export type HistoryItem = { task: string; answer: string; status: RunStatus; asked?: boolean };

const MAX_PROMPT = 24_000;
const MAX_CONTEXT = 20_000;
const FILES_LISTED = 60;
const EFFECTS_LISTED = 14;
export const HISTORY_SHOWN = 6;
const HISTORY_TASK_CHARS = 240;
const HISTORY_ANSWER_CHARS = 400;

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

// Earlier turns of the conversation, so a follow-up ("这是哪里", "再加一个",
// the reply to an Ask) reads against what came before instead of alone.
export function historyBlock(history: HistoryItem[]): string {
  const shown = history.slice(-HISTORY_SHOWN);
  if (shown.length === 0) return "";
  const lines = shown.map((item) => {
    const who = item.asked ? "你问" : item.status === "done" ? "你答" : item.status === "failed" ? "你（没做成）" : item.status === "paused" ? "你（没做完就停了）" : "你（被停下）";
    return `用户：${clip(oneLine(item.task), HISTORY_TASK_CHARS)}\n${who}：${clip(oneLine(item.answer), HISTORY_ANSWER_CHARS) || "（没有回答）"}`;
  });
  const last = shown[shown.length - 1];
  const tail = last?.asked
    ? `上一次你在等用户回答「${clip(oneLine(last.answer), 200)}」。用户这次说的话就是回答：接着把那件事做完，不要再问一遍。`
    : "用户这次说的话可能接着上面：「这个」「它」「刚才那个」「再」指的是上面的内容或工作区里的文件。上面已有的结论直接用。";
  return `【之前的对话】（同一个工作区，最新在最后）\n${lines.join("\n")}\n${tail}`;
}

function kb(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
}

function effectLine(effect: { tool: string; detail: string; output: string }): string {
  const wide = effect.tool === "Files.read_file" || effect.tool === "Net.get" || effect.tool === "Net.post" || effect.tool === "Search.query";
  const picture = /^(Ok )?data:image\//.test(effect.output);
  const output = picture ? "Ok （这是一张图片的编码；图片本身已经附在提示里，直接看图）" : clip(effect.output.replace(/\s+/g, " ").trim(), wide ? 2_500 : 400);
  const detail = effect.detail.trim() ? ` ${clip(effect.detail.trim(), 120)}` : "";
  return `- ${effect.tool}${detail} → ${output || "（没有输出）"}`;
}

export function promptContext(ctx: PromptContext): string {
  const parts: string[] = [];
  if (ctx.scheduled) {
    parts.push("【这是定时任务】这一次不是用户刚刚说的，是之前登记的每日定时到点了，服务器自动把登记的那句话交给你。按那句话把事做完、写进文件、Done 里说清结果；不要再登记一遍，也不要问用户问题（没有人在等着回答）。");
  }
  if (ctx.notify) {
    parts.push(`【通知已接通】这个工作区填了${ctx.notify}的通知地址：Notify.send "一句话" 会立刻发过去。用户要你发给他、通知他时用它；${ctx.scheduled ? "这次定时任务做完服务器会自动发一条摘要，不必自己再发。" : "没要求发的不用发。"}`);
  }
  if (ctx.schedules && ctx.schedules.length > 0) {
    parts.push(`【定时任务】（已登记，到点服务器会自动跑；重复的不用再登记，Schedule.cancel n 取消第 n 条）\n${ctx.schedules.map((item, index) => `${index + 1}. ${describeWhen(item.time, item.tz)}：${clip(oneLine(item.task), 200)}`).join("\n")}`);
  }
  if (ctx.notes && ctx.notes.length > 0) {
    parts.push(`【记住的】（你之前用 Memory.remember 记下的，对这个工作区一直有效）\n${ctx.notes.map((note, index) => `${index + 1}. ${note}`).join("\n")}`);
  }
  const history = ctx.history ? historyBlock(ctx.history) : "";
  if (history) parts.push(history);
  const shown = ctx.files.slice(0, FILES_LISTED).map((file) => `- ${file.path}（${file.image ? "图片，" : ""}${kb(file.bytes)}）`);
  const more = ctx.files.length > FILES_LISTED ? `\n…共 ${ctx.files.length} 个文件` : "";
  parts.push(`【工作区现在有】\n${shown.length ? shown.join("\n") + more : "（空，还没有文件）"}`);
  const last = ctx.last;
  if (last?.kind === "compile_failed") {
    parts.push(`【上一步没有执行：编译失败】\n${clip(last.message, 1_500)}${last.code ? `\n\n上一步的代码（只改出错的地方，其余照抄）：\n${clip(last.code, 3_000)}` : ""}`);
  } else if (last?.kind === "ran") {
    const lines = last.effects.slice(0, EFFECTS_LISTED).map(effectLine);
    const extra = last.effects.length > EFFECTS_LISTED ? `\n…还有 ${last.effects.length - EFFECTS_LISTED} 次调用` : "";
    const failedNow = last.effects.filter((effect) => isCheckEffect(effect.tool) && !effect.output.startsWith("通过"));
    const retreat = failedNow.length && last.reply === "continue" ? `\n有 ${failedNow.length} 条断言没通过。先想清楚是改错了还是没改到：改错了就 Files.restore 退回那个文件重做，别在错的基础上继续堆。` : "";
    parts.push(`【上一步（第 ${last.round} 轮）执行了，返回 ${last.reply}${last.text.trim() ? `：${clip(last.text.trim(), 300)}` : ""}】\n${lines.length ? lines.join("\n") + extra : "（没有任何调用）"}${retreat}`);
  } else if (last?.kind === "runner_failed") {
    parts.push(`【上一步没有跑起来】\n${clip(last.message, 600)}`);
  } else if (last?.kind === "model_error" && last.message === BUDGET_CUT_NOTE) {
    parts.push("【上一轮没跑完】上一段的时间用完时你的回复还没到，那一轮作废了；工作区和计划都是上面这样，接着做就行。");
  } else if (last?.kind === "model_error") {
    parts.push(`【上一轮模型没有回应】\n${clip(last.message, 400)}`);
  }
  if (ctx.images && ctx.images.length > 0) {
    parts.push(
      ctx.visionFailed
        ? `【图片】工作区里有 ${ctx.images.length} 张图片（${ctx.images.join("、")}），但这次模型接口没有接受图片，你看不到它们的内容。如实说明，不要猜。`
        : `【图片】下面 ${ctx.images.length} 张图片已经附在这条提示里，你现在就能看到：${ctx.images.join("、")}。要描述或判断它们，直接看图写结论。`,
    );
  }
  if (ctx.plan && ctx.plan.length > 0) {
    const done = ctx.plan.filter((item) => item.done).length;
    const lines = ctx.plan.map((item, index) => `${item.done ? "[x]" : "[ ]"} ${index + 1}. ${item.text}${item.done && item.note ? ` — ${clip(item.note, 160)}` : ""}`);
    parts.push(`【计划 ${done}/${ctx.plan.length}】\n${lines.join("\n")}${done < ctx.plan.length ? "\n接着做第一条没打勾的；做完用 Plan.tick 打勾。" : "\n都打勾了。核对一下就可以 Done。"}`);
  }
  if (ctx.check) {
    const open = ctx.plan?.flatMap((item, index) => (item.done ? [] : [`${index + 1}. ${item.text}`])) ?? [];
    const failed = ctx.checkFailed ?? [];
    const written = (ctx.written ?? []).slice(-MAX_WRITTEN_LISTED);
    const targets = [written.length ? `这次任务写过的文件：${written.join("、")}` : "", ctx.modules?.length ? `装着的 module：${ctx.modules.join("、")}` : ""].filter(Boolean).join("；");
    if (failed.length) {
      parts.push(
        `【核对没通过，不能这样结束】你上一步想用这个答案结束：「${clip(ctx.check, 500)}」，但这些断言没通过：${failed.map((item) => `「${clip(item, 160)}」`).join("、")}。先分清是文件错了还是断言写错了：【上一步】里没通过的那条后面带着文件里实际的内容——内容其实在、只是写法不同（中文名 / 英文名、大小写、多个空格），就按文件里实际写的改断言；真缺就补上；改坏了就 Files.restore "path" 退回任务开始时的版本重做。然后把断言再写一遍，全部通过才 Done。确实做不成，再用 Partial 说清楚哪一条做不到，不要把没通过的当做完，也不要没看过文件就放弃。`,
      );
    } else {
      parts.push(
        `【收尾前核对】你上一步想用这个答案结束：「${clip(ctx.check, 500)}」。上一步的修改都已经生效（结果在【上一步】里），不要再做一遍——再 replace 同一段旧文本会因为已经改过而找不到。这一步用断言核对：对任务要求的每一点写一条 Check.contains "path" "必须出现的内容"（文件）、Check.that (条件) "说明" 或 Check.equal 期望 实际 "说明"（装好的 module 算一个已知值），每条的通过 / 没通过都会记进时间线。${targets ? `${targets}。` : ""}${open.length ? `计划里还有没打勾的：${open.join("；")}——做完或说明为什么不用做。` : ""}断言全部通过，就在同一步 Done，答案可以修正；有没通过的，就在同一步修好再 Done，或 Partial 说明。`,
      );
    }
  }
  const seconds = Math.max(0, Math.round(ctx.remainingMs / 1000));
  const segment = ctx.segment > 1 ? `这是接着上一段继续的第 ${ctx.segment} 段。` : "";
  parts.push(`【进度】这是第 ${ctx.round} 轮。${segment}这一段还剩约 ${seconds} 秒；时间用完会暂停，之后从工作区和笔记接着做，所以每一轮都要留下有效果的事。`);
  return clip(parts.join("\n\n"), MAX_CONTEXT);
}

// ---------------------------------------------------------------------------

/** Validates the desk a page wants stored: the same caps a run enforces. */
export function parseDeskState(input: unknown): DeskState | { error: string } {
  if (!input || typeof input !== "object") return { error: "请求不对" };
  const rawFiles = "files" in input && Array.isArray(input.files) ? input.files : null;
  if (!rawFiles) return { error: "请求里没有工作区。" };
  if (rawFiles.length > MAX_FILES) return { error: `工作区里有 ${rawFiles.length} 个文件，最多 ${MAX_FILES} 个。` };
  const files: DeskFile[] = [];
  let total = 0;
  for (const file of rawFiles) {
    if (!file || typeof file !== "object") return { error: "工作区文件不对。" };
    const path = "path" in file && typeof file.path === "string" ? file.path : "";
    const content = "content" in file && typeof file.content === "string" ? file.content : "";
    if (!safePath(path)) return { error: `不能收下 ${path || "这个文件"}。` };
    if (isScratchFile(path)) continue;
    const size = Buffer.byteLength(content);
    if (size > MAX_FILE_BYTES) return { error: `${path} 有 ${Math.round(size / 1024)} KB，单个文件最多 ${MAX_FILE_BYTES / 1024} KB。缩小或删掉它再试。` };
    total += size;
    files.push({ path, content });
  }
  if (total > MAX_WORKSPACE_BYTES) {
    const biggest = [...files].sort((a, b) => b.content.length - a.content.length).slice(0, 3).map((file) => file.path);
    return { error: `工作区一共 ${(total / 1024 / 1024).toFixed(1)} MB，最多 ${MAX_WORKSPACE_BYTES / 1024 / 1024} MB。最大的几个：${biggest.join("、")}。删掉用不着的再试。` };
  }
  const harnesses = normalizeHarnesses("harnesses" in input ? input.harnesses : undefined);
  const modules = normalizeModules("modules" in input ? input.modules : undefined);
  const journal = normalizeJournal("journal" in input ? input.journal : undefined);
  const memory = "memory" in input && typeof input.memory === "string" ? input.memory.slice(0, 4000) : "";
  const notes = normalizeNotes("notes" in input ? input.notes : undefined);
  return { files, harnesses, modules, journal, memory, notes };
}

function normalizeJournal(raw: unknown): JournalItem[] {
  if (!Array.isArray(raw)) return [];
  const items: JournalItem[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const kind = "kind" in item && typeof item.kind === "string" ? item.kind.slice(0, 40) : "";
    const text = "text" in item && typeof item.text === "string" ? item.text.slice(0, 4000) : "";
    if (!kind) continue;
    items.push({ kind, text });
    if (items.length >= 40) break;
  }
  return items;
}

function block(text: string): string {
  const body = Buffer.from(text, "utf8");
  return `${body.length}\n${body.toString("utf8")}\n`;
}

type Effort = "low" | "medium";

export type ModelImage = { path: string; dataUrl: string };

// How many pictures ride along with a round; the newest win.
export const MAX_IMAGES_SHOWN = 4;

type AskOptions = { signal?: AbortSignal; effort?: Effort; images?: ModelImage[]; onVisionFailed?: () => void };

// A busy or briefly failing endpoint (429, 5xx, a dropped connection) is
// asked again after these pauses before the round is given up.
const MODEL_RETRY_MS = [1_000, 3_000];

function retryable(status: number): boolean {
  return status === 429 || status === 408 || status >= 500;
}

const pause = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });

async function askModel(apiKey: string, prompt: string, context: string, harnesses: HarnessId[], modules: DeskModule[], opts: AskOptions = {}): Promise<string> {
  const { signal, effort = "low", images = [] } = opts;
  const input = `${prompt.slice(0, MAX_PROMPT)}\n\n${context}`;
  const content =
    images.length > 0
      ? [{ type: "input_text", text: input }, ...images.map((image) => ({ type: "input_image", image_url: image.dataUrl, detail: "auto" }))]
      : input;
  const body = JSON.stringify({
    model: "grok-4.5",
    reasoning: { effort },
    max_output_tokens: 6000,
    instructions: instructionsFor(harnesses, modules),
    input: [{ role: "user", content }],
  });
  for (let attempt = 0; ; attempt += 1) {
    const slowGuard = AbortSignal.timeout(90_000);
    const again = attempt < MODEL_RETRY_MS.length && !signal?.aborted;
    try {
      const response = await fetch("https://api.x.ai/v1/responses", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        signal: signal ? AbortSignal.any([slowGuard, signal]) : slowGuard,
        body,
      });
      if (!response.ok && retryable(response.status) && again) {
        await pause(MODEL_RETRY_MS[attempt] ?? 0, signal);
        continue;
      }
      if (!response.ok && images.length > 0 && response.status >= 400 && response.status < 500) {
        // The endpoint would not take the pictures: say so in the next
        // context and ask again with text only, rather than failing the round.
        opts.onVisionFailed?.();
        return askModel(apiKey, prompt, context, harnesses, modules, { ...opts, images: [] });
      }
      if (!response.ok) return `error\n${block(`模型没有接上（${response.status}${attempt ? `，重试 ${attempt} 次后仍然如此` : ""}）。`)}`;
      const reply = (await response.json()) as ResponseBody;
      const text = textOf(reply);
      if (text) return `text\n${block(text)}`;
      const calls = (reply.output ?? []).filter((item) => item.type === "function_call" && item.name);
      if (calls.length > 0) return `text\n${block("没有按格式输出。只写一个 ocaml 代码块，里面是 module Step。")}`;
      return `text\n${block("没有输出")}`;
    } catch (err: unknown) {
      const slow = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
      // The loop itself called the call off (budget, stop): nothing to retry.
      if (signal?.aborted) return `error\n${block("这一步被叫停了。")}`;
      if (!slow && again) {
        await pause(MODEL_RETRY_MS[attempt] ?? 0, signal);
        continue;
      }
      const message = slow ? "模型太慢，这一步停了。点继续可以接着做。" : err instanceof Error ? err.message : `模型没有回应（${String(err)}）`;
      return `error\n${block(message)}`;
    }
  }
}

export type RunHooks = {
  signal?: AbortSignal;
  onCall?: (tool: string, detail: string) => void;
  modules?: () => DeskModule[];
  onModule?: (mod: DeskModule) => void;
  onUnload?: (name: string) => void;
  origin?: () => Record<string, string | null>;
  onOrigin?: (path: string, content: string | null) => void;
  /** Sends a line to the desk's notify address; absent when the desk has none. */
  notify?: (text: string) => Promise<NotifySent>;
};

// Verified loads win over the loop's own bookkeeping for the same name, and
// a module the run unloaded stays unloaded even if the loop still lists it.
export function mergeModules(fromLoop: DeskModule[], loaded: DeskModule[], unloaded: Iterable<string> = []): DeskModule[] {
  const merged = new Map<string, DeskModule>();
  for (const mod of fromLoop) merged.set(mod.name, mod);
  for (const mod of loaded) merged.set(mod.name, mod);
  for (const name of unloaded) merged.delete(name);
  return normalizeModules([...merged.values()]);
}

// How the loop was cut short, when it was.
export type HaltReason = "budget" | "compile_stall" | "idle_stall" | "runner";

export const ROUND_BUDGET_MS = 70_000;
// A round is not started with less than this left: a model call with
// reasoning rarely answers faster, and one cut off at the budget is a round
// paid for and thrown away.
const MIN_ROUND_MS = 20_000;
// When the budget runs out while a model call or a step is in flight, it is
// given this much longer to finish rather than being killed on the spot; the
// pause comes before the next round instead.
export const BUDGET_GRACE_MS = 30_000;
const BUDGET_CUT_NOTE = "这一段时间用完了，这轮没等到模型回复；下一段从这里重来。";
const MAX_COMPILE_STALL = 4;
const MAX_IDLE_STALL = 5;
const MAX_RUNNER_STALL = 2;
// Effects that change the desk: a run that did any of these gets a check round.
const WRITES = new Set(["Files.write_file", "Files.replace", "Files.append", "Files.delete_file", "Files.restore", "Harness.load", "Harness.install"]);
const FILE_WRITES = new Set(["Files.write_file", "Files.replace", "Files.append", "Files.restore"]);

// A Done can be held for a check at most this many times in a run: once for
// having no check at all, once more for a check that failed.
const MAX_CHECK_HOLDS = 2;

// True when the step asserted something about its work (Check.*) and every
// assertion passed: the model checked itself, so no check round is needed.
export function assertedInStep(effects: { tool: string; detail: string; output: string }[]): boolean {
  const verdicts = checkVerdicts(effects);
  return verdicts.length > 0 && verdicts.every((item) => item.ok);
}

// Failed Check.contains assertions on files that exist but were never read in
// this step. A Partial on the strength of those alone is giving up blind: the
// file may well hold the content in other words (北京 where the check said
// Beijing), so the model is sent to look before it concedes.
export function blindMisses(effects: { tool: string; detail: string; output: string }[]): string[] {
  const read = new Set(effects.filter((effect) => effect.tool === "Files.read_file" && effect.output.startsWith("Ok")).map((effect) => effect.detail));
  return effects
    .filter((effect) => effect.tool === "Check.contains" && effect.output.startsWith("没通过：文件里没有这段") && !read.has(effect.detail.split(" 含 ")[0] ?? ""))
    .map((effect) => effect.detail);
}

// ---------------------------------------------------------------------------
// Placeholder detection. A task about "我的名字 / 我的城市 …" needs a fact only
// the user has. When the answer or a written file carries a stand-in instead
// (your_name, <名字>, 某某, a parameter to fill in later) and nothing the desk
// remembers or the conversation said supplies it, the Done becomes an Ask.

const TOPICS = "名字|姓名|城市|生日|地址|公司|邮箱|电话|手机号|年龄|家乡|学校|职业|微信|网站|昵称|公众号|博客|团队|产品|项目名";
const PERSONAL = new RegExp(`我的\\s*(${TOPICS})`, "g");
// Mentions of the topic that do not supply it: the ask itself, and our own question.
const TOPIC_MENTION = new RegExp(`(我的|你的|您的)\\s*(${TOPICS})|还差一样只有你知道的[^\\n]*`, "g");
// Words that would supply the fact when they appear in notes or the conversation.
const SUPPLIED: Record<string, RegExp> = {
  名字: /叫|名字|姓名|我是/,
  姓名: /叫|名字|姓名|我是/,
  昵称: /叫|昵称|名字/,
  城市: /城市|在\S{1,6}(市|区|县)|住在|我在|来自|家在|定居|搬到|北京|上海|深圳|广州|杭州|成都|武汉|南京|西安|重庆|苏州|香港|台北|东京|大阪|首尔|新加坡|纽约|伦敦|巴黎|柏林|悉尼|多伦多|洛杉矶|旧金山|西雅图/,
  家乡: /家乡|老家|来自|出生/,
  生日: /生日|出生|\d{1,2}\s*月\s*\d{1,2}/,
  地址: /地址|住在|路|街|号/,
  公司: /公司|就职|上班|在\S{1,10}工作/,
  邮箱: /邮箱|@/,
  电话: /电话|手机|\d{7,}/,
  手机号: /手机|电话|\d{7,}/,
  年龄: /年龄|\d{1,2}\s*岁|出生/,
  学校: /学校|大学|学院|就读/,
  职业: /职业|工作|做.{0,4}的|工程师|设计师|老师|学生/,
  微信: /微信/,
  网站: /网站|https?:\/\//,
  公众号: /公众号/,
  博客: /博客|https?:\/\//,
  团队: /团队/,
  产品: /产品/,
  项目名: /项目/,
};
const PLACEHOLDER = /your[_ ]?(name|city|email|phone|address|company|birthday|age)|<[^>\n]{1,12}>|\[[^\]\n]{1,12}\]|【[^】\n]{1,12}】|\{\{[^}\n]{1,24}\}\}|某某|[xX]{3,}|_{3,}|示例|样例|你的(名字|姓名|城市|生日|地址|公司|邮箱|电话|年龄|家乡|学校|职业)|用户名|占位|placeholder|待填|请填|填写|填入|TODO|FIXME|改成参数|作为参数|传入|参数化|user_?name|john|jane|张三|李四|小明/i;

export type MissingInput = { topics: string[]; question: string };

export function missingInput(task: string, answer: string, written: { path: string; content: string }[], known: string): MissingInput | null {
  const topics = [...new Set([...task.matchAll(PERSONAL)].map((match) => match[1] ?? "").filter(Boolean))];
  if (topics.length === 0) return null;
  const supplied = known.replace(TOPIC_MENTION, "");
  const unknown = topics.filter((topic) => !(SUPPLIED[topic] ?? /$^/).test(supplied));
  if (unknown.length === 0) return null;
  const haystack = [answer, ...written.map((file) => file.content)].join("\n");
  if (!PLACEHOLDER.test(haystack)) return null;
  const list = unknown.map((topic) => `你的${topic}`).join("、");
  return { topics: unknown, question: `还差一样只有你知道的：${list}。现在写的是占位，告诉我之后我会直接填进去。` };
}

// ---------------------------------------------------------------------------
// Things a run cannot do: it exists only while the user's request is served.
// A Done on a task that asks for a schedule, a reminder, a background job or
// an outbound message is a claim nothing will honour, so it becomes a Partial
// that says what is missing.

// `reminder` and `message` are within reach once the desk has a schedule or
// a notify address respectively; the others never are.
const BEYOND: { pattern: RegExp; what: string; via?: "schedule" | "notify" }[] = [
  { pattern: /提醒我|过\s*\S{1,6}\s*(提醒|叫我|通知我)|闹钟/, what: "过一会儿提醒", via: "schedule" },
  { pattern: /后台(一直|持续|常驻)|一直(跑|运行|盯着|监控)|持续(监控|运行)|常驻/, what: "后台一直运行" },
  { pattern: /发\s*(邮件|短信)|邮件(发|通知)|email|短信/i, what: "发邮件或短信" },
  { pattern: /发\s*(微信|消息|通知)|推送(到|给)|通知我/, what: "发消息", via: "notify" },
];
const BEYOND_NOTE = "我没有这个能力";
const UNSCHEDULED_NOTE = "这不能算做成";
const UNSCHEDULED_WHAT = "定时（没有用 Schedule.daily 登记）";
const UNSENT_WHAT = "发消息（没有用 Notify.send 发出去）";
const alreadyTold = (text: string) => text.includes(BEYOND_NOTE) || text.includes(UNSCHEDULED_NOTE);

export type BeyondReach = { what: string; note: string };

/** What this run can lean on: did it register a schedule; does the desk have a notify address, and was it used. */
export type Reach = { scheduled?: boolean; notify?: "none" | "unused" | "sent" };

/**
 * Why a Done cannot stand: the task asked for something no run can do, or
 * asked for a schedule / a message and none was registered / sent (a script
 * in the workspace is neither).
 */
export function beyondReach(task: string, reply: string, reach: Reach | boolean = {}): BeyondReach | null {
  if (reply !== "done") return null;
  const { scheduled = false, notify = "none" } = typeof reach === "boolean" ? { scheduled: reach } : reach;
  if (asksForSchedule(task) && !scheduled) {
    return {
      what: UNSCHEDULED_WHAT,
      note: `（${UNSCHEDULED_NOTE}：任务要的是定时，但这次没有登记定时任务。工作区里的脚本不会在到点时自己执行；只有用 Schedule.daily 登记的才会由服务器每天到点跑一次。上面是现在做到的部分；要定时，再对我说一句「每天几点做什么」。）`,
    };
  }
  const hit = BEYOND.find((item) => item.pattern.test(task));
  if (!hit) return null;
  if (hit.via === "schedule" && scheduled) return null;
  if (hit.via === "notify") {
    if (notify === "sent") return null;
    if (notify === "unused") {
      return { what: UNSENT_WHAT, note: `（${UNSCHEDULED_NOTE}：任务要发消息，这个工作区接着通知地址，但这次没有用 Notify.send 发出去。上面是做到的部分；要发，再对我说一句。）` };
    }
    return { what: hit.what, note: `（${BEYOND_NOTE}：${hit.what}。这个工作区还没有通知地址，我发不出消息。上面是现在能做到的部分；在面板「通知」里填一个飞书 / 钉钉 / 企业微信 / Slack 机器人的 webhook 地址，之后对我说一句就能发到那里。）` };
  }
  return {
    what: hit.what,
    note: `（${BEYOND_NOTE}：${hit.what}。我只在被叫到时跑一次，发不出邮件和短信，也不会一直等着。上面是现在能做到的部分；要再来一次，到时候对我说一句就行。）`,
  };
}

// True when the step read back what the run wrote: every file this step
// changed is read (successfully) after its last change, and at least one file
// written in this run is read. Such a step verified itself, so holding its
// Done for a check round would only invite redoing the work.
export function readBackInStep(effects: { tool: string; detail: string; output: string }[], written: ReadonlySet<string>): boolean {
  const lastWrite = new Map<string, number>();
  effects.forEach((effect, index) => {
    if (FILE_WRITES.has(effect.tool) && effect.output.startsWith("Ok")) lastWrite.set(effect.detail, index);
  });
  const readAfter = (path: string, at: number) => effects.some((effect, index) => index > at && effect.tool === "Files.read_file" && effect.detail === path && effect.output.startsWith("Ok"));
  for (const [path, at] of lastWrite) if (!readAfter(path, at)) return false;
  return [...written].some((path) => readAfter(path, lastWrite.get(path) ?? -1));
}

export function runBudgetMs(): number {
  const raw = Number(process.env.OCAGENT_RUN_BUDGET_MS);
  return Number.isFinite(raw) && raw >= 15_000 ? raw : ROUND_BUDGET_MS;
}

export type LoopDeps = {
  runCore: (job: CoreJob, handlers: CoreHandlers, hooks?: RunHooks) => Promise<CoreResult>;
  runPayload: (payload: string, harnesses: HarnessId[], apiKey: string | undefined, hooks?: RunHooks) => Promise<string>;
  emit?: (event: AgentEventBody) => void;
  signal?: AbortSignal;
  /** Wall-clock budget for this request; the loop pauses (resumably) when it runs out. */
  budgetMs?: number;
  /** How long a model call or step already in flight at the deadline may go on (default BUDGET_GRACE_MS). */
  graceMs?: number;
  /** Least time left for a round to be started (default MIN_ROUND_MS; tests shorten it). */
  minRoundMs?: number;
  /** Modules that failed the pre-flight compile and were left out of this run. */
  dropped?: { name: string; error: string }[];
  /** Rounds already done by earlier segments of this run; numbering continues from here. */
  roundBase?: number;
  /** Which segment of the run this is (1 for a fresh run). */
  segment?: number;
  /** The last step's outcome from the segment before, when it was cut short mid-thought. */
  last?: LastOutcome;
  /** The plan and check state earlier segments left; a fresh run starts empty. */
  plan?: PlanState;
  /** Earlier exchanges in this desk, oldest first, for follow-ups to read against. */
  history?: HistoryItem[];
  /** What the agent remembered about this desk so far (Memory.remember). */
  notes?: string[];
  /** Daily schedules the desk already has, for the prompt and Schedule.cancel numbering. */
  schedules?: ScheduleSpec[];
  /** Whether this run already registered a schedule in an earlier segment. */
  scheduledBefore?: boolean;
  /** This run was started by a schedule, not the user. */
  scheduled?: boolean;
  /** The desk's notify address, when it has one: Notify.send goes here. */
  notifyUrl?: string;
  /** Whether an earlier segment of this run already sent a message. */
  notifiedBefore?: boolean;
  /** Delivery, replaceable in tests. */
  sendNotify?: (url: string, text: string) => Promise<NotifySent>;
};

export async function runDeskLoop(
  apiKey: string,
  task: string,
  files: DeskFile[],
  harnesses: HarnessId[],
  modules: DeskModule[] = [],
  journal: JournalItem[] = [],
  memory = "",
  deps: LoopDeps,
): Promise<DeskResult> {
  const emit = deps.emit ?? (() => {});
  const roundBase = deps.roundBase ?? 0;
  const segment = deps.segment ?? 1;
  let round = roundBase;
  // Modules loaded during this run join the ones the desk had, so every later
  // step (and every later prompt) sees them.
  const loaded: DeskModule[] = [...modules];
  const unloaded = new Set<string>();
  const addModule = (mod: DeskModule) => {
    const at = loaded.findIndex((item) => item.name === mod.name);
    if (at >= 0) loaded[at] = mod;
    else loaded.push(mod);
    unloaded.delete(mod.name);
    emit({ kind: "module", round, name: mod.name, exports: moduleExports(mod.body) });
  };
  const dropModule = (name: string) => {
    const at = loaded.findIndex((item) => item.name === name);
    if (at >= 0) loaded.splice(at, 1);
    unloaded.add(name);
  };
  // What the next prompt is told about: the workspace as the last step left
  // it, and how that step went.
  let fileIndex: FileEntry[] = files.map((file) => (isImageFile(file) ? { path: file.path, bytes: imageBytes(file), image: true } : { path: file.path, bytes: Buffer.byteLength(file.content) }));
  // Pictures the user put in the desk are shown to the model every round
  // (steps cannot make new ones, so the starting set is the set).
  const images: ModelImage[] = files.filter(isImageFile).slice(-MAX_IMAGES_SHOWN).map((file) => ({ path: file.path, dataUrl: file.content }));
  let visionFailed = false;
  let lastCode = "";
  let last: LastOutcome = deps.last ?? null;
  // The plan the model keeps with Plan.set / Plan.tick, and the pre-finish
  // check: the first Done of a run that wrote anything is held for one more
  // round so the model verifies its work before the answer goes out.
  const plan: PlanState = deps.plan ? { ...deps.plan, items: deps.plan.items.map((item) => ({ ...item })) } : emptyPlan();
  // Long-lived notes about the desk; steps add to them with Memory.remember.
  const notes: string[] = [...(deps.notes ?? [])];
  // Files this task wrote, so a later step's read-back counts as its check and
  // the check prompt can name them.
  const written = new Set<string>(plan.written);
  // What the user has already told the desk, for the placeholder check.
  const known = [task, ...notes, ...(deps.history ?? []).flatMap((item) => [item.task, item.answer])].join("\n");
  // Daily schedules as the model sees them (numbered), and whether this run registered one.
  const schedules: ScheduleSpec[] = [...(deps.schedules ?? [])];
  let scheduled = deps.scheduledBefore ?? false;
  // Whether a Notify.send of this run went through (for "send me" tasks).
  const notifyUrl = deps.notifyUrl?.trim() ?? "";
  const notifyVia = notifyUrl ? notifyName(notifyKind(notifyUrl)) : "";
  let notified = deps.notifiedBefore ?? false;
  // The loop is cut (and resumed by the page) when the request's time budget
  // runs out, and stopped when it keeps failing to compile or doing nothing.
  const halt = new AbortController();
  let haltReason: HaltReason | null = null;
  let haltDetail = "";
  const cut = (reason: HaltReason, detail = "") => {
    if (haltReason) return;
    haltReason = reason;
    haltDetail = detail;
    halt.abort(reason);
  };
  const signal = deps.signal ? AbortSignal.any([deps.signal, halt.signal]) : halt.signal;
  const budgetMs = deps.budgetMs ?? runBudgetMs();
  const deadline = Date.now() + budgetMs;
  // At the deadline, whatever is in flight gets the grace to finish; the
  // next model call then pauses the segment. Only after the grace is the
  // round cut off for real.
  let budgetHit = false;
  const grace = deps.graceMs ?? BUDGET_GRACE_MS;
  // A short budget (tests, a tight deployment) still gets rounds.
  const minRound = deps.minRoundMs ?? Math.min(MIN_ROUND_MS, Math.floor(budgetMs / 3));
  const timer = setTimeout(() => {
    budgetHit = true;
    if (grace <= 0) cut("budget");
    else graceTimer = setTimeout(() => cut("budget"), grace);
  }, budgetMs);
  let graceTimer: ReturnType<typeof setTimeout> | null = null;
  let compileStall = 0;
  let idleStall = 0;
  let runnerStall = 0;
  try {
    let redirects = 0;
    emit({ kind: "start", task });
    for (const gone of deps.dropped ?? []) emit({ kind: "module_dropped", name: gone.name, reason: gone.error });
    const result = await deps.runCore(
      { task, harnesses, files, modules, journal, memory },
      {
        model: async (prompt) => {
          if (budgetHit || deadline - Date.now() < minRound) {
            // Not enough time left for a round; pause now instead of leaving a
            // model call half-finished when the budget runs out.
            cut("budget");
            return `error\n${block("这一段时间用完了。")}`;
          }
          round += 1;
          emit({ kind: "think", round });
          const shownImages = images.filter((image) => fileIndex.some((file) => file.path === image.path));
          const context = promptContext({
            round,
            segment,
            remainingMs: deadline - Date.now(),
            files: fileIndex,
            last,
            plan: plan.items,
            check: plan.pending,
            checkFailed: plan.failed,
            written: [...written],
            modules: loaded.map((mod) => mod.name),
            images: shownImages.map((image) => image.path),
            visionFailed,
            history: deps.history,
            notes,
            schedules,
            scheduled: deps.scheduled,
            notify: notifyVia || undefined,
          });
          plan.pending = null;
          plan.failed = [];
          // A failed compile deserves a more careful second look.
          const effort: Effort = last?.kind === "compile_failed" ? "medium" : "low";
          const raw = await askModel(apiKey, prompt, context, harnesses, loaded, {
            signal,
            effort,
            images: visionFailed ? [] : shownImages,
            onVisionFailed: () => {
              visionFailed = true;
            },
          });
          const reply = describeModelReply(raw);
          if (reply?.kind === "error" && haltReason === "budget") {
            // The grace ran out too: not the model's fault, and the next
            // segment asks again from the same place.
            emit({ kind: "model_error", round, message: BUDGET_CUT_NOTE, budget: true });
            last = { kind: "model_error", message: BUDGET_CUT_NOTE };
          } else if (reply?.kind === "error") {
            emit({ kind: "model_error", round, message: reply.message });
            last = { kind: "model_error", message: reply.message };
          } else if (reply?.kind === "text") {
            lastCode = extractCode(reply.text) || reply.text;
            emit({ kind: "plan", round, code: lastCode });
          }
          return raw;
        },
        ocaml: async (payload) => {
          const isStep = payload.startsWith("step\n");
          if (isStep) emit({ kind: "run", round });
          let raw: string;
          try {
            raw = await deps.runPayload(payload, harnesses, apiKey, {
              signal,
              onCall: (tool, detail) => emit({ kind: "call", round, tool, detail }),
              notify: notifyUrl
                ? async (text) => {
                    const sent = await (deps.sendNotify ?? sendNotify)(notifyUrl, text);
                    if (sent.ok) notified = true;
                    emit(sent.ok ? { kind: "notify", round, ok: true, where: sent.where } : { kind: "notify", round, ok: false, where: sent.where, error: sent.error });
                    return sent;
                  }
                : undefined,
              modules: () => loaded,
              onModule: addModule,
              onUnload: dropModule,
              origin: () => ({ ...plan.origin }),
              onOrigin: (path, content) => {
                if (!(path in plan.origin)) plan.origin = boundOrigin({ ...plan.origin, [path]: content });
              },
            });
          } catch (err) {
            // The runner, not the step's code, failed: another model round
            // cannot fix that, so two in a row end the run with the reason.
            const message = err instanceof Error && err.message.trim() ? err.message : "这一步没有跑起来。";
            if (isStep) emit({ kind: "runner_failed", round, message });
            last = { kind: "runner_failed", message };
            runnerStall += 1;
            if (runnerStall >= MAX_RUNNER_STALL) cut("runner", message);
            return `fail\n${block(message)}`;
          }
          runnerStall = 0;
          const next = rewriteStep(raw, task, redirects);
          if (next.usedRedirect) redirects += 1;
          if (isStep) {
            const frame = describeStepFrame(next.raw);
            if (frame?.kind === "fail") {
              emit({ kind: "compile_failed", round, message: frame.message });
              last = { kind: "compile_failed", message: frame.message, code: lastCode };
              compileStall += 1;
              idleStall = 0;
              if (compileStall >= MAX_COMPILE_STALL) cut("compile_stall", frame.message);
            } else if (frame?.kind === "ok") {
              if (applyPlanEffects(plan, frame.effects)) emit({ kind: "todo", round, items: plan.items.map((item) => ({ ...item })) });
              for (const change of applyMemoryEffects(notes, frame.effects)) emit({ kind: "remember", round, text: change.text, forgot: change.forgot });
              for (const change of scheduleChanges(frame.effects)) {
                if (change.kind === "daily") {
                  if (!schedules.some((item) => item.time === change.spec.time && item.tz === change.spec.tz && item.task === change.spec.task)) schedules.push(change.spec);
                  scheduled = true;
                  emit({ kind: "schedule", round, ...change.spec });
                } else if (change.n <= schedules.length) {
                  const [gone] = schedules.splice(change.n - 1, 1);
                  if (gone) emit({ kind: "unschedule", round, n: change.n, ...gone });
                }
              }
              const effects = frame.effects.filter((effect) => !isPlanEffect(effect.tool) && !isMemoryEffect(effect.tool) && !(isScheduleEffect(effect.tool) && effect.output.startsWith("Ok")) && effect.tool !== "Schedule.cancel" && effect.tool !== "Notify.send");
              for (const effect of effects) emit({ kind: "effect", round, ...effect });
              if (effects.some((effect) => WRITES.has(effect.tool) && effect.output.startsWith("Ok"))) plan.wrote = true;
              for (const effect of effects) if (FILE_WRITES.has(effect.tool) && effect.output.startsWith("Ok")) written.add(effect.detail);
              plan.written = [...written].slice(-MAX_WRITTEN_LISTED);
              let reply = frame.reply;
              let text = frame.text;
              let raw = next.raw;
              if (reply === "done") {
                // A fact only the user has, stood in for by a placeholder: ask
                // for it instead of handing over a result that is not theirs.
                const wroteNow = (frame.files ?? []).filter((file) => written.has(file.path) && file.content);
                const missing = missingInput(task, frame.text, wroteNow, known);
                const asked = missing ? patchFrame(raw, { kind: "ask", text: missing.question }) : null;
                if (missing && asked) {
                  raw = asked;
                  reply = "ask";
                  text = missing.question;
                  emit({ kind: "need_input", round, topics: missing.topics, question: missing.question });
                }
              }
              if (reply === "done" && plan.checks < MAX_CHECK_HOLDS) {
                // Held once when nothing was checked, and (once more) when an
                // assertion failed: a Done has to be backed by passing checks.
                const failed = checkVerdicts(effects).filter((item) => !item.ok).map((item) => item.desc);
                const unchecked = plan.checks === 0 && plan.wrote && !readBackInStep(effects, written) && !assertedInStep(effects);
                const open = plan.checks === 0 && plan.items.some((item) => !item.done);
                const held = failed.length > 0 || unchecked || open ? holdDone(raw) : null;
                if (held) {
                  plan.checks += 1;
                  plan.pending = frame.text;
                  plan.failed = failed;
                  raw = held;
                  reply = "continue";
                  emit({ kind: "check", round, answer: frame.text, failed });
                }
              } else if (reply === "partial" && plan.checks < MAX_CHECK_HOLDS && blindMisses(effects).length > 0) {
                // Giving up on "the file does not contain it" without having
                // looked at the file: go and look first, then decide.
                const failed = checkVerdicts(effects).filter((item) => !item.ok).map((item) => item.desc);
                const held = patchFrame(raw, { kind: "continue" });
                if (held) {
                  plan.checks += 1;
                  plan.pending = frame.text;
                  plan.failed = failed;
                  raw = held;
                  reply = "continue";
                  emit({ kind: "check", round, answer: frame.text, failed, gaveUp: true });
                }
              } else if (reply === "done") {
                // Out of holds: a Done that still has failing assertions says so.
                const failed = checkVerdicts(effects).filter((item) => !item.ok).map((item) => item.desc);
                const marked = failed.length ? patchFrame(raw, { text: `${frame.text.trim()}\n\n（有 ${failed.length} 条核对没通过：${failed.map((item) => clip(item, 80)).join("；")}）` }) : null;
                if (marked) {
                  raw = marked;
                  text = `${frame.text.trim()}\n\n（有 ${failed.length} 条核对没通过：${failed.map((item) => clip(item, 80)).join("；")}）`;
                }
              }
              if (reply === "done") {
                // A Done on a task that needs a schedule, a reminder or an
                // outbound message claims something no one will carry out.
                const beyond = deps.scheduled ? null : beyondReach(task, reply, { scheduled, notify: !notifyUrl ? "none" : notified ? "sent" : "unused" });
                const told = alreadyTold(text) ? text : `${text.trim()}\n\n${beyond?.note ?? ""}`;
                const limited = beyond ? patchFrame(raw, { kind: "partial", text: told }) : null;
                if (beyond && limited) {
                  raw = limited;
                  reply = "partial";
                  text = told;
                  emit({ kind: "limit", round, what: beyond.what });
                }
              }
              emit({ kind: "step", round, reply, text });
              last = { kind: "ran", round, reply, text, effects };
              if (frame.files) fileIndex = frame.files.map((file) => (images.some((image) => image.path === file.path) ? { ...file, image: true } : file));
              compileStall = 0;
              idleStall = reply === "continue" && effects.length === 0 && !plan.pending ? idleStall + 1 : 0;
              if (idleStall >= MAX_IDLE_STALL) cut("idle_stall", frame.text);
              return raw;
            }
          }
          return next.raw;
        },
      },
      { signal },
    );
    const carried = {
      files: Array.isArray(result?.files) ? result.files : files,
      steps: Array.isArray(result?.steps) ? result.steps : [],
      modules: mergeModules(Array.isArray(result?.modules) ? result.modules : modules, loaded, unloaded),
      journal: Array.isArray(result?.journal) ? result.journal : journal,
      memory: typeof result?.memory === "string" ? result.memory : memory,
      notes,
      plan,
    };
    if (!result || (result.status !== "error" && result.status !== "stopped" && result.status !== "done")) {
      return { ok: false, error: "循环没有留下结果。", ...carried };
    }
    if (result.status === "error") return { ok: false, error: result.answer || "循环没有跑起来。", ...carried };
    if (haltReason === "budget") {
      return { ok: true, answer: pausedAnswer(round - roundBase, carried.steps), paused: true, ...carried, last: carryLast(last) };
    }
    if (haltReason) return { ok: false, error: stallAnswer(haltReason, haltDetail), ...carried };
    if (result.status === "stopped") return { ok: true, answer: result.answer, stopped: true, ...carried };
    return { ok: true, answer: presentAnswer(task, result.answer), ...carried };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "循环没有跑起来。",
      files,
      steps: [],
      modules,
      journal,
      memory,
      notes,
      plan,
    };
  } finally {
    clearTimeout(timer);
    if (graceTimer) clearTimeout(graceTimer);
  }
}

// A last outcome small enough to store with a paused run.
function carryLast(last: LastOutcome): LastOutcome {
  if (!last) return null;
  if (last.kind !== "ran") return { ...last, message: clip(last.message, 1_500), ...(last.kind === "compile_failed" ? { code: clip(last.code, 3_000) } : {}) } as LastOutcome;
  return { ...last, text: clip(last.text, 500), effects: last.effects.slice(0, 12).map((effect) => ({ tool: effect.tool, detail: clip(effect.detail, 200), output: clip(effect.output, 2_500) })) };
}

function pausedAnswer(rounds: number, steps: ToolStep[]): string {
  const done = steps.filter((step) => step.tool !== "compile").length;
  return `这一段时间用完了（${rounds} 轮，${done} 次调用），做到的都留在工作区里；接着做就会从这里继续。`;
}

function stallAnswer(reason: HaltReason, detail: string): string {
  const tail = detail.trim() ? `\n最近一次：${detail.trim().slice(0, 400)}` : "";
  if (reason === "compile_stall") return `连续 ${MAX_COMPILE_STALL} 轮写的代码都没编译过，先停下，免得空转。${tail}`;
  if (reason === "runner") return `执行这一步的环境出了问题，再来几轮也一样，先停下。${tail}`;
  return `连续 ${MAX_IDLE_STALL} 轮没有做任何事（没有读写、搜索、请求），先停下。换个说法再试，或把任务拆小。${tail}`;
}

type ResponseBody = {
  id?: string;
  output?: {
    type?: string;
    name?: string;
    call_id?: string;
    arguments?: string;
    content?: { text?: string }[];
    action?: { query?: string; sources?: { url?: string }[] };
  }[];
};

function textOf(body: ResponseBody): string {
  return (body.output ?? [])
    .filter((item) => item.type === "message")
    .flatMap((item) => item.content ?? [])
    .map((part) => part.text ?? "")
    .join("\n")
    .trim();
}

// ---------------------------------------------------------------------------
// Server functions. The desk lives in the database; a run is a row that any
// instance can report on, stop, or continue.

const DESK_ID = /^desk-[a-z0-9-]{8,48}$/;
const RUN_ID = /^run-[a-z0-9-]{8,48}$/;

export function isDeskId(value: unknown): value is string {
  return typeof value === "string" && DESK_ID.test(value);
}

export function isRunId(value: unknown): value is string {
  return typeof value === "string" && RUN_ID.test(value);
}

export function notifyInfo(url: string): NotifyInfo | null {
  if (!url) return null;
  let masked = url;
  try {
    const parsed = new URL(url);
    const tail = (parsed.pathname + parsed.search).replace(/[/?]+$/, "");
    masked = `${parsed.hostname}/…${tail.slice(-6)}`;
  } catch {
    masked = `${url.slice(0, 24)}…`;
  }
  return { where: notifyName(notifyKind(url)), masked };
}

function publicDesk(desk: DeskRecord): PublicDesk {
  return { id: desk.id, files: desk.files, harnesses: desk.harnesses, modules: desk.modules, notes: desk.notes, revision: desk.revision, notify: notifyInfo(desk.notifyUrl) };
}

function readDeskId(input: unknown): { deskId: string } {
  if (!input || typeof input !== "object") throw new Error("请求不对");
  const deskId = "deskId" in input ? input.deskId : null;
  if (!isDeskId(deskId)) throw new Error("工作区编号不对。");
  return { deskId };
}

function readRunId(input: unknown): { runId: string; after: number } {
  if (!input || typeof input !== "object") throw new Error("请求不对");
  const runId = "runId" in input ? input.runId : null;
  if (!isRunId(runId)) throw new Error("任务编号不对。");
  const rawAfter = "after" in input ? input.after : 0;
  const after = typeof rawAfter === "number" && Number.isInteger(rawAfter) && rawAfter >= 0 ? rawAfter : 0;
  return { runId, after };
}

export type DeskLoad = { found: false; durable: boolean } | { found: true; durable: boolean; desk: PublicDesk; runs: RunRecord[]; schedules: ScheduleRecord[] };

export const loadDesk = createServerFn({ method: "POST" })
  .validator(readDeskId)
  .handler(async ({ data }): Promise<DeskLoad> => {
    const store = await import("./store.server.ts");
    const durable = store.isDurable();
    const desk = await store.readDesk(data.deskId);
    if (!desk) return { found: false, durable };
    const runs = await store.listRuns(data.deskId);
    const schedules = await store.listSchedules(data.deskId);
    // A visit is also a chance to start any schedule whose time has come.
    const drive = await import("./drive.server.ts");
    await drive.kickSchedules(drive.selfOrigin());
    return { found: true, durable, desk: publicDesk(desk), runs, schedules };
  });

function readNotify(input: unknown): { deskId: string; url: string } {
  const { deskId } = readDeskId(input);
  const url = input && typeof input === "object" && "url" in input ? input.url : "";
  if (typeof url !== "string" || url.length > 2_000) throw new Error("地址不对。");
  return { deskId, url };
}

export type NotifySaved = { ok: true; notify: NotifyInfo | null } | { ok: false; error: string };

// The panel's notify address: checked, stored, and (when asked) tried once.
export const setNotify = createServerFn({ method: "POST" })
  .validator(readNotify)
  .handler(async ({ data }): Promise<NotifySaved> => {
    const checked = checkNotifyUrl(data.url);
    if (!checked.ok) return { ok: false, error: checked.error };
    const store = await import("./store.server.ts");
    const current = await store.readDesk(data.deskId);
    if (!current) await store.writeDesk(data.deskId, { files: [], harnesses: normalizeHarnesses(undefined), modules: [], journal: [], memory: "", notes: [] });
    const desk = await store.writeDeskNotify(data.deskId, checked.url);
    if (!desk) return { ok: false, error: "没有这个工作区。" };
    return { ok: true, notify: notifyInfo(desk.notifyUrl) };
  });

export type NotifyTried = { ok: true; where: string } | { ok: false; error: string };

export const tryNotify = createServerFn({ method: "POST" })
  .validator(readDeskId)
  .handler(async ({ data }): Promise<NotifyTried> => {
    const store = await import("./store.server.ts");
    const desk = await store.readDesk(data.deskId);
    if (!desk?.notifyUrl) return { ok: false, error: "还没填通知地址。" };
    const drive = await import("./drive.server.ts");
    const origin = drive.selfOrigin();
    const sent = await sendNotify(desk.notifyUrl, `【测试】这个工作区的通知已接通。定时任务做完、或你让它发消息时，会发到这里。${origin ? `\n工作区：${origin}/?desk=${desk.id}` : ""}`);
    return sent.ok ? { ok: true, where: sent.where } : { ok: false, error: `${sent.where}没收到：${sent.error}` };
  });

function readScheduleRemove(input: unknown): { deskId: string; scheduleId: string } {
  const { deskId } = readDeskId(input);
  const scheduleId = input && typeof input === "object" && "scheduleId" in input ? input.scheduleId : null;
  if (typeof scheduleId !== "string" || !/^sch-[a-z0-9-]{4,48}$/.test(scheduleId)) throw new Error("定时任务编号不对。");
  return { deskId, scheduleId };
}

// The page's 取消 on a schedule.
export const removeSchedule = createServerFn({ method: "POST" })
  .validator(readScheduleRemove)
  .handler(async ({ data }): Promise<{ schedules: ScheduleRecord[] }> => {
    const store = await import("./store.server.ts");
    await store.removeSchedule(data.deskId, data.scheduleId);
    return { schedules: await store.listSchedules(data.deskId) };
  });

export type DeskSaved = { ok: true; revision: number; files: number } | { ok: false; error: string };
export type DeskCleared = { ok: true; desk: PublicDesk } | { ok: false; error: string };

type SaveInput = { deskId: string; harnesses: HarnessId[]; notes: string[]; modules: DeskModule[] | null; put: DeskFile[]; remove: string[] };

function readSave(input: unknown): SaveInput {
  const { deskId } = readDeskId(input);
  const body = input as Record<string, unknown>;
  // Each put is checked as a file; the merged desk is checked against the caps below.
  const puts = parseDeskState({ files: Array.isArray(body.put) ? body.put : [], journal: [], memory: "" });
  if ("error" in puts) throw new Error(puts.error);
  const remove = Array.isArray(body.remove) ? body.remove.filter((path): path is string => typeof path === "string" && safePath(path)).slice(0, MAX_FILES) : [];
  const modules = Array.isArray(body.modules) ? normalizeModules(body.modules) : null;
  return { deskId, harnesses: normalizeHarnesses(body.harnesses), notes: normalizeNotes(body.notes), modules, put: puts.files, remove };
}

// The page's settings and files, sent as changes: files that are new or
// edited (`put`), paths dropped (`remove`), modules only when they changed.
// The server merges them into the desk it has, so a desk full of pictures is
// not re-uploaded on every change and two devices do not overwrite each other
// wholesale. The loop's own journal/memory are left alone. Creating a desk is
// the same call.
export const saveDesk = createServerFn({ method: "POST" })
  .validator(readSave)
  .handler(async ({ data }): Promise<DeskSaved> => {
    const store = await import("./store.server.ts");
    const live = await store.activeRun(data.deskId);
    if (live?.status === "running") return { ok: false, error: "它还在做上一件事，做完再改工作区。" };
    const current = await store.readDesk(data.deskId);
    const files = applyFileDelta(current?.files ?? [], { put: data.put, remove: data.remove });
    const modules = data.modules ?? current?.modules ?? [];
    const merged = parseDeskState({ files, harnesses: data.harnesses, modules, notes: data.notes, journal: [], memory: "" });
    if ("error" in merged) return { ok: false, error: merged.error };
    const saved = await store.writeDesk(data.deskId, {
      files: merged.files,
      harnesses: merged.harnesses,
      modules: merged.modules,
      journal: current?.journal ?? [],
      memory: current?.memory ?? "",
      notes: merged.notes,
    });
    return { ok: true, revision: saved.revision, files: saved.files.length };
  });

export const clearDesk = createServerFn({ method: "POST" })
  .validator(readDeskId)
  .handler(async ({ data }): Promise<DeskCleared> => {
    const store = await import("./store.server.ts");
    const live = await store.activeRun(data.deskId);
    if (live?.status === "running") return { ok: false, error: "它还在做上一件事，做完再清空。" };
    await store.clearDesk(data.deskId);
    const desk = await store.readDesk(data.deskId);
    if (!desk) return { ok: false, error: "工作区没有建起来。" };
    return { ok: true, desk: publicDesk(desk) };
  });

// Writes the timeline to the run's row as it grows, so a page polling another
// instance sees progress, and notices a stop requested from anywhere.
function keepRunAlive(runId: string, read: (after: number) => AgentEvent[], rounds: () => number, onStop: () => void) {
  let after = 0;
  let busy = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  const flush = async () => {
    if (busy) return;
    busy = true;
    try {
      const store = await import("./store.server.ts");
      const fresh = read(after);
      if (fresh.length) after = fresh[fresh.length - 1]?.seq ?? after;
      await store.appendRunEvents(runId, fresh, rounds());
      if (await store.stopRequested(runId)) onStop();
    } catch {
      /* a missed flush only delays what other instances see */
    } finally {
      busy = false;
    }
  };
  timer = setInterval(() => void flush(), 1_000);
  return {
    stop: async () => {
      if (timer) clearInterval(timer);
      timer = null;
      while (busy) await new Promise((resolve) => setTimeout(resolve, 20));
      await flush();
    },
  };
}

function statusFor(result: DeskResult, events: AgentEvent[]): Exclude<RunStatus, "running"> {
  if (result.stopped) return "stopped";
  if (result.paused) return "paused";
  if (!result.ok) return "failed";
  // Rounds happened but no step ever ran to completion: whatever text came
  // back is an error the loop relayed, not an answer.
  const rounds = events.some((event) => event.kind === "think");
  const stepped = events.some((event) => event.kind === "step" || event.kind === "effect");
  return rounds && !stepped ? "failed" : "done";
}

// A run whose last completed step returned Ask is waiting on the user.
function endedWithAsk(events: AgentEvent[]): boolean {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event?.kind === "step") return event.reply === "ask";
  }
  return false;
}

// A run goes on by itself after a budget pause, up to this many segments, as
// long as the segment that paused got somewhere.
export const MAX_SEGMENTS = 10;

// Whether the latest segment got somewhere: a segment that spent its whole
// budget without one completed step would just spin again.
export function segmentProgressed(run: RunRecord): boolean {
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

/** True when a paused run should be continued without the user asking. */
export function carriesOn(run: RunRecord): boolean {
  return run.status === "paused" && run.segment < MAX_SEGMENTS && segmentProgressed(run);
}

/** Earlier runs of the desk as conversation, oldest first; the current run and anything still running are left out. */
export function historyFor(runs: RunRecord[], currentId: string): HistoryItem[] {
  return runs
    .filter((run) => run.id !== currentId && run.status !== "running" && run.result)
    .slice(-HISTORY_SHOWN)
    .map((run) => ({ task: run.task, answer: run.result?.answer ?? "", status: run.status, asked: run.result?.asked }));
}

// What a segment's Schedule.daily / Schedule.cancel steps did, written to the
// desk's schedules once the segment is over, in the order they happened.
async function applyScheduleEvents(deskId: string, events: AgentEvent[]): Promise<ScheduleRecord[]> {
  const store = await import("./store.server.ts");
  for (const event of events) {
    if (event.kind === "schedule") {
      const spec: ScheduleSpec = { time: event.time, tz: event.tz, task: event.task };
      await store.addSchedule(deskId, spec, nextOccurrence(spec.time, spec.tz, Date.now()), MAX_SCHEDULES);
    } else if (event.kind === "unschedule") {
      const gone = (await store.listSchedules(deskId)).find((item) => item.time === event.time && item.tz === event.tz && item.task === event.task);
      if (gone) await store.removeSchedule(deskId, gone.id);
    }
  }
  return store.listSchedules(deskId);
}

/**
 * Starts a run for each schedule whose time has come, up to `limit` of them,
 * and runs their first segments here. Claiming a schedule moves it to its next
 * day in one row update, so two callers (the daily cron, a visit's kick, an
 * outside pinger) never start the same one twice. A desk that is busy with
 * another run is skipped and tried again on the next call.
 */
export async function runDueSchedules(origin: string | null, limit = 2): Promise<{ started: string[]; skipped: number }> {
  const store = await import("./store.server.ts");
  const now = Date.now();
  const started: string[] = [];
  let skipped = 0;
  for (const due of await store.dueSchedules(now, limit)) {
    const desk = await store.readDesk(due.deskId);
    if (!desk) {
      await store.removeSchedule(due.deskId, due.id);
      continue;
    }
    const live = await store.activeRun(due.deskId);
    if (live?.status === "running") {
      skipped += 1;
      continue;
    }
    const runId = `run-sched-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const claimed = await store.claimSchedule(due.id, due.nextAt, nextOccurrence(due.time, due.tz, now), runId);
    if (!claimed) continue;
    const run = await store.createRun(due.deskId, runId, due.task, "schedule");
    started.push(run.id);
    await runSegment(run, { ...desk, journal: [], memory: "" }, origin);
  }
  return { started, skipped };
}

async function runSegment(run: RunRecord, desk: DeskRecord, origin?: string | null): Promise<RunReply> {
  const store = await import("./store.server.ts");
  const { runProgress } = await import("./progress.server.ts");
  const apiKey = process.env.XAI_API_KEY;
  const seqBase = run.events.length ? (run.events[run.events.length - 1]?.seq ?? 0) : 0;
  const drive = await import("./drive.server.ts");
  const self = origin === undefined ? drive.selfOrigin() : origin;
  runProgress.open(run.id, seqBase);
  const finish = async (status: Exclude<RunStatus, "running">, result: DeskResult, state: DeskState): Promise<RunReply> => {
    const soFar = runProgress.read(run.id).events;
    const rounds = soFar.reduce((max, event) => ("round" in event && event.round > max ? event.round : max), run.rounds);
    // A scheduled run nobody is watching: its summary goes to the desk's
    // notify address (once, when the run is over for good).
    const carryingOn = status === "paused" && carriesOn({ ...run, status, events: [...run.events, ...soFar] });
    if (run.trigger === "schedule" && desk.notifyUrl && !carryingOn) {
      const when = (await store.listSchedules(desk.id)).find((item) => item.lastRunId === run.id);
      const text = scheduleSummary({ when: when ? describeWhen(when.time, when.tz) : "每天", task: run.task, status, answer: result.ok ? result.answer : result.error, link: self ? `${self}/?desk=${desk.id}` : "" });
      const sent = await sendNotify(desk.notifyUrl, text);
      const event = runProgress.emit(run.id, sent.ok ? { kind: "notify", round: rounds, ok: true, where: sent.where, auto: true } : { kind: "notify", round: rounds, ok: false, where: sent.where, error: sent.error, auto: true });
      // The flusher has stopped by now; this one is written by hand.
      if (event) await store.appendRunEvents(run.id, [event], rounds);
    }
    const events = runProgress.read(run.id).events;
    const touched = [...new Set(result.steps.filter((step) => state.files.some((file) => file.path === step.detail)).map((step) => step.detail))];
    const outcome: RunOutcome = { ok: result.ok && status !== "failed", answer: result.ok ? result.answer : result.error, steps: result.steps, touched, plan: result.plan };
    if (status === "done" && endedWithAsk(events)) outcome.asked = true;
    if (status === "paused" && result.last) outcome.last = result.last;
    const saved = await store.writeDesk(desk.id, state);
    await store.finishRun(run.id, status, rounds, outcome);
    const schedules = await applyScheduleEvents(desk.id, events);
    const fresh = (await store.getRun(run.id)) ?? { ...run, status, rounds, result: outcome, events: [...run.events, ...events] };
    const reply: RunReply = { run: fresh, desk: publicDesk(saved), schedules };
    runProgress.close(run.id, reply, outcome.ok);
    // Paused for time only: the server carries on by itself.
    if (status === "paused" && carriesOn(fresh)) await drive.selfContinue(fresh.id, fresh.segment, self);
    return reply;
  };
  const state: DeskState = { files: desk.files, harnesses: desk.harnesses, modules: desk.modules, journal: desk.journal, memory: desk.memory, notes: desk.notes };
  if (!apiKey) {
    return finish("failed", { ok: false, error: "Grok 没有接上。", files: desk.files, steps: [], modules: desk.modules, journal: desk.journal, memory: desk.memory, notes: desk.notes, plan: run.result?.plan ?? emptyPlan() }, state);
  }
  const started = Date.now();
  const { runCore, runPayload, verifyModuleSet } = await import("./ocaml-run.ts");
  const controller = new AbortController();
  runProgress.attachAbort(run.id, () => controller.abort());
  const alive = keepRunAlive(
    run.id,
    (after) => runProgress.read(run.id, after).events,
    () => runProgress.read(run.id).events.reduce((max, event) => ("round" in event && event.round > max ? event.round : max), run.rounds),
    () => controller.abort(),
  );
  try {
    // A module that no longer compiles as part of the set would make every
    // step fail; leave it out of this run and say so, instead of spinning.
    const checked = desk.modules.length ? await verifyModuleSet(desk.modules) : { kept: desk.modules, dropped: [] };
    const budgetMs = Math.max(15_000, runBudgetMs() - (Date.now() - started));
    const history = historyFor(await store.listRuns(desk.id), run.id);
    const schedules = await store.listSchedules(desk.id);
    const result = await runDeskLoop(apiKey, run.task, desk.files, desk.harnesses, checked.kept, desk.journal, desk.memory, {
      runCore,
      runPayload,
      signal: controller.signal,
      emit: (event) => void runProgress.emit(run.id, event),
      budgetMs,
      dropped: checked.dropped,
      roundBase: run.rounds,
      segment: run.segment,
      plan: run.result?.plan,
      last: run.result?.last ?? null,
      history,
      notes: desk.notes,
      schedules: schedules.map((item) => ({ time: item.time, tz: item.tz, task: item.task })),
      scheduledBefore: run.events.some((event) => event.kind === "schedule"),
      scheduled: run.trigger === "schedule",
      notifyUrl: desk.notifyUrl,
      notifiedBefore: run.events.some((event) => event.kind === "notify" && event.ok && !event.auto),
    });
    await alive.stop();
    const events = runProgress.read(run.id).events;
    return finish(statusFor(result, events), result, { files: result.files, harnesses: desk.harnesses, modules: result.modules, journal: result.journal, memory: result.memory, notes: result.notes });
  } catch (err) {
    await alive.stop();
    const message = err instanceof Error ? err.message : "循环没有跑起来。";
    return finish("failed", { ok: false, error: message, files: desk.files, steps: [], modules: desk.modules, journal: desk.journal, memory: desk.memory, notes: desk.notes, plan: run.result?.plan ?? emptyPlan() }, state);
  }
}

function readStart(input: unknown): { deskId: string; runId: string; task: string } {
  const { deskId } = readDeskId(input);
  const runId = input && typeof input === "object" && "runId" in input ? input.runId : null;
  if (!isRunId(runId)) throw new Error("任务编号不对。");
  const task = input && typeof input === "object" && "task" in input && typeof input.task === "string" ? input.task.trim() : "";
  if (!task || task.length > MAX_TASK) throw new Error("先写一句要做的事，别超过一千字。");
  return { deskId, runId, task };
}

export const startRun = createServerFn({ method: "POST" })
  .validator(readStart)
  .handler(async ({ data }): Promise<RunReply> => {
    const store = await import("./store.server.ts");
    const desk = await store.readDesk(data.deskId);
    if (!desk) throw new Error("工作区还没有同步到服务器，稍等一下再发。");
    const existing = await store.getRun(data.runId);
    if (existing) {
      // The page retried after losing the connection: the run is already on
      // its way (or finished), so report it rather than start a second one.
      return { run: existing, desk: publicDesk(desk) };
    }
    const live = await store.activeRun(data.deskId);
    if (live?.status === "running") throw new Error("它还在做上一件事，做完再说下一件。");
    const run = await store.createRun(data.deskId, data.runId, data.task);
    // The loop's journal and memory are one task's notes and resume point; a
    // new task starts them clean and reads earlier tasks from the history instead.
    return runSegment(run, { ...desk, journal: [], memory: "" });
  });

/**
 * Runs the next segment of a paused run, if this caller is the one to claim
 * it. The page (one tap on 接着做, or its own fallback) and the server's
 * self-continuation both come through here; the claim is one row update, so
 * exactly one of them runs the segment and the other sees it running.
 * `expected` pins the segment the caller saw paused, so a late request for a
 * segment that has already moved on is a no-op.
 */
export async function driveNextSegment(runId: string, expected: number | null, origin?: string | null): Promise<RunReply> {
  const store = await import("./store.server.ts");
  const run = await store.getRun(runId);
  if (!run) throw new Error("服务器上没有这次运行。");
  const desk = await store.readDesk(run.deskId);
  if (!desk) throw new Error("这次运行的工作区不见了。");
  if (run.status !== "paused" || (expected !== null && run.segment !== expected)) return { run, desk: publicDesk(desk) };
  const claimed = await store.claimSegment(run.id, run.segment);
  if (!claimed) {
    const fresh = (await store.getRun(run.id)) ?? run;
    return { run: fresh, desk: publicDesk(desk) };
  }
  return runSegment({ ...claimed, events: run.events }, desk, origin);
}

export const continueRun = createServerFn({ method: "POST" })
  .validator(readRunId)
  .handler(async ({ data }): Promise<RunReply> => driveNextSegment(data.runId, null));

export const pollRun = createServerFn({ method: "POST" })
  .validator(readRunId)
  .handler(async ({ data }): Promise<RunSnapshot> => {
    const { runProgress } = await import("./progress.server.ts");
    const live = runProgress.read(data.runId, data.after);
    if (live.found && !live.done) return { found: true, done: false, events: live.events, reply: null };
    // The segment this instance ran is over, or another instance has the run:
    // the row says whether a later segment is going on somewhere.
    const store = await import("./store.server.ts");
    const run = await store.getRun(data.runId);
    if (!run) {
      if (live.found) return { found: true, done: true, events: live.events, reply: live.result };
      return { found: false, done: false, events: [], reply: null };
    }
    const done = run.status !== "running";
    const desk = done ? await store.readDesk(run.deskId) : null;
    return {
      found: true,
      done,
      events: run.events.filter((event) => event.seq > data.after),
      reply: done && desk ? { run, desk: publicDesk(desk) } : null,
    };
  });

export const stopRun = createServerFn({ method: "POST" })
  .validator(readRunId)
  .handler(async ({ data }): Promise<{ stopped: boolean }> => {
    const { runProgress } = await import("./progress.server.ts");
    if (runProgress.cancel(data.runId)) return { stopped: true };
    const store = await import("./store.server.ts");
    return { stopped: await store.requestStop(data.runId) };
  });

export const getRun = createServerFn({ method: "POST" })
  .validator(readRunId)
  .handler(async ({ data }): Promise<RunRecord | null> => {
    const store = await import("./store.server.ts");
    return store.getRun(data.runId);
  });

export type InstallVerdict = { ok: true; module: DeskModule; exports: string[] } | { ok: false; error: string };

type InstallInput = { name: string; body: string; context: DeskModule[]; source?: string };

function readContext(input: object): DeskModule[] {
  return normalizeModules("context" in input ? input.context : undefined);
}

function readInstallInput(input: unknown): InstallInput {
  if (!input || typeof input !== "object") throw new Error("请求不对");
  const name = "name" in input && typeof input.name === "string" ? input.name.trim() : "";
  const body = "body" in input && typeof input.body === "string" ? input.body : "";
  const source = "source" in input && typeof input.source === "string" ? input.source.slice(0, 300) : undefined;
  if (!name || name.length > 25) throw new Error("模块名不对。");
  if (!body.trim() || body.length > 200_000) throw new Error("源码是空的，或超过 200 KB。");
  return { name, body, context: readContext(input), source };
}

// The workspace panel's "装为 harness" (and a harness file being imported):
// the same checks a step's Harness.load runs, against the modules already there.
export const installModule = createServerFn({ method: "POST" })
  .validator(readInstallInput)
  .handler(async ({ data }): Promise<InstallVerdict> => {
    const { verifyModule } = await import("./ocaml-run.ts");
    const verdict = await verifyModule(data.name, data.body, data.context);
    if (!verdict.ok) return verdict;
    const module: DeskModule = { ...verdict.module, source: data.source ?? verdict.module.source, at: Date.now() };
    return { ok: true, module, exports: moduleExports(module.body) };
  });

type UrlInstallInput = { name: string | null; url: string; context: DeskModule[] };

function readUrlInstall(input: unknown): UrlInstallInput {
  if (!input || typeof input !== "object") throw new Error("请求不对");
  const url = "url" in input && typeof input.url === "string" ? input.url.trim() : "";
  const rawName = "name" in input && typeof input.name === "string" ? input.name.trim() : "";
  if (!/^https?:\/\/\S{4,500}$/.test(url)) throw new Error("地址不对，要以 http:// 或 https:// 开头。");
  return { name: rawName || null, url, context: readContext(input) };
}

// The panel's "从地址安装": fetch a raw .ml, verify it against what is loaded,
// and hand back the module with its source so it can be re-fetched later.
export const installFromUrl = createServerFn({ method: "POST" })
  .validator(readUrlInstall)
  .handler(async ({ data }): Promise<InstallVerdict> => {
    const name = data.name ?? moduleNameFromUrl(data.url);
    if (!name) return { ok: false, error: "从地址看不出模块名，写成「Name = 地址」。" };
    const { fetchSource } = await import("./net.ts");
    const fetched = await fetchSource(data.url);
    if (!fetched.ok) return { ok: false, error: fetched.error };
    const { verifyModule } = await import("./ocaml-run.ts");
    const verdict = await verifyModule(name, fetched.text, data.context);
    if (!verdict.ok) return verdict;
    const module: DeskModule = { ...verdict.module, source: data.url, at: Date.now() };
    return { ok: true, module, exports: moduleExports(module.body) };
  });
