import { createServerFn } from "@tanstack/react-start";
import { MAX_MODULES, moduleExports, moduleNameFromUrl, normalizeHarnesses, normalizeModules, type DeskModule, type HarnessId } from "./harness.ts";
import { fetchPublic } from "./net.ts";
import { holdDone, presentAnswer, rewriteStep } from "./present.ts";
import { applyMemoryEffects, applyPlanEffects, clip, describeModelReply, describeStepFrame, emptyPlan, extractCode, isMemoryEffect, isPlanEffect, normalizeNotes, type AgentEvent, type AgentEventBody, type PlanItem, type PlanState } from "./progress.ts";
import { searchWeb } from "./search.ts";
import type { DeskRecord, DeskState, RunOutcome, RunRecord, RunStatus } from "./store.server.ts";
import { applyFileDelta, imageBytes, isImageFile, safePath, type DeskFile, type JournalItem, type ToolStep, MAX_FILES } from "./workspace.ts";

export type { JournalItem };
export type { RunOutcome, RunRecord, RunStatus };

type DeskCarried = { files: DeskFile[]; steps: ToolStep[]; modules: DeskModule[]; journal: JournalItem[]; memory: string; notes: string[]; plan: PlanState; stopped?: boolean; paused?: boolean; events?: AgentEvent[] };

export type DeskResult = ({ ok: true; answer: string } & DeskCarried) | ({ ok: false; error: string } & DeskCarried);

/** The desk as the page sees it: the loop's journal and memory stay on the server. */
export type PublicDesk = { id: string; files: DeskFile[]; harnesses: HarnessId[]; modules: DeskModule[]; notes: string[]; revision: number };

/** One request's worth of a run, plus the desk as it left it. */
export type RunReply = { run: RunRecord; desk: PublicDesk };

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
  net: (url: string) => Promise<string>;
  search: (query: string) => Promise<string>;
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

【你能用什么】
只能使用下面的 module：Files、Search、Net、Trace、Clock、Harness、Plan、Memory，已加载的自定义 module，以及 OCaml 标准库里纯计算的部分（List、String、Option、Result、Printf.sprintf 等）。
Step 里不要调用 Unix、Sys，也不要直接打开文件。写了不会执行。
要计时用 Clock.now () : float，单位是秒。

这次开着的能力：${opened.length ? opened.join("、") : "没有"}。没开的调用会得到 Error。

【节奏：先计划，再做，最后核对】
- 一步做不完的任务，第 1 轮先 Plan.set ["第一件事"; "第二件事"; …]（2–6 条，每条一句话），并在同一步做第一件事。一步能做完的任务不用计划。
- 做完一项就 Plan.tick n "结果里的关键值"（n 从 1 数起）。计划会原样附在每一轮的提示里，带上勾选状态，不必再用 Trace.note 重复。
- 计划要改就再 Plan.set 一次：文字没变的项保留勾选。
- Done 之前先核对：读一遍写出的文件，或用装好的 module 算一个已知值，确认任务要的都在了，再 Done。写过文件的任务，第一次 Done 会被拦下来再给一轮核对；核对过了就正常 Done，不会再拦。
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
  val delete_file : string -> unit res
end

module Search : sig
  val query : string -> string res
end

module Net : sig
  val get : string -> string res
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
- 这一步每次调用的返回值会附在下一轮的提示里（只保留一轮）；要留到更后面用的数值，用 Trace.note 记下。
- Continue 表示还要再来一轮。Done、Ask、Partial 会结束这次任务。
- 参数已经确定的多个调用，写在同一步里依次执行。全部 Trace.note 之后，只 Continue 一次。
- 后一个调用的地址、查询或内容要等前一个的返回值，就不能写在同一步。先 Continue，下一轮再用返回值去调用。
- 只要这一步调用了 Net.get 或 Search.query，就不能 Done。Done 只写在不再请求的那一轮，并且只用返回值或笔记里出现过的数字。

