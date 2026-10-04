import type { AgentResult, Decision, Eff, JournalEntry, Probe, ToolResult } from "./types.ts";
import { fileIsAdd, FIXED_ADD, MATH_PATH, WRONG_PATCH } from "./world.ts";

export type Act =
  | { kind: "read" }
  | { kind: "wrong" }
  | { kind: "fix" }
  | { kind: "lint" }
  | { kind: "ask"; action: string }
  | { kind: "shell"; cmd: string };

export type Understanding = {
  heard: string;
  lines: string[];
  acts: Act[];
  error: string | null;
};

export type Preset = {
  id: string;
  title: string;
  detail: string;
  source: string;
};

const REFUSAL =
  "这句话我接不住。这个沙箱里我可以看 src/math.ml 错在哪、把减法改成加法、校验、问你，或申请跑一条命令。";

export const PRESETS: Preset[] = [
  {
    id: "ship",
    title: "修好并发布",
    detail: "自己看文件，改对，校验，发布前停下",
    source: "把 src/math.ml 的加法修好，校验通过再发布",
  },
  {
    id: "look",
    title: "只看不改",
    detail: "说出错在哪，不动文件",
    source: "看看 src/math.ml 错在哪，不要改",
  },
  {
    id: "retry",
    title: "写错再改",
    detail: "先按你的要求写错，校验失败后再改对",
    source: "故意把加法写错，校验失败后再改对",
  },
  {
    id: "gate",
    title: "先问再发",
    detail: "改完先问你，同意才申请发布",
    source: "把加法改好，问我能不能发布，同意再发布",
  },
];

type Mark = Act | { kind: "look" };

export function understand(text: string): Understanding {
  const raw = text.trim();
  if (!raw) return { heard: "", lines: [], acts: [], error: "先写一句要做的事。" };

  const noWrite = /不要改|别改|别动|不要写|只看|只读|先别改|不要修/.test(raw);
  const noShip = /不要发布|别发布|先别发|不要跑|别跑/.test(raw);
  const noAsk = /不要问|别问/.test(raw);
  const marks: { at: number; act: Mark }[] = [];

  const wrongAt = findAt(raw, ["写错", "故意写", "写坏"]);
  if (wrongAt >= 0) marks.push({ at: wrongAt, act: { kind: "wrong" } });

  if (!noWrite) {
    const fixAt = findAt(raw, ["修好", "修改", "修正", "改好", "改对", "改成", "再改", "fix", "修"]);
    if (fixAt >= 0) marks.push({ at: fixAt, act: { kind: "fix" } });
  }

  const lookAt = findAt(raw, ["看看", "看一下", "看下", "只看", "只读", "错在", "什么问题", "巡检", "为什么", "读一下", "读一读", "打开", "检查", "读"]);
  if (lookAt >= 0) marks.push({ at: lookAt, act: { kind: "look" } });

  const lintAt = findAt(raw, ["校验", "lint"]);
  if (lintAt >= 0) marks.push({ at: lintAt, act: { kind: "lint" } });

  if (!noAsk) {
    const askAt = findAt(raw, ["问我", "先问", "询问"]);
    if (askAt >= 0) marks.push({ at: askAt, act: { kind: "ask", action: askAction(raw, askAt) } });
  }

  const cmd = extractCmd(raw);
  const shipAt = findAt(raw, ["发布", "publish", "运行", "跑一下", "跑"]);
  if (!noShip && (cmd !== null || /发布|publish/i.test(raw))) {
    marks.push({
      at: shipAt < 0 ? raw.length : shipAt,
      act: { kind: "shell", cmd: cmd ?? "dune build && publish" },
    });
  }

  if (!marks.some((mark) => mark.act.kind === "look" || mark.act.kind === "wrong" || mark.act.kind === "fix" || mark.act.kind === "lint" || mark.act.kind === "ask" || mark.act.kind === "shell")) {
    return { heard: "", lines: [], acts: [], error: REFUSAL };
  }

  marks.sort((left, right) => left.at - right.at);
  const acts: Act[] = [];
  const seen = new Set<string>();
  const wantsFile = marks.some((mark) => mark.act.kind === "look" || mark.act.kind === "fix" || mark.act.kind === "wrong" || mark.act.kind === "lint");
  if (wantsFile) acts.push({ kind: "read" });
  for (const mark of marks) {
    if (mark.act.kind === "look") continue;
    const key = mark.act.kind === "ask" ? `ask:${mark.act.action}` : mark.act.kind;
    if (seen.has(key)) continue;
    seen.add(key);
    acts.push(mark.act);
  }
  if (marks.some((mark) => mark.act.kind === "look") && !acts.some((act) => act.kind === "lint" || act.kind === "fix" || act.kind === "wrong")) {
    acts.push({ kind: "lint" });
  }
  if (acts.length === 0) return { heard: "", lines: [], acts: [], error: REFUSAL };

  const lines = acts.map(lineOf);
  return { heard: `${lines.join("，")}。`, lines, acts, error: null };
}

