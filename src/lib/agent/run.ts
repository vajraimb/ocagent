import { createServerFn } from "@tanstack/react-start";
import { normalizeHarnesses, normalizeModules, type DeskModule, type HarnessId } from "./harness.ts";
import { fetchPublic } from "./net.ts";
import { presentAnswer, rewriteStep } from "./present.ts";
import { describeModelReply, describeStepFrame, extractCode, isJobId, type AgentEventBody, type JobSnapshot } from "./progress.ts";
import { searchWeb } from "./search.ts";
import { safePath, type DeskFile, type JournalItem, type ToolStep } from "./workspace.ts";

export type { JournalItem };

export type DeskResult =
  | { ok: true; answer: string; files: DeskFile[]; steps: ToolStep[]; modules: DeskModule[]; journal: JournalItem[]; memory: string; stopped?: boolean }
  | { ok: false; error: string; files: DeskFile[]; steps: ToolStep[]; modules: DeskModule[]; journal: JournalItem[]; memory: string; stopped?: boolean };

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

function instructionsFor(harnesses: HarnessId[], _modules: DeskModule[]): string {
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
只能使用下面的 module：Files、Search、Net、Trace、Clock，以及 OCaml 标准库里纯计算的部分（List、String、Option、Result、Printf.sprintf 等）。
Step 里不要调用 Unix、Sys，也不要直接打开文件。写了不会执行。
要计时用 Clock.now () : float，单位是秒。
用户点名要加载的模块时，文件名就用那个名字，例如 PDF_gen 写成 PDF_gen.ml，写完再 Done。不要加载别的旧文件。

这次开着的能力：${opened.length ? opened.join("、") : "没有"}。没开的调用会得到 Error。

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
  if (!rawFiles || rawFiles.length > 24) return { error: "工作区文件不对。" };
  const files: DeskFile[] = [];
  for (const file of rawFiles) {
    if (!file || typeof file !== "object") return { error: "工作区文件不对。" };
    const path = "path" in file && typeof file.path === "string" ? file.path : "";
    const content = "content" in file && typeof file.content === "string" ? file.content : "";
    if (!safePath(path) || content.length > 8000) return { error: `不能收下 ${path || "这个文件"}。` };
    files.push({ path, content });
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

function askModel(apiKey: string, prompt: string, harnesses: HarnessId[], modules: DeskModule[]): Promise<string> {
  return fetch("https://api.x.ai/v1/responses", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(90_000),
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

export type RunHooks = { signal?: AbortSignal; onCall?: (tool: string, detail: string) => void };

export type LoopDeps = {
  runCore: (job: CoreJob, handlers: CoreHandlers, hooks?: RunHooks) => Promise<CoreResult>;
  runPayload: (payload: string, harnesses: HarnessId[], apiKey: string | undefined, hooks?: RunHooks) => Promise<string>;
  emit?: (event: AgentEventBody) => void;
  signal?: AbortSignal;
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
  try {
    let redirects = 0;
    emit({ kind: "start", task });
    const result = await deps.runCore(
      { task, harnesses, files, modules, journal, memory },
      {
        model: async (prompt) => {
          round += 1;
          emit({ kind: "think", round });
          const raw = await askModel(apiKey, prompt, harnesses, modules);
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
          const raw = await deps.runPayload(payload, harnesses, apiKey, {
            signal: deps.signal,
            onCall: (tool, detail) => emit({ kind: "call", round, tool, detail }),
          });
          const next = rewriteStep(raw, task, redirects);
          if (next.usedRedirect) redirects += 1;
          if (isStep) {
            const frame = describeStepFrame(next.raw);
            if (frame?.kind === "fail") emit({ kind: "compile_failed", round, message: frame.message });
            else if (frame?.kind === "ok") {
              for (const effect of frame.effects) emit({ kind: "effect", round, ...effect });
              emit({ kind: "step", round, reply: frame.reply, text: frame.text });
            }
          }
          return next.raw;
        },
      },
      { signal: deps.signal },
    );
    const carried = {
      files: result.files,
      steps: result.steps,
      modules: result.modules,
      journal: result.journal,
      memory: result.memory,
    };
    if (result.status === "error") return { ok: false, error: result.answer || "循环没有跑起来。", ...carried };
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
  }
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
    if (!apiKey) {
      return { ok: false, error: "Grok 没有接上。", files: data.files, steps: [], modules: data.modules, journal: data.journal, memory: data.memory };
    }
    const { runCore, runPayload } = await import("./ocaml-run.ts");
    const { deskProgress } = await import("./progress.server.ts");
    const jobId = data.jobId;
    const controller = new AbortController();
    if (jobId) {
      deskProgress.open(jobId);
      deskProgress.attachAbort(jobId, () => controller.abort());
    }
    const result = await runDeskLoop(apiKey, data.task, data.files, data.harnesses, data.modules, data.journal, data.memory, {
      runCore,
      runPayload,
      signal: controller.signal,
      emit: jobId ? (event) => deskProgress.emit(jobId, event) : undefined,
    });
    if (jobId) deskProgress.close(jobId, result, result.ok);
    return result;
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

export const stopDesk = createServerFn({ method: "POST" })
  .validator(readJobInput)
  .handler(async ({ data }): Promise<{ stopped: boolean }> => {
    const { deskProgress } = await import("./progress.server.ts");
    return { stopped: deskProgress.cancel(data.jobId) };
  });
