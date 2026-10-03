import type { AgentResult, Eff, LlmResponse, Msg, Probe, ToolResult } from "./types.ts";
import { MATH_PATH } from "./world.ts";

const SYSTEM = "你是一个只通过 effect 行动的 OCaml 补丁 agent。";

export function* sweAgent(prompt: string, probe: Probe): Generator<Eff, AgentResult, unknown> {
  try {
    const stamp = (yield { tag: "FreshId" }) as string;
    const now = (yield { tag: "Now" }) as number;
    yield { tag: "Checkpoint", label: "start" };

    const history: Msg[] = [
      { role: "system", content: SYSTEM },
      { role: "user", content: prompt },
    ];
    const plan = (yield {
      tag: "Llm",
      request: { purpose: "plan", messages: history },
    }) as LlmResponse;
    history.push({ role: "assistant", content: plan.text });

    const read = (yield {
      tag: "Tool",
      call: { callId: "read-math", name: "read_file", args: { path: MATH_PATH } },
    }) as ToolResult;
    history.push({ role: "tool", content: read.output });

    let diagnostics: string[] = [];
    let attempts = 0;
    let ok = false;
    while (attempts < 3) {
      attempts += 1;
      const purpose = attempts === 1 ? "patch" : "retry";
      const reply = (yield {
        tag: "Llm",
        request: {
          purpose,
          messages: [
            ...history,
            { role: "user", content: diagnostics.join("\n") || "写补丁" },
          ],
        },
      }) as LlmResponse;
      const wrote = (yield {
        tag: "Tool",
        call: {
          callId: `patch-${attempts}`,
          name: "apply_patch",
          args: reply.tool?.args ?? { path: MATH_PATH, content: reply.text },
        },
      }) as ToolResult;
      diagnostics = wrote.diagnostics;
      if (wrote.ok) {
        ok = true;
        break;
      }
      history.push({ role: "tool", content: wrote.output });
    }

    let published: AgentResult["published"] = "skipped";
    if (prompt.includes("发布")) {
      const shell = (yield {
        tag: "Tool",
        call: {
          callId: "publish",
          name: "shell",
          args: { cmd: "dune build && publish" },
        },
      }) as ToolResult;
      published = shell.ok ? "yes" : "rejected";
    }

    yield { tag: "Checkpoint", label: "done" };
    return { ok, attempts, stamp, now, published, diagnostics };
  } finally {
    probe.released = true;
  }
}