export function workTitle(entry: JournalEntry): string | null {
  if (entry.kind === "FreshId" || entry.kind === "Now" || entry.kind === "Compact") return null;
  if (entry.label === "Tool · read_file") return "读文件";
  if (entry.label === "Tool · apply_patch") return "写文件";
  if (entry.label === "Tool · lint") return toolCallId(entry).includes(":lint") ? "核对写入" : "校验";
  if (entry.label === "Tool · shell" || entry.label === "Ask_human · shell") return "执行命令";
  if (entry.kind === "AskHuman") return "询问";
  if (entry.kind === "Llm") return "模型";
  if (entry.kind === "Checkpoint") return "检查点";
  return entry.label;
}

export function workDetail(entry: JournalEntry): string {
  if (entry.label === "Tool · apply_patch") {
    const content = argField(entry, "content");
    return content.includes("x + y") && !content.includes("x - y") ? "x + y" : "不是加法";
  }
  if (entry.label === "Tool · shell" || entry.label === "Ask_human · shell") return argField(entry, "cmd") || "shell";
  if (entry.kind === "AskHuman") return entry.label.replace(/^Ask_human · /, "");
  if (entry.status === "Pending") return "还没做";
  const result = entry.result;
  if (result && typeof result === "object" && !Array.isArray(result)) {
    const diagnostics = result.diagnostics;
    if (Array.isArray(diagnostics) && typeof diagnostics[0] === "string" && diagnostics[0]) return diagnostics[0];
    if (typeof result.output === "string" && result.output) return result.output.replace(/^\[sandbox\]\s*/, "");
  }
  return entry.status === "Done" ? "完成" : "等待";
}

export function* commandAgent(prompt: string, probe: Probe): Generator<Eff, AgentResult, unknown> {
  const plan = understand(prompt);
  try {
    const stamp = (yield { tag: "FreshId" }) as string;
    const now = (yield { tag: "Now" }) as number;
    if (plan.error || plan.acts.length === 0) {
      return { ok: false, attempts: 0, stamp, now, published: "skipped", diagnostics: [], answer: plan.error ?? REFUSAL };
    }

    let attempts = 0;
    let ok = true;
    let published: AgentResult["published"] = "skipped";
    const diagnostics: string[] = [];
    const notes: string[] = [];
    let content = "";

    const finish = (extra?: string): AgentResult => ({
      ok,
      attempts,
      stamp,
      now,
      published,
      diagnostics,
      answer: [...notes, extra].filter(Boolean).join(""),
    });

    for (const act of plan.acts) {
      if (act.kind === "read") {
        const got = (yield tool("read-math", "read_file", { path: MATH_PATH })) as ToolResult;
        content = got.output;
        notes.push(fileIsAdd(content) ? "src/math.ml 里的 add 已经是加法。" : "src/math.ml 里的 add 现在是减法。");
        continue;
      }
      if (act.kind === "wrong") {
        const wrote = yield* writePatch("wrong", attempts + 1);
        attempts += 1;
        content = WRONG_PATCH;
        ok = wrote.ok;
        diagnostics.push(...wrote.diagnostics);
        notes.push("按你的要求先写了一笔错的，校验没过。");
        continue;
      }
      if (act.kind === "fix") {
        if (fileIsAdd(content)) {
          notes.push("已经是加法，没有再改。");
          ok = true;
          continue;
        }
        const wrote = yield* writePatch("right", attempts + 1);
        attempts += 1;
        content = FIXED_ADD;
        diagnostics.push(...wrote.diagnostics);
        if (!wrote.ok) {
          const again = yield* writePatch("right", attempts + 1);
          attempts += 1;
          content = FIXED_ADD;
          ok = again.ok;
          diagnostics.push(...again.diagnostics);
          notes.push(again.ok ? "第一笔没过校验，已经改成 x + y。" : "改了两次，校验仍没过。");
        } else {
          ok = true;
          notes.push("已改成 x + y，校验通过。");
        }
        continue;
      }
      if (act.kind === "lint") {
        const checked = (yield tool(`lint-${attempts}`, "lint", { path: MATH_PATH })) as ToolResult;
        const inspecting = !plan.acts.some((item) => item.kind === "fix" || item.kind === "wrong");
        ok = inspecting ? true : checked.ok;
        diagnostics.push(...checked.diagnostics);
        if (checked.ok) {
          if (!notes.some((note) => note.includes("校验通过"))) notes.push("校验通过。");
        } else {
          notes.push(`校验没过：${checked.diagnostics.join(" ")}`);
        }
        continue;
      }
      if (act.kind === "ask") {
        const decision = (yield {
          tag: "AskHuman",
          approval: { action: act.action, risk: "High", payload: { step: act.action } },
        }) as Decision;
        if (decision.tag === "Rejected") {
          published = "rejected";
          ok = false;
          return finish(`你拒绝了：${decision.reason}`);
        }
        notes.push("你同意了。");
        continue;
      }
      const shell = (yield tool("shell", "shell", { cmd: act.cmd })) as ToolResult;
      if (!shell.ok) {
        published = "rejected";
        ok = false;
        diagnostics.push(...shell.diagnostics, shell.output);
        return finish(shell.output ? `命令没跑：${shell.output}` : "命令没跑。");
      }
      published = "yes";
      notes.push(`命令已执行：${act.cmd}。`);
    }

    return finish();
  } finally {
    probe.released = true;
  }
}

