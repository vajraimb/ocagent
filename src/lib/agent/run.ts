import { createServerFn } from "@tanstack/react-start";
import { applyTool, safePath, type DeskFile, type ToolStep } from "./workspace.ts";

export type DeskResult =
  | { ok: true; answer: string; files: DeskFile[]; steps: ToolStep[] }
  | { ok: false; error: string; files: DeskFile[]; steps: ToolStep[] };

const MAX_ROUNDS = 4;
const MAX_TASK = 1000;

const TOOLS = [
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
    description: "Find lines containing the query",
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

const INSTRUCTIONS = `你是这个工作区里的 agent，不是只会改某一个文件的脚本。
用 list_files、read_file、search、write_file、delete_file 完成用户交代的事。
改文件必须调用 write_file，不要假装已经改了。
路径用相对路径。不能跑 shell，也不能上网。做不到就直接说。
做完用用户的语言，用几句纯文本说明你实际做了什么，不要用 markdown。`;

export function parseDeskInput(input: unknown): { task: string; files: DeskFile[] } | { error: string } {
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
  return { task, files };
}

export async function runDeskLoop(apiKey: string, task: string, files: DeskFile[]): Promise<DeskResult> {
  let current = files.map((file) => ({ ...file }));
  const steps: ToolStep[] = [];
  let previous: string | undefined;
  let input: unknown[] = [
    {
      role: "user",
      content: `当前文件：\n${current.map((file) => file.path).join("\n") || "（空）"}\n\n任务：${task}`,
    },
  ];

  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    const response = await fetch("https://api.x.ai/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      signal: AbortSignal.timeout(25_000),
      body: JSON.stringify({
        model: "grok-4.5",
        reasoning: { effort: "low" },
        max_output_tokens: 500,
        instructions: previous ? undefined : INSTRUCTIONS,
        previous_response_id: previous,
        input,
        tools: TOOLS,
      }),
    });
    if (!response.ok) {
      return { ok: false, error: `模型没有接上（${response.status}）。`, files: current, steps };
    }
    const body = (await response.json()) as ResponseBody;
    if (!body.id || !Array.isArray(body.output)) {
      return { ok: false, error: "模型的回复对不上。", files: current, steps };
    }
    const calls = body.output.filter((item) => item.type === "function_call" && item.call_id && item.name);
    const answer = textOf(body);
    if (calls.length === 0) {
      return { ok: true, answer: answer || "做完了，但没有留下说明。", files: current, steps };
    }
    const outputs = [];
    for (const call of calls) {
      const args = parseArgs(call.arguments);
      const applied = applyTool(current, call.name || "", args);
      current = applied.files;
      const output = applied.output.slice(0, 4000);
      steps.push({ tool: call.name || "tool", detail: applied.detail, output: output.slice(0, 280) });
      outputs.push({ type: "function_call_output", call_id: call.call_id, output });
    }
    previous = body.id;
    input = outputs;
  }

  return { ok: true, answer: "四轮工具用完了，先停在这里。", files: current, steps };
}

type ResponseBody = {
  id?: string;
  output?: { type?: string; name?: string; call_id?: string; arguments?: string; content?: { text?: string }[] }[];
};

function textOf(body: ResponseBody): string {
  return (body.output ?? [])
    .filter((item) => item.type === "message")
    .flatMap((item) => item.content ?? [])
    .map((part) => part.text ?? "")
    .join("\n")
    .trim();
}

function parseArgs(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    return {};
  }
  return {};
}

export const runDesk = createServerFn({ method: "POST" })
  .validator((input: unknown): { task: string; files: DeskFile[] } => {
    const parsed = parseDeskInput(input);
    if ("error" in parsed) throw new Error(parsed.error);
    return parsed;
  })
  .handler(async ({ data }): Promise<DeskResult> => {
    const apiKey = process.env.XAI_API_KEY;
    if (!apiKey) return { ok: false, error: "这环境没有接上模型。", files: data.files, steps: [] };
    try {
      return await runDeskLoop(apiKey, data.task, data.files);
    } catch {
      return { ok: false, error: "模型这次没有回应。", files: data.files, steps: [] };
    }
  });