【工作方式】
- 用户要你写代码或文件时，这一轮就用 Files.write_file 把完整源码写进文件，成功后 Done。不要先 list_files，也不要只 Trace.note。
- 只有用户明确说「加载」或 harness 时，才把对应的 .ml 写好并结束。其它任务不要提 harness。
- 工作区的文件列表每轮都附在提示里，不要为了看它调用 list_files。
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
    | Ok () -> Done "已写下 alarm.ml，里面有 ring。"
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
// The loop binary only relays the task and the model's Trace.notes; everything
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
  images?: string[];
  visionFailed?: boolean;
  history?: HistoryItem[];
  notes?: string[];
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
  const wide = effect.tool === "Files.read_file" || effect.tool === "Net.get" || effect.tool === "Search.query";
  const picture = /^(Ok )?data:image\//.test(effect.output);
  const output = picture ? "Ok （这是一张图片的编码；图片本身已经附在提示里，直接看图）" : clip(effect.output.replace(/\s+/g, " ").trim(), wide ? 2_500 : 400);
  const detail = effect.detail.trim() ? ` ${clip(effect.detail.trim(), 120)}` : "";
  return `- ${effect.tool}${detail} → ${output || "（没有输出）"}`;
}

export function promptContext(ctx: PromptContext): string {
  const parts: string[] = [];
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
    parts.push(`【上一步（第 ${last.round} 轮）执行了，返回 ${last.reply}${last.text.trim() ? `：${clip(last.text.trim(), 300)}` : ""}】\n${lines.length ? lines.join("\n") + extra : "（没有任何调用）"}`);
  } else if (last?.kind === "runner_failed") {
    parts.push(`【上一步没有跑起来】\n${clip(last.message, 600)}`);
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
    parts.push(
      `【收尾前核对】你上一步想用这个答案结束：「${clip(ctx.check, 500)}」。先核对一次再 Done：读一遍写出的文件、或用装好的 module 算一个已知的值，确认任务要的都在、内容没错。${open.length ? `计划里还有没打勾的：${open.join("；")}——做完或说明为什么不用做。` : ""}核对没问题，就在核对的同一步（或下一轮）Done，答案可以修正；发现遗漏就补上再 Done。这次不会再被拦。`,
    );
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

function askModel(apiKey: string, prompt: string, context: string, harnesses: HarnessId[], modules: DeskModule[], opts: AskOptions = {}): Promise<string> {
  const { signal, effort = "low", images = [] } = opts;
  const slowGuard = AbortSignal.timeout(90_000);
  const input = `${prompt.slice(0, MAX_PROMPT)}\n\n${context}`;
  const content =
    images.length > 0
      ? [{ type: "input_text", text: input }, ...images.map((image) => ({ type: "input_image", image_url: image.dataUrl, detail: "auto" }))]
      : input;
  return fetch("https://api.x.ai/v1/responses", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    signal: signal ? AbortSignal.any([slowGuard, signal]) : slowGuard,
    body: JSON.stringify({
      model: "grok-4.5",
      reasoning: { effort },
      max_output_tokens: 6000,
      instructions: instructionsFor(harnesses, modules),
      input: [{ role: "user", content }],
    }),
  })
    .then(async (response) => {
      if (!response.ok && images.length > 0 && response.status >= 400 && response.status < 500) {
        // The endpoint would not take the pictures: say so in the next
        // context and ask again with text only, rather than failing the round.
        opts.onVisionFailed?.();
        return askModel(apiKey, prompt, context, harnesses, modules, { ...opts, images: [] });
      }
      if (!response.ok) return `error\n${block(`模型没有接上（${response.status}）。`)}`;
      const body = (await response.json()) as ResponseBody;
      const text = textOf(body);
      if (text) return `text\n${block(text)}`;
      const calls = (body.output ?? []).filter((item) => item.type === "function_call" && item.name);
      if (calls.length > 0) return `text\n${block("没有按格式输出。只写一个 ocaml 代码块，里面是 module Step。")}`;
      return `text\n${block("没有输出")}`;
    })
    .catch((err: unknown) => {
      const slow = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
      const message = slow ? "模型太慢，这一步停了。点继续可以接着做。" : err instanceof Error ? err.message : "模型没有回应";
      return `error\n${block(message)}`;
    });
}

