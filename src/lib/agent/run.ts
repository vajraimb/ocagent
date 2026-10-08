import { createServerFn } from "@tanstack/react-start";
import { MAX_MODULES, moduleExports, normalizeHarnesses, normalizeModules, type DeskModule, type HarnessId } from "./harness.ts";
import { fetchPublic } from "./net.ts";
import { presentAnswer, rewriteStep } from "./present.ts";
import { describeModelReply, describeStepFrame, extractCode, isJobId, type AgentEvent, type AgentEventBody, type JobSnapshot } from "./progress.ts";
import { searchWeb } from "./search.ts";
import { safePath, type DeskFile, type JournalItem, type ToolStep, MAX_FILES } from "./workspace.ts";

export type { JournalItem };

type DeskCarried = { files: DeskFile[]; steps: ToolStep[]; modules: DeskModule[]; journal: JournalItem[]; memory: string; stopped?: boolean; paused?: boolean; events?: AgentEvent[] };

export type DeskResult = ({ ok: true; answer: string } & DeskCarried) | ({ ok: false; error: string } & DeskCarried);

export type DeskSnapshot = JobSnapshot<DeskResult>;

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
// The workspace rides along on every run (and every step inside it), so it has
// to stay well under the deployment's request limit.
export const MAX_FILE_BYTES = 512 * 1024;
export const MAX_WORKSPACE_BYTES = 3 * 1024 * 1024;

const FILE_TOOLS = [
  {
    type: "function",
    name: "list_files",
    description: "List workspace files",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    type: "function",
    name: "read_file",
    description: "Read one workspace file",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "find_in_files",
    description: "Find a short string inside workspace files. This cannot see the web.",
    parameters: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "write_file",
    description: "Create or replace a workspace file",
    parameters: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "delete_file",
    description: "Delete a workspace file",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    },
  },
];

const SEARCH_TOOL = {
  type: "function",
  name: "web_search",
  description: "Search the public web. Pass a short query. Use this for weather, news, and facts that are not in the workspace.",
  parameters: {
    type: "object",
    properties: { query: { type: "string" } },
    required: ["query"],
    additionalProperties: false,
  },
};

const HTTP_TOOL = {
  type: "function",
  name: "http_get",
  description: "Fetch one public http or https URL and return the status plus a text snippet.",
  parameters: {
    type: "object",
    properties: { url: { type: "string" } },
    required: ["url"],
    additionalProperties: false,
  },
};

const OCAML_TOOL = {
  type: "function",
  name: "ocaml_run",
  description: "Run one workspace .ml file once. This does not add a harness. Use load_harness for that.",
  parameters: {
    type: "object",
    properties: { path: { type: "string" } },
    required: ["path"],
    additionalProperties: false,
  },
};

const LOAD_TOOL = {
  type: "function",
  name: "load_harness",
  description: "Install a workspace .ml file as a named harness module. It then appears in the harness list and can be used by later OCaml. Call this after write_file. name is the module name, path is the file.",
  parameters: {
    type: "object",
    properties: { name: { type: "string" }, path: { type: "string" } },
    required: ["name", "path"],
    additionalProperties: false,
  },
};

function toolsFor(harnesses: HarnessId[]) {
  const tools: object[] = [];
  if (harnesses.includes("files")) tools.push(...FILE_TOOLS);
  if (harnesses.includes("web")) tools.push(SEARCH_TOOL);
  if (harnesses.includes("net")) tools.push(HTTP_TOOL);
  if (harnesses.includes("ocaml")) tools.push(OCAML_TOOL, LOAD_TOOL);
  return tools;
}

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

【你能用什么】
只能使用下面的 module：Files、Search、Net、Trace、Clock、Harness，已加载的自定义 module，以及 OCaml 标准库里纯计算的部分（List、String、Option、Result、Printf.sprintf 等）。
Step 里不要调用 Unix、Sys，也不要直接打开文件。写了不会执行。
要计时用 Clock.now () : float，单位是秒。

这次开着的能力：${opened.length ? opened.join("、") : "没有"}。没开的调用会得到 Error。

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
- 想让下一轮看到某个结果，用 Trace.note 写出来。下一轮只会收到这些 note，不会自动看到每次调用的返回值。
- Continue 表示还要再来一轮。Done、Ask、Partial 会结束这次任务。
- 参数已经确定的多个调用，写在同一步里依次执行。全部 Trace.note 之后，只 Continue 一次。
- 后一个调用的地址、查询或内容要等前一个的返回值，就不能写在同一步。先 Continue，下一轮再用笔记里的值去调用。
- 只要这一步调用了 Net.get 或 Search.query，就不能 Done。Done 只写在不再请求的那一轮，并且只用笔记里出现过的数字。