function lineOf(act: Act): string {
  switch (act.kind) {
    case "read":
      return "读 src/math.ml";
    case "wrong":
      return "先写一笔错的";
    case "fix":
      return "把减法改成加法";
    case "lint":
      return "校验";
    case "ask":
      return `问你：${act.action}`;
    case "shell":
      return `申请执行 ${act.cmd}`;
  }
}

function findAt(text: string, keys: string[]): number {
  const hay = text.toLowerCase();
  let at = -1;
  for (const key of keys) {
    const found = hay.indexOf(key.toLowerCase());
    if (found >= 0 && (at < 0 || found < at)) at = found;
  }
  return at;
}

function askAction(text: string, at: number): string {
  const tail = text.slice(at).replace(/^(?:先问我|问我|先问|询问)/, "").trim();
  const cut = tail.split(/[。！？\n]/)[0]?.split(/[，,]/)[0]?.trim();
  return cut || "可以继续吗";
}

function extractCmd(text: string): string | null {
  const quoted = text.match(/`([^`]+)`/);
  if (quoted?.[1]?.trim()) return quoted[1].trim();
  const matched = text.match(/(?:运行|跑一下|跑)\s+(.+)$/);
  if (!matched?.[1]) return null;
  return matched[1].replace(/[。！？].*$/, "").trim() || null;
}

function tool(callId: string, name: string, args: Record<string, string>): Eff {
  return { tag: "Tool", call: { callId, name, args } };
}

function* writePatch(mode: "right" | "wrong", attempt: number): Generator<Eff, ToolResult, unknown> {
  return (yield tool(`patch-${attempt}`, "apply_patch", {
    path: MATH_PATH,
    content: mode === "wrong" ? WRONG_PATCH : FIXED_ADD,
  })) as ToolResult;
}

function toolCallId(entry: JournalEntry): string {
  const req = entry.req;
  if (req && typeof req === "object" && !Array.isArray(req) && typeof req.callId === "string") return req.callId;
  return "";
}

function argField(entry: JournalEntry, key: string): string {
  const req = entry.req;
  if (!req || typeof req !== "object" || Array.isArray(req)) return "";
  const args = req.args;
  if (args && typeof args === "object" && !Array.isArray(args) && typeof args[key] === "string") return args[key];
  const payload = req.payload;
  if (payload && typeof payload === "object" && !Array.isArray(payload) && typeof payload[key] === "string") return payload[key];
  if (typeof req[key] === "string") return req[key];
  return "";
}
