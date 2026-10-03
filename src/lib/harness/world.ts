import type { Eff, Json, LlmMode, LlmRequest, LlmResponse, ToolResult, World } from "./types.ts";

export const MATH_PATH = "src/math.ml";
export const BUGGY_ADD = "let add x y = x - y\n";
export const FIXED_ADD = "let add x y = x + y\n";
export const WRONG_PATCH = "let add x y = x - y + 0\n";

export function createWorld(): World {
  return {
    files: { [MATH_PATH]: BUGGY_ADD },
    cache: new Map(),
    log: [],
    sandboxExecs: 0,
    nextId: 1,
    clock: 1_725_000_000,
  };
}

export function fileIsAdd(content: string): boolean {
  return content.includes("x + y") && !content.includes("x - y");
}

export function mockLlm(req: LlmRequest, mode: LlmMode): LlmResponse {
  if (req.purpose === "compact") {
    return { text: `摘要(${req.messages.length}): 把 src/math.ml 的 add 改成加法` };
  }
  if (req.purpose === "plan") {
    return { text: "先读 src/math.ml，再 apply_patch。" };
  }
  if (req.purpose === "retry") {
    const content = mode === "always-wrong" ? WRONG_PATCH : FIXED_ADD;
    return {
      text: "按诊断改正",
      tool: { name: "apply_patch", args: { path: MATH_PATH, content } },
    };
  }
  const content = mode === "correct-first" ? FIXED_ADD : WRONG_PATCH;
  return {
    text: "提交补丁",
    tool: { name: "apply_patch", args: { path: MATH_PATH, content } },
  };
}

export function interpret(eff: Eff, world: World, sandbox: boolean, llmMode: LlmMode): Json {
  switch (eff.tag) {
    case "Now":
      return world.clock;
    case "FreshId": {
      const id = `id-${world.nextId}`;
      world.nextId += 1;
      return id;
    }
    case "Checkpoint":
      return null;
    case "Llm":
      return mockLlm(eff.request, llmMode) as unknown as Json;
    case "Tool":
      return runTool(eff.call.name, eff.call.args, world, sandbox);
    case "AskHuman":
    case "Compact":
      throw new Error(`world 不应直接执行 ${eff.tag}`);
  }
}

function runTool(
  name: string,
  args: Json,
  world: World,
  sandbox: boolean,
): Json {
  const record = (value: ToolResult): Json => {
    if (sandbox) world.sandboxExecs += 1;
    const prefix = sandbox ? "[sandbox] " : "";
    return { ...value, output: prefix + value.output };
  };

  if (name === "read_file") {
    const path = stringField(args, "path");
    const content = world.files[path] ?? "";
    return record({ ok: true, output: content, diagnostics: [] });
  }

  if (name === "apply_patch") {
    const path = stringField(args, "path");
    const content = stringField(args, "content");
    world.files[path] = content;
    return record({ ok: true, output: `wrote ${path}`, diagnostics: [] });
  }

  if (name === "lint") {
    const path = stringField(args, "path");
    const content = world.files[path] ?? "";
    if (fileIsAdd(content)) {
      return record({ ok: true, output: "lint clean", diagnostics: [] });
    }
    return record({
      ok: false,
      output: "lint failed",
      diagnostics: ["src/math.ml:1 add 仍不是加法，期望 `x + y`"],
    });
  }

  if (name === "shell") {
    return record({ ok: true, output: "published", diagnostics: [] });
  }

  return record({
    ok: false,
    output: `unknown tool ${name}`,
    diagnostics: [`没有工具 ${name}`],
  });
}

function stringField(args: Json, key: string): string {
  if (args && typeof args === "object" && !Array.isArray(args)) {
    const value = args[key];
    if (typeof value === "string") return value;
  }
  return "";
}

export function mutationCount(world: World): number {
  return world.log.filter((entry) => !entry.duplicate && (entry.name === "apply_patch" || entry.name === "shell")).length;
}

export type SavedWorld = {
  files: Record<string, string>;
  cache: [string, Json][];
  log: World["log"];
  sandboxExecs: number;
  nextId: number;
  clock: number;
};

export function exportWorld(world: World): SavedWorld {
  return {
    files: world.files,
    cache: [...world.cache.entries()],
    log: world.log,
    sandboxExecs: world.sandboxExecs,
    nextId: world.nextId,
    clock: world.clock,
  };
}

export function importWorld(saved: SavedWorld): World {
  return {
    files: { ...saved.files },
    cache: new Map(saved.cache),
    log: saved.log.map((entry) => ({ ...entry })),
    sandboxExecs: saved.sandboxExecs,
    nextId: saved.nextId,
    clock: saved.clock,
  };
}
