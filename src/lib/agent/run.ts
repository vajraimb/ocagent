import { createServerFn } from "@tanstack/react-start";
import { normalizeHarnesses, normalizeModules, type DeskModule, type HarnessId } from "./harness.ts";
import { fetchPublic } from "./net.ts";
import { orderCalls, searchWeb } from "./search.ts";
import { safePath, type DeskFile, type JournalItem, type ToolStep } from "./workspace.ts";

export type { JournalItem };

export type DeskResult =
  | { ok: true; answer: string; files: DeskFile[]; steps: ToolStep[]; modules: DeskModule[]; journal: JournalItem[]; memory: string }
  | { ok: false; error: string; files: DeskFile[]; steps: ToolStep[]; modules: DeskModule[]; journal: JournalItem[]; memory: string };

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

function instructionsFor(harnesses: HarnessId[], modules: DeskModule[]): string {
  const lines = [
    "你是这个工作区里的 agent。只用下面列出来的工具，不要发明别的。",
    "一轮只做一类事：网页或网络先做完，看到结果后再写文件或跑 OCaml。",
    "最多三轮。够了就停，用纯文本给出结果，不要空转。",
    "不能跑 shell。做完就停，不要为了继续而继续调工具。",
  ];
  if (harnesses.includes("files")) {
    lines.push("文件只用 list_files、read_file、find_in_files、write_file、delete_file。find_in_files 不看网页。改文件必须调用 write_file。");
  } else lines.push("文件工具没开，不要改文件，也不要假装改过。");
  if (harnesses.includes("web")) lines.push("工作区以外的事实只用 web_search。不要说自己不能上网。");
  else lines.push("网页工具没开，不要声称查过网页。");
  if (harnesses.includes("net")) lines.push("要看某个具体网址，只用 http_get。");
  if (harnesses.includes("ocaml")) {
    lines.push("用户要求加载为 harness 时，先 write_file，再 load_harness，传入模块名和文件路径。只调用 ocaml_run 不会出现在列表里。");
    lines.push("写完 .ml 用 ocaml_run 跑。退出码不是 0 就不算做成。把 ocaml_run 的输出作为结果，不要改成手工验算。");
    const mods = [harnesses.includes("net") ? "Net.get" : "", harnesses.includes("web") ? "Search.query" : ""].filter(Boolean);
    lines.push(mods.length ? `OCaml 里要上网，只用 ${mods.join(" 和 ")}。` : "网页和网络都没开，这次 OCaml 只能用标准库。");
    if (modules.length) lines.push(`已装的自定义 module：${modules.map((mod) => mod.name).join("、")}。可以直接调用。`);
  }
  lines.push("做完用用户的语言，用几句纯文本说明结果，不要用 markdown。");
  return lines.join("\n");
}

export function parseDeskInput(input: unknown): { task: string; files: DeskFile[]; harnesses: HarnessId[]; modules: DeskModule[]; journal: JournalItem[]; memory: string } | { error: string } {
  if (!input || typeof input !== "object") return { error: "请求不对" };
  const task = "task" in input && typeof input.task === "string" ? input.task.trim() : "";
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
  return { task, files, harnesses, modules, journal, memory };
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
    signal: AbortSignal.timeout(12_000),
    body: JSON.stringify({
      model: "grok-4.5",
      reasoning: { effort: "low" },
      max_output_tokens: 4000,
      instructions: instructionsFor(harnesses, modules),
      input: [{ role: "user", content: prompt.slice(0, 24_000) }],
      tools: toolsFor(harnesses),
    }),
  })
    .then(async (response) => {
      if (!response.ok) return `error\n${block(`模型没有接上（${response.status}）。`)}`;
      const body = (await response.json()) as ResponseBody;
      const calls = (body.output ?? []).filter((item) => item.type === "function_call" && item.name);
      if (calls.length === 0) return `text\n${block(textOf(body))}`;
      const ordered = orderCalls(calls);
      let out = `tools\n${ordered.length}\n`;
      for (const call of ordered) {
        const parsed = parseArgs(call.arguments);
        const args = Object.entries(parsed.args).flatMap(([key, value]) => (typeof value === "string" ? [[key, value] as const] : []));
        out += `${call.name ?? ""}\n${args.length}\n`;
        for (const [key, value] of args) out += `${key}\n${block(value)}`;
      }
      return out;
    })
    .catch((err: unknown) => {
      const slow = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
      const message = slow ? "模型太慢，这一步停了。点继续可以接着做。" : err instanceof Error ? err.message : "模型没有回应";
      return `error\n${block(message)}`;
    });
}

export async function runDeskLoop(
  apiKey: string,
  task: string,
  files: DeskFile[],
  harnesses: HarnessId[],
  modules: DeskModule[] = [],
  journal: JournalItem[] = [],
  memory = "",
  deps: {
    runCore: (job: CoreJob, handlers: CoreHandlers) => Promise<CoreResult>;
    runPayload: (payload: string, harnesses: HarnessId[], apiKey: string | undefined) => Promise<string>;
  },
): Promise<DeskResult> {
  try {
    const result = await deps.runCore(
      { task, harnesses, files, modules, journal, memory },
      {
        model: (prompt) => askModel(apiKey, prompt, harnesses, modules),
        net: (url) => fetchPublic(url),
        search: (query) => searchWeb(apiKey, query),
        ocaml: (payload) => deps.runPayload(payload, harnesses, apiKey),
      },
    );
    const carried = {
      files: result.files,
      steps: result.steps,
      modules: result.modules,
      journal: result.journal,
      memory: result.memory,
    };
    if (result.status === "error") return { ok: false, error: result.answer || "循环没有跑起来。", ...carried };
    return { ok: true, answer: result.answer, ...carried };
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
  .validator((input: unknown): { task: string; files: DeskFile[]; harnesses: HarnessId[]; modules: DeskModule[]; journal: JournalItem[]; memory: string } => {
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
    return runDeskLoop(apiKey, data.task, data.files, data.harnesses, data.modules, data.journal, data.memory, { runCore, runPayload });
  });
