import type { LlmMode, ProfileName } from "./types.ts";

export const PROMPT_FIX = "修复 src/math.ml 里的 add，让它做加法。";
export const PROMPT_PUBLISH = "修复 src/math.ml 里的 add，让它做加法。然后发布。";

export type ScenarioId = "fix" | "retry" | "publish" | "budget" | "compact";

export type Scenario = {
  id: ScenarioId;
  title: string;
  detail: string;
  prompt: string;
  llmMode: LlmMode;
  budgetMax?: number;
  compactThreshold?: number;
};

export const SCENARIOS: Scenario[] = [
  {
    id: "fix",
    title: "修好 add",
    detail: "一次补丁通过校验",
    prompt: PROMPT_FIX,
    llmMode: "correct-first",
  },
  {
    id: "retry",
    title: "校验打回",
    detail: "错误补丁带着诊断重试，不静默改写",
    prompt: PROMPT_FIX,
    llmMode: "wrong-then-right",
  },
  {
    id: "publish",
    title: "高风险发布",
    detail: "policy 把 shell 转成 Ask_human",
    prompt: PROMPT_PUBLISH,
    llmMode: "correct-first",
  },
  {
    id: "budget",
    title: "预算",
    detail: "第二次模型调用被截断",
    prompt: PROMPT_FIX,
    llmMode: "correct-first",
    budgetMax: 1,
  },
  {
    id: "compact",
    title: "摘要",
    detail: "上下文超过阈值时先做 Llm 摘要",
    prompt: PROMPT_FIX,
    llmMode: "correct-first",
    compactThreshold: 4,
  },
];

export function scenarioById(id: ScenarioId): Scenario {
  return SCENARIOS.find((item) => item.id === id) ?? SCENARIOS[0]!;
}

export const PROFILE_COPY: Record<ProfileName, { title: string; detail: string }> = {
  dev: {
    title: "Dev",
    detail: "全套 handler，宽松预算，人在回路里",
  },
  eval: {
    title: "Eval",
    detail: "无 policy / 无摘要，同一 fixture 必须逐字节一致",
  },
  prod: {
    title: "Prod",
    detail: "沙箱、审批、摘要、回放日志都打开",
  },
};
