export const STEP_MS = 12_000;
export const TOTAL_MS = 40_000;

type Step = { tool: string; detail: string; output: string };

export function settle(input: { answer: string; note: string; steps: Step[]; timedOut: boolean }): string {
  if (input.answer && !input.timedOut) return input.answer;
  const lines: string[] = [];
  if (input.answer) lines.push(input.answer);
  if (input.note) lines.push(input.note);
  for (const step of input.steps) {
    if (step.detail === "推迟" || step.tool === "budget") continue;
    if (step.tool !== "web_search" && step.tool !== "http_get" && step.tool !== "ocaml_run" && step.tool !== "write_file" && step.tool !== "load_harness") {
      continue;
    }
    lines.push(`${step.detail}：${step.output.replace(/\s+/g, " ").slice(0, 220)}`);
  }
  if (input.timedOut) lines.push("时限到了，这是已经做出的部分。");
  return lines.filter(Boolean).join("\n") || "时限到了，还没有结果。把任务写短一点再发一次。";
}