export type RunHooks = {
  signal?: AbortSignal;
  onCall?: (tool: string, detail: string) => void;
  modules?: () => DeskModule[];
  onModule?: (mod: DeskModule) => void;
  onUnload?: (name: string) => void;
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
const MIN_ROUND_MS = 12_000;
const MAX_COMPILE_STALL = 4;
const MAX_IDLE_STALL = 5;
const MAX_RUNNER_STALL = 2;
// Effects that change the desk: a run that did any of these gets a check round.
const WRITES = new Set(["Files.write_file", "Files.delete_file", "Harness.load", "Harness.install"]);

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
  /** Modules that failed the pre-flight compile and were left out of this run. */
  dropped?: { name: string; error: string }[];
  /** Rounds already done by earlier segments of this run; numbering continues from here. */
  roundBase?: number;
  /** Which segment of the run this is (1 for a fresh run). */
  segment?: number;
  /** The plan and check state earlier segments left; a fresh run starts empty. */
  plan?: PlanState;
  /** Earlier exchanges in this desk, oldest first, for follow-ups to read against. */
  history?: HistoryItem[];
  /** What the agent remembered about this desk so far (Memory.remember). */
  notes?: string[];
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
  let last: LastOutcome = null;
  // The plan the model keeps with Plan.set / Plan.tick, and the pre-finish
  // check: the first Done of a run that wrote anything is held for one more
  // round so the model verifies its work before the answer goes out.
  const plan: PlanState = deps.plan ? { ...deps.plan, items: deps.plan.items.map((item) => ({ ...item })) } : emptyPlan();
  // Long-lived notes about the desk; steps add to them with Memory.remember.
  const notes: string[] = [...(deps.notes ?? [])];
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
  const timer = setTimeout(() => cut("budget"), budgetMs);
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
          if (deadline - Date.now() < MIN_ROUND_MS) {
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
            images: shownImages.map((image) => image.path),
            visionFailed,
            history: deps.history,
            notes,
          });
          plan.pending = null;
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
          if (reply?.kind === "error") {
            emit({ kind: "model_error", round, message: reply.message });
            last = { kind: "model_error", message: reply.message };
          } else if (reply?.kind === "text") {
            lastCode = extractCode(reply.text) || reply.text;
            emit({ kind: "plan", round, code: lastCode });
          }
          return raw;
        },
        net: async (url) => {
          emit({ kind: "call", round, tool: "Net.get", detail: url });
          const output = await fetchPublic(url);
          emit({ kind: "effect", round, tool: "Net.get", detail: url, output });
          return output;
        },
        search: async (query) => {
          emit({ kind: "call", round, tool: "Search.query", detail: query });
          const output = await searchWeb(apiKey, query);
          emit({ kind: "effect", round, tool: "Search.query", detail: query, output });
          return output;
        },
        ocaml: async (payload) => {
          const isStep = payload.startsWith("step\n");
          if (isStep) emit({ kind: "run", round });
          let raw: string;
          try {
            raw = await deps.runPayload(payload, harnesses, apiKey, {
              signal,
              onCall: (tool, detail) => emit({ kind: "call", round, tool, detail }),
              modules: () => loaded,
              onModule: addModule,
              onUnload: dropModule,
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
              const effects = frame.effects.filter((effect) => !isPlanEffect(effect.tool) && !isMemoryEffect(effect.tool));
              for (const effect of effects) emit({ kind: "effect", round, ...effect });
              if (effects.some((effect) => WRITES.has(effect.tool) && effect.output.startsWith("Ok"))) plan.wrote = true;
              let reply = frame.reply;
              let raw = next.raw;
              if (reply === "done" && plan.checks === 0 && (plan.wrote || plan.items.some((item) => !item.done))) {
                const held = holdDone(raw);
                if (held) {
                  plan.checks += 1;
                  plan.pending = frame.text;
                  raw = held;
                  reply = "continue";
                  emit({ kind: "check", round, answer: frame.text });
                }
              }
              emit({ kind: "step", round, reply, text: frame.text });
              last = { kind: "ran", round, reply, text: frame.text, effects };
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
      return { ok: true, answer: pausedAnswer(round - roundBase, carried.steps), paused: true, ...carried };
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
  }
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

function publicDesk(desk: DeskRecord): PublicDesk {
  return { id: desk.id, files: desk.files, harnesses: desk.harnesses, modules: desk.modules, notes: desk.notes, revision: desk.revision };
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

export type DeskLoad = { found: false; durable: boolean } | { found: true; durable: boolean; desk: PublicDesk; runs: RunRecord[] };

export const loadDesk = createServerFn({ method: "POST" })
  .validator(readDeskId)
  .handler(async ({ data }): Promise<DeskLoad> => {
    const store = await import("./store.server.ts");
    const durable = store.isDurable();
    const desk = await store.readDesk(data.deskId);
    if (!desk) return { found: false, durable };
    const runs = await store.listRuns(data.deskId);
    return { found: true, durable, desk: publicDesk(desk), runs };
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

/** Earlier runs of the desk as conversation, oldest first; the current run and anything still running are left out. */
export function historyFor(runs: RunRecord[], currentId: string): HistoryItem[] {
  return runs
    .filter((run) => run.id !== currentId && run.status !== "running" && run.result)
    .slice(-HISTORY_SHOWN)
    .map((run) => ({ task: run.task, answer: run.result?.answer ?? "", status: run.status, asked: run.result?.asked }));
}

async function runSegment(run: RunRecord, desk: DeskRecord): Promise<RunReply> {
  const store = await import("./store.server.ts");
  const { runProgress } = await import("./progress.server.ts");
  const apiKey = process.env.XAI_API_KEY;
  const seqBase = run.events.length ? (run.events[run.events.length - 1]?.seq ?? 0) : 0;
  runProgress.open(run.id, seqBase);
  const finish = async (status: Exclude<RunStatus, "running">, result: DeskResult, state: DeskState): Promise<RunReply> => {
    const events = runProgress.read(run.id).events;
    const rounds = events.reduce((max, event) => ("round" in event && event.round > max ? event.round : max), run.rounds);
    const touched = [...new Set(result.steps.filter((step) => state.files.some((file) => file.path === step.detail)).map((step) => step.detail))];
    const outcome: RunOutcome = { ok: result.ok && status !== "failed", answer: result.ok ? result.answer : result.error, steps: result.steps, touched, plan: result.plan };
    if (status === "done" && endedWithAsk(events)) outcome.asked = true;
    const saved = await store.writeDesk(desk.id, state);
    await store.finishRun(run.id, status, rounds, outcome);
    const fresh = (await store.getRun(run.id)) ?? { ...run, status, rounds, result: outcome, events: [...run.events, ...events] };
    const reply: RunReply = { run: fresh, desk: publicDesk(saved) };
    runProgress.close(run.id, reply, outcome.ok);
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
      history,
      notes: desk.notes,
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

export const continueRun = createServerFn({ method: "POST" })
  .validator(readRunId)
  .handler(async ({ data }): Promise<RunReply> => {
    const store = await import("./store.server.ts");
    const run = await store.getRun(data.runId);
    if (!run) throw new Error("服务器上没有这次运行。");
    const desk = await store.readDesk(run.deskId);
    if (!desk) throw new Error("这次运行的工作区不见了。");
    if (run.status !== "paused") return { run, desk: publicDesk(desk) };
    const segment = run.segment + 1;
    await store.beginSegment(run.id, segment);
    return runSegment({ ...run, status: "running", segment }, desk);
  });

export const pollRun = createServerFn({ method: "POST" })
  .validator(readRunId)
  .handler(async ({ data }): Promise<RunSnapshot> => {
    const { runProgress } = await import("./progress.server.ts");
    const live = runProgress.read(data.runId, data.after);
    if (live.found) return { found: true, done: live.done, events: live.events, reply: live.done ? live.result : null };
    // Another instance has (or had) this run: read what it wrote.
    const store = await import("./store.server.ts");
    const run = await store.getRun(data.runId);
    if (!run) return { found: false, done: false, events: [], reply: null };
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
