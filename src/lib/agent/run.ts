import { createServerFn } from "@tanstack/react-start";
import { STEP_MS, TOTAL_MS, settle } from "./budget.ts";
import { normalizeHarnesses, type HarnessId } from "./harness.ts";
import { fetchPublic } from "./net.ts";
import { applyTool, safePath, type DeskFile, type ToolStep } from "./workspace.ts";
import { callsThisRound, orderCalls, searchWeb, webSearchSteps } from "./search.ts";

export type DeskDeps = {
  ocaml: (files: DeskFile[], entry: string, harnesses: HarnessId[]) => Promise<string>;
};

export type DeskResult =
  | { ok: true; answer: string; files: DeskFile[]; steps: ToolStep[] }
  | { ok: false; error: string; files: DeskFile[]; steps: ToolStep[] };

const MAX_ROUNDS = 4;
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
    name: "search",
    description: "Search text inside workspace files only. This cannot see the web.",
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
  description: "Run one workspace .ml file. Enabled harnesses are in scope: Net.get and Search.query. Call this after write_file.",
  parameters: {
    type: "object",
    properties: { path: { type: "string" } },
    required: ["path"],
    additionalProperties: false,
  },
};

function toolsFor(harnesses: HarnessId[]) {
  const tools: object[] = [...FILE_TOOLS];
  if (harnesses.includes("search")) tools.push(SEARCH_TOOL);
  if (harnesses.includes("net")) tools.push(HTTP_TOOL);
  if (harnesses.includes("ocaml")) tools.push(OCAML_TOOL);
  return tools;
}

function instructionsFor(harnesses: HarnessId[]): string {
  const lines = [
    "你是这个工作区里的 agent，用工具把任务做完。",
    "工作区用 list_files、read_file、search、write_file、delete_file。任务里如果已经带了文件内容，不要再把每个文件读一遍。",
    "改文件必须调用 write_file，不要假装已经改了。不能跑 shell。",
    "一轮只做一类事：网络和搜索先做完，看到结果后再写文件或跑 OCaml。不要在同一次回复里又查又写。",
  ];
  if (harnesses.includes("search")) lines.push("工作区以外的事实用 web_search。不要说自己不能上网。");
  else lines.push("搜索 harness 没开，不要声称查过网页。");
  if (harnesses.includes("net")) lines.push("要看某个具体网址，用 http_get。");
  if (harnesses.includes("ocaml")) {
    lines.push("写完 .ml 用 ocaml_run 跑。报错就改文件再跑。把 ocaml_run 的输出作为结果，不要改成手工验算，也不要说运行器对不上系统库。");
    const mods = [
      harnesses.includes("net") ? "Net.get" : "",
      harnesses.includes("search") ? "Search.query" : "",
    ].filter(Boolean);
    lines.push(
      mods.length
        ? `OCaml 里可以直接调用 ${mods.join(" 和 ")}，不要局限在没有网络的标准库写法。不要用没装上的 opam 包。`
        : "OCaml harness 开了，但网络和搜索没开，所以这次只能用标准库。",
    );
  }
  lines.push("做完用用户的语言，用几句纯文本说明结果，不要用 markdown。");
  return lines.join("\n");
}

export function parseDeskInput(input: unknown): { task: string; files: DeskFile[]; harnesses: HarnessId[] } | { error: string } {
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
  return { task, files, harnesses };
}