【工作方式】
- 用户要你写代码或文件时，这一轮就用 Files.write_file 把完整源码写进文件，成功后 Done。不要先 list_files，也不要只 Trace.note。
- 只有用户明确说「加载」或 harness 时，才把对应的 .ml 写好并结束。其它任务不要提 harness。
- 工作区是空的时候，不要反复列出文件。
- 收到编译错误时只改出错的地方，不要重写整段。
- 参数已经知道的多个请求写在同一步，记完再 Continue 一次。后一个请求要依赖前一个的结果时，拆成两步。
- 还要再请求，就不要 Done。不再请求的那一轮，只用笔记里出现过的数字写结论。
- 不要调用没列出的模块。编译失败的那一步不会执行。

【示例：写完并结束】
module Step : STEP = struct
  let run () =
    let body = "let ring () = Sys.time ()\\n" in
    match Files.write_file "alarm.ml" body with
    | Error e -> Partial ("写入失败：" ^ e)
    | Ok () -> Done "已写下 alarm.ml。"
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

export type DeskInput = { task: string; files: DeskFile[]; harnesses: HarnessId[]; modules: DeskModule[]; journal: JournalItem[]; memory: string; jobId: string | null };

export function parseDeskInput(input: unknown): DeskInput | { error: string } {
  if (!input || typeof input !== "object") return { error: "请求不对" };
  const task = "task" in input && typeof input.task === "string" ? input.task.trim() : "";
  const rawJob = "jobId" in input ? input.jobId : null;
  if (rawJob !== null && rawJob !== undefined && !isJobId(rawJob)) return { error: "任务编号不对。" };
  const jobId = isJobId(rawJob) ? rawJob : null;
  const rawFiles = "files" in input && Array.isArray(input.files) ? input.files : null;
  if (!task || task.length > MAX_TASK) return { error: "先写一句要做的事，别超过一千字。" };
  if (!rawFiles) return { error: "请求里没有工作区。" };
  if (rawFiles.length > MAX_FILES) return { error: `工作区里有 ${rawFiles.length} 个文件，一次最多带 ${MAX_FILES} 个。` };
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
    return { error: `工作区一共 ${(total / 1024 / 1024).toFixed(1)} MB，每次运行都要带上，最多 ${MAX_WORKSPACE_BYTES / 1024 / 1024} MB。最大的几个：${biggest.join("、")}。删掉用不着的再试。` };
  }
  const harnesses = normalizeHarnesses("harnesses" in input ? input.harnesses : undefined);
  const modules = normalizeModules("modules" in input ? input.modules : undefined);
  const journal = normalizeJournal("journal" in input ? input.journal : undefined);
  const memory = "memory" in input && typeof input.memory === "string" ? input.memory.slice(0, 4000) : "";
  return { task, files, harnesses, modules, journal, memory, jobId };
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

