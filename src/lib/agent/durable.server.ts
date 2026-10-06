import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { DEV_USER_ID, UnauthorizedError, authConfigured, getSessionUser } from "@/lib/auth/verify.server";
import { gateIdentityEnabled } from "@/lib/auth/gate-identity.server";
import { isWorkspacePreview } from "@/lib/env.server";
import { parseResponse, type DurableResponse } from "./durable-types";

const maxFrame = 262144;

function gatewayBinary(): string {
  if (process.env.OCAGENT_GATEWAY?.trim()) return process.env.OCAGENT_GATEWAY.trim();
  const candidates = [
    path.resolve(process.cwd(), "_build/default/ocaml/bin/workbench_gateway.exe"),
    path.resolve(process.cwd(), "ocaml/_build/default/bin/workbench_gateway.exe"),
  ];
  return candidates.find((item) => existsSync(item)) ?? candidates[0];
}

function durableRoot(): string {
  const configured = process.env.OCAGENT_DURABLE_ROOT?.trim();
  return path.resolve(configured || path.join(process.cwd(), "var/ocagent-durable"));
}

function failure(layer: string, code: string, message: string, retry: string): DurableResponse {
  return {
    ok: false,
    projection: null,
    error: { layer, code, message, retry_advice: retry },
    runs: [],
    truncated: false,
  };
}

export async function resolveDurableOwner(bearer?: string): Promise<string> {
  if (authConfigured || gateIdentityEnabled()) {
    const user = await getSessionUser(bearer);
    if (!user) throw new UnauthorizedError();
    return user.id;
  }
  if (process.env.DATABASE_URL?.trim()) {
    throw new Error("未登录且配置了数据库，拒绝共享身份");
  }
  if (!isWorkspacePreview()) {
    throw new Error("耐久模式在未登录的公开部署上关闭");
  }
  return DEV_USER_ID;
}

function encodeFrame(text: string): Buffer {
  const body = Buffer.from(text, "utf8");
  if (body.length > maxFrame) throw new Error("frame");
  const head = Buffer.alloc(4);
  head.writeUInt32BE(body.length, 0);
  return Buffer.concat([head, body]);
}

function takeFrame(buffer: Buffer): { frame: string; rest: Buffer } | null {
  if (buffer.length < 4) return null;
  const size = buffer.readUInt32BE(0);
  if (size <= 0 || size > maxFrame) throw new Error("frame");
  if (buffer.length < 4 + size) return null;
  return { frame: buffer.subarray(4, 4 + size).toString("utf8"), rest: buffer.subarray(4 + size) };
}

type GatewayBody = Record<string, unknown>;

export async function callGateway(op: string, fields: GatewayBody, owner: string): Promise<DurableResponse> {
  const binary = gatewayBinary();
  if (!existsSync(binary)) {
    return failure("toolchain", "gateway_missing", "可信入口不可用", "不要改走旧工作台自动执行");
  }
  const root = durableRoot();
  const fetchUrl = process.env.OCAGENT_FETCH_URL?.trim() ?? "";
  const payload = { v: "workbench_v1", id: `n-${Date.now().toString(36)}`, op, owner, ...fields };
  const timeout = op === "prepareRun" || op === "commitModel" ? 90_000 : op === "startOrResumeRun" ? 45_000 : 15_000;
  const child = spawn(binary, [], {
    env: { ...process.env, OCAGENT_DURABLE_ROOT: root, OCAGENT_FETCH_URL: fetchUrl },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    if (stderr.length < 4096) stderr += chunk.toString("utf8");
  });
  const text = JSON.stringify(payload);
  try {
    child.stdin?.end(encodeFrame(text));
  } catch {
    child.kill("SIGKILL");
    return failure("protocol", "frame", "请求超过上限", "缩短材料");
  }
  const raw = await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("timeout"));
    }, timeout);
    child.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks));
    });
  }).catch((error: Error) => error);
  if (raw instanceof Error) {
    if ((op === "startOrResumeRun" || op === "prepareRun" || op === "decideApproval" || op === "commitModel" || op === "reserveModel") && typeof fields.run_id === "string") {
      const viewed = await callGateway("getRun", { run_id: fields.run_id }, owner);
      return {
        ...viewed,
        ok: false,
        error: { layer: "protocol", code: "no_final_response", message: "没有最终响应，已回读当前状态", retry_advice: "不要推断成功，也不要自动重发" },
      };
    }
    return failure("protocol", "no_final_response", "没有最终响应", "不要推断成功，也不要自动重发");
  }
  try {
    const taken = takeFrame(raw);
    if (!taken) return failure("protocol", "no_final_response", "没有完整响应", "不要推断成功，也不要自动重发");
    const parsed = parseResponse(JSON.parse(taken.frame) as unknown);
    if (!parsed) return failure("protocol", "bad_response", "响应无法识别", "只读查询，不要重发");
    return parsed;
  } catch {
    return failure("protocol", "bad_response", stderr.trim() || "响应无效", "只读查询，不要重发");
  }
}