export async function runDeskLoop(
  apiKey: string,
  task: string,
  files: DeskFile[],
  harnesses: HarnessId[],
  deps?: DeskDeps,
): Promise<DeskResult> {
  let current = files.map((file) => ({ ...file }));
  const steps: ToolStep[] = [];
  let previous: string | undefined;
  let input: unknown[] = [
    {
      role: "user",
      content: `工作区：\n${workspaceContext(current)}\n\n任务：${task}`,
    },
  ];
  let answer = "";
  let timedOut = false;
  const started = Date.now();

  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    const remaining = TOTAL_MS - (Date.now() - started);
    if (remaining < 5_000) {
      timedOut = true;
      break;
    }
    let response: Response;
    try {
      response = await fetch("https://api.x.ai/v1/responses", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        signal: AbortSignal.timeout(Math.min(16_000, remaining - 1_000)),
        body: JSON.stringify({
          model: "grok-4.5",
          reasoning: { effort: "low" },
          max_output_tokens: 1600,
          instructions: previous ? undefined : instructionsFor(harnesses),
          previous_response_id: previous,
          input,
          tools: toolsFor(harnesses),
        }),
      });
    } catch (err) {
      if (!isTimeout(err)) throw err;
      timedOut = true;
      steps.push({ tool: "budget", detail: "时限", output: "模型这一步超时了，先交出现有结果。" });
      break;
    }
    if (!response.ok) {
      const denied = response.status === 401 || response.status === 403;
      if (!denied && (steps.length > 0 || doneNote(files, current))) {
        return {
          ok: true,
          answer: settle({ answer, note: doneNote(files, current), steps, timedOut: true }),
          files: current,
          steps,
        };
      }
      return {
        ok: false,
        error: denied ? "Grok 没有接上。" : `模型没有接上（${response.status}）。`,
        files: current,
        steps,
      };
    }
    const body = (await response.json()) as ResponseBody;
    if (!body.id || !Array.isArray(body.output)) {
      return { ok: false, error: "模型的回复对不上。", files: current, steps };
    }
    steps.push(...webSearchSteps(body.output));
    const calls = body.output.filter((item) => item.type === "function_call" && item.call_id && item.name);
    answer = textOf(body) || answer;
    if (calls.length === 0) {
      return { ok: true, answer: answer || doneNote(files, current), files: current, steps };
    }
    const { run, defer } = callsThisRound(calls);
    const outputs = [];
    for (const call of defer) {
      const output = "先不执行。搜索结果还没回来，下一轮再写或再跑。";
      steps.push({ tool: call.name || "tool", detail: "推迟", output });
      outputs.push({ type: "function_call_output", call_id: call.call_id, output });
    }
    for (const call of orderCalls(run)) {
      const parsed = parseArgs(call.arguments);
      if ((call.name || "") === "ocaml_run") {
        const entry = typeof parsed.args.path === "string" ? parsed.args.path.trim() : "";
        const output = parsed.error
          ? parsed.error
          : !harnesses.includes("ocaml")
            ? "OCaml harness 没开。"
            : deps?.ocaml
              ? await bounded(STEP_MS, () => deps.ocaml(current, entry, harnesses))
              : "这台服务器没有 OCaml。";
        steps.push({ tool: "ocaml_run", detail: entry || "路径", output: output.slice(0, 280) });
        outputs.push({ type: "function_call_output", call_id: call.call_id, output: output.slice(0, 4000) });
        continue;
      }
      if ((call.name || "") === "http_get") {
        const url = typeof parsed.args.url === "string" ? parsed.args.url.trim().slice(0, 500) : "";
        const output = parsed.error || !url ? parsed.error || "地址是空的" : await bounded(STEP_MS, () => fetchPublic(url));
        steps.push({ tool: "http_get", detail: url || "空", output: output.slice(0, 280) });
        outputs.push({ type: "function_call_output", call_id: call.call_id, output: output.slice(0, 3500) });
        continue;
      }
      if ((call.name || "") === "web_search") {
        const query = typeof parsed.args.query === "string" ? parsed.args.query.trim().slice(0, 200) : "";
        const output = parsed.error || !query ? parsed.error || "查询是空的" : await bounded(STEP_MS, () => searchWeb(apiKey, query));
        steps.push({ tool: "web_search", detail: query || "空", output: output.slice(0, 280) });
        outputs.push({ type: "function_call_output", call_id: call.call_id, output: output.slice(0, 1500) });
        continue;
      }
      const applied = parsed.error
        ? { files: current, detail: call.name || "tool", output: parsed.error }
        : applyTool(current, call.name || "", parsed.args);
      current = applied.files;
      const output = applied.output.slice(0, 4000);
      steps.push({ tool: call.name || "tool", detail: applied.detail, output: output.slice(0, 280) });
      outputs.push({ type: "function_call_output", call_id: call.call_id, output });
    }
    previous = body.id;
    input = outputs;
  }

  const note = doneNote(files, current);
  return {
    ok: true,
    answer: settle({ answer, note, steps, timedOut }),
    files: current,
    steps,
  };
}

function workspaceContext(files: DeskFile[]): string {
  const total = files.reduce((sum, file) => sum + file.content.length, 0);
  if (files.length > 8 || total > 12_000) return files.map((file) => file.path).join("\n") || "（空）";
  if (files.length === 0) return "（空）";
  return files.map((file) => `--- ${file.path}\n${file.content}`).join("\n\n");
}

function doneNote(before: DeskFile[], after: DeskFile[]): string {
  const notes: string[] = [];
  for (const file of after) {
    const prev = before.find((item) => item.path === file.path);
    if (!prev) notes.push(`新建了 ${file.path}`);
    else if (prev.content !== file.content) notes.push(`改了 ${file.path}`);
  }
  for (const file of before) {
    if (!after.some((item) => item.path === file.path)) notes.push(`删了 ${file.path}`);
  }
  return notes.length ? `${notes.join("，")}。右边可以打开看。` : "";
}

function isTimeout(err: unknown): boolean {
  return err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
}

function bounded(ms: number, run: () => Promise<string>): Promise<string> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve("这一步超时了。"), ms);
    run()
      .then((value) => {
        clearTimeout(timer);
        resolve(value.slice(0, 4000));
      })
      .catch((err: unknown) => {
        clearTimeout(timer);
        resolve(isTimeout(err) ? "这一步超时了。" : "这一步没有完成。");
      });
  });
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
  .validator((input: unknown): { task: string; files: DeskFile[]; harnesses: HarnessId[] } => {
    const parsed = parseDeskInput(input);
    if ("error" in parsed) throw new Error(parsed.error);
    return parsed;
  })
  .handler(async ({ data }): Promise<DeskResult> => {
    const apiKey = process.env.XAI_API_KEY;
    if (!apiKey) return { ok: false, error: "Grok 没有接上。", files: data.files, steps: [] };
    let ocaml: DeskDeps["ocaml"] = async () => "这台服务器没有 OCaml。";
    try {
      const mod = await import("./ocaml-run.ts");
      ocaml = (files, entry, harnesses) => mod.runOcaml(files, entry, { apiKey, harnesses });
    } catch {
      ocaml = async () => "这台服务器没有 OCaml。";
    }
    try {
      return await runDeskLoop(apiKey, data.task, data.files, data.harnesses, { ocaml });
    } catch (err) {
      if (isTimeout(err)) {
        return {
          ok: true,
          answer: "时限到了，这次没有新的结果。把任务写短一点再发一次。",
          files: data.files,
          steps: [],
        };
      }
      return { ok: false, error: "模型这次没有回应。", files: data.files, steps: [] };
    }
  });