function askModel(apiKey: string, prompt: string, harnesses: HarnessId[], modules: DeskModule[], signal?: AbortSignal): Promise<string> {
  const slowGuard = AbortSignal.timeout(90_000);
  return fetch("https://api.x.ai/v1/responses", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    signal: signal ? AbortSignal.any([slowGuard, signal]) : slowGuard,
    body: JSON.stringify({
      model: "grok-4.5",
      reasoning: { effort: "low" },
      max_output_tokens: 4000,
      instructions: instructionsFor(harnesses, modules),
      input: [{ role: "user", content: prompt.slice(0, 24_000) }],
    }),
  })
    .then(async (response) => {
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
  let round = 0;
  // Modules loaded during this run join the ones the page sent, so every later
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
          const raw = await askModel(apiKey, prompt, harnesses, loaded, signal);
          const reply = describeModelReply(raw);
          if (reply?.kind === "error") emit({ kind: "model_error", round, message: reply.message });
          else if (reply?.kind === "text") emit({ kind: "plan", round, code: extractCode(reply.text) || reply.text });
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
              compileStall += 1;
              idleStall = 0;
              if (compileStall >= MAX_COMPILE_STALL) cut("compile_stall", frame.message);
            } else if (frame?.kind === "ok") {
              for (const effect of frame.effects) emit({ kind: "effect", round, ...effect });
              emit({ kind: "step", round, reply: frame.reply, text: frame.text });
              compileStall = 0;
              idleStall = frame.reply === "continue" && frame.effects.length === 0 ? idleStall + 1 : 0;
              if (idleStall >= MAX_IDLE_STALL) cut("idle_stall", frame.text);
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
    };
    if (!result || (result.status !== "error" && result.status !== "stopped" && result.status !== "done")) {
      return { ok: false, error: "循环没有留下结果。", ...carried };
    }
    if (result.status === "error") return { ok: false, error: result.answer || "循环没有跑起来。", ...carried };
    if (haltReason === "budget") {
      return { ok: true, answer: pausedAnswer(round, carried.steps), paused: true, ...carried };
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

function parseArgs(raw: string | undefined): { args: Record<string, unknown>; error?: string } {
  if (!raw) return { args: {} };
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return { args: parsed as Record<string, unknown> };
    return { args: {}, error: "参数不是对象" };
  } catch {
    return { args: {}, error: "参数被截断了。把文件写短一点，一次只写一个文件。" };
  }
}

export const runDesk = createServerFn({ method: "POST" })
  .validator((input: unknown): DeskInput => {
    const parsed = parseDeskInput(input);
    if ("error" in parsed) throw new Error(parsed.error);
    return parsed;
  })
  .handler(async ({ data }): Promise<DeskResult> => {
    const apiKey = process.env.XAI_API_KEY;
    const { deskProgress } = await import("./progress.server.ts");
    const jobId = data.jobId;
    if (!apiKey) {
      const missing: DeskResult = { ok: false, error: "Grok 没有接上。", files: data.files, steps: [], modules: data.modules, journal: data.journal, memory: data.memory };
      if (jobId) {
        deskProgress.open(jobId);
        deskProgress.close(jobId, missing, false);
      }
      return missing;
    }
    const started = Date.now();
    const { runCore, runPayload, verifyModuleSet } = await import("./ocaml-run.ts");
    const controller = new AbortController();
    if (jobId) {
      deskProgress.open(jobId);
      deskProgress.attachAbort(jobId, () => controller.abort());
    }
    // A module that no longer compiles as part of the set would make every
    // step fail; leave it out of this run and say so, instead of spinning.
    const checked = data.modules.length ? await verifyModuleSet(data.modules) : { kept: data.modules, dropped: [] };
    const budgetMs = Math.max(15_000, runBudgetMs() - (Date.now() - started));
    const result = await runDeskLoop(apiKey, data.task, data.files, data.harnesses, checked.kept, data.journal, data.memory, {
      runCore,
      runPayload,
      signal: controller.signal,
      emit: jobId ? (event) => deskProgress.emit(jobId, event) : undefined,
      budgetMs,
      dropped: checked.dropped,
    });
    if (!jobId) return result;
    // The answer carries the whole timeline too, so a page that could not
    // poll (or polled too slowly for a quick run) still shows the process.
    deskProgress.close(jobId, result, result.ok);
    return { ...result, events: deskProgress.read(jobId).events };
  });

function readJobInput(input: unknown): { jobId: string; after: number } {
  if (!input || typeof input !== "object") throw new Error("请求不对");
  const jobId = "jobId" in input ? input.jobId : null;
  if (!isJobId(jobId)) throw new Error("任务编号不对。");
  const rawAfter = "after" in input ? input.after : 0;
  const after = typeof rawAfter === "number" && Number.isInteger(rawAfter) && rawAfter >= 0 ? rawAfter : 0;
  return { jobId, after };
}

export const pollDesk = createServerFn({ method: "POST" })
  .validator(readJobInput)
  .handler(async ({ data }): Promise<DeskSnapshot> => {
    const { deskProgress } = await import("./progress.server.ts");
    return deskProgress.read(data.jobId, data.after);
  });

export type InstallVerdict = { ok: true; module: DeskModule; exports: string[] } | { ok: false; error: string };

function readInstallInput(input: unknown): { name: string; body: string } {
  if (!input || typeof input !== "object") throw new Error("请求不对");
  const name = "name" in input && typeof input.name === "string" ? input.name.trim() : "";
  const body = "body" in input && typeof input.body === "string" ? input.body : "";
  if (!name || name.length > 25) throw new Error("模块名不对。");
  if (!body.trim() || body.length > 200_000) throw new Error("源码是空的，或超过 200 KB。");
  return { name, body };
}

// The workspace panel's "装为 harness": the same checks a step's Harness.load runs.
export const installModule = createServerFn({ method: "POST" })
  .validator(readInstallInput)
  .handler(async ({ data }): Promise<InstallVerdict> => {
    const { verifyModule } = await import("./ocaml-run.ts");
    const verdict = await verifyModule(data.name, data.body);
    if (!verdict.ok) return verdict;
    return { ok: true, module: verdict.module, exports: moduleExports(verdict.module.body) };
  });

export const stopDesk = createServerFn({ method: "POST" })
  .validator(readJobInput)
  .handler(async ({ data }): Promise<{ stopped: boolean }> => {
    const { deskProgress } = await import("./progress.server.ts");
    return { stopped: deskProgress.cancel(data.jobId) };
  });