const modelId = "grok-4.5";

function stepPrompt(material: string, task: string) {
  return [
    "Write exactly one OCaml step. Output one fenced ocaml block and nothing else.",
    "open Step_api",
    "module Step : STEP = struct",
    "  let run () =",
    "    ...",
    "end",
    "Input.get returns string option. Net.get returns (response, error) result. Match both.",
    "Done, Continue, Ask and Partial each take one string. Trace.note takes one string.",
    "Example shape: match Input.get \"material\", Input.get \"fetch_url\" with | Some material, Some url -> (match Net.get url with | Ok resp -> Done (\"ok:\" ^ material) | Error _ -> Done \"failed\") | _ -> Done \"missing\".",
    "Read the frozen material with Input.get \"material\".",
    "Read the endpoint with Input.get \"fetch_url\" and pass that exact string to Net.get. Do not write a URL yourself.",
    "Do not use Files, Search, Clock, Shell, or any other module. Do not call tools.",
    task ? `Task:\n${task}` : "Task: use the material.",
    "Material:",
    material,
  ].join("\n");
}

function unknownGeneration(reserved: DurableResponse, message: string): DurableResponse {
  return {
    ...reserved,
    ok: false,
    error: {
      layer: "generation",
      code: "Unknown_result",
      message,
      retry_advice: "不要自动再请求。若要再生成，新建一条 run，并注意可能重复计费。",
    },
  };
}

export async function generateAndAdmit(runId: string, owner: string): Promise<DurableResponse> {
  if (!process.env.XAI_API_KEY?.trim()) {
    return failure("generation", "Unavailable", "Grok 不可用", "没有配置模型，不会派发请求");
  }
  const reserved = await callGateway("reserveModel", { run_id: runId }, owner);
  if (reserved.error?.code !== "Needs_model") return reserved;
  const projection = reserved.projection;
  if (!projection) return reserved;
  let text = "";
  try {
    const res = await fetch("https://api.x.ai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.XAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: modelId,
        temperature: 0,
        max_tokens: 2048,
        messages: [
          { role: "system", content: "You emit one OCaml Step module and no tool calls." },
          { role: "user", content: stepPrompt(projection.material, projection.task) },
        ],
      }),
      signal: AbortSignal.timeout(45_000),
    });
    if (!res.ok) return unknownGeneration(reserved, "模型请求已派出，响应不能当成未发生");
    const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    text = body.choices?.[0]?.message?.content ?? "";
  } catch {
    return unknownGeneration(reserved, "模型请求已派出，结果未知");
  }
  if (!text.trim()) return unknownGeneration(reserved, "模型请求已派出，但没有可保存的文本");
  return callGateway("commitModel", { run_id: runId, model_text: text }, owner);
}
