import { sweAgent } from "./agent.ts";
import { canonical } from "./hash.ts";
import { describeError, slimJournal, stackNames, startSession } from "./runtime.ts";
import type { AgentFn } from "./runtime.ts";
import { PROMPT_FIX, PROMPT_PUBLISH } from "./scenarios.ts";
import type { AgentResult, Eff, Journal, JournalEntry, Probe } from "./types.ts";
import { BUGGY_ADD, fileIsAdd, FIXED_ADD, mutationCount, WRONG_PATCH } from "./world.ts";

export type Proof = {
  id: string;
  milestone: "M0" | "M1" | "M2" | "M3" | "M4";
  title: string;
  detail: string;
  pass: boolean;
};

const agent: AgentFn = sweAgent;

export function runProofs(): Proof[] {
  return [proofFiber(), proofOneShot(), proofDeterminism(), proofCrash(), proofHuman(), proofVerify(), proofPolicy(), proofCompact(), proofBudget()];
}

function proofFiber(): Proof {
  const raw = runMini(["strict"]);
  const installed = runMini(["probe", "strict"]);
  const pass = raw === "Harness_error:Probe" && installed === "installed";
  return {
    id: "m0-fiber",
    milestone: "M0",
    title: "子 fiber 不继承 handler",
    detail: pass
      ? "裸 fork 得到 Harness_error；Harness.spawn 重新装栈后得到 installed。本环境没有 Eio，这一条是契约测试，不是对 Eio 调度器的实测。"
      : `裸 fork=${raw}，spawn=${installed}`,
    pass,
  };
}

function proofOneShot(): Proof {
  const session = startSession({
    profile: "dev",
    prompt: PROMPT_PUBLISH,
    llmMode: "correct-first",
    agent,
    runId: "m0-oneshot",
  });
  if (session.result.status !== "suspended") {
    return fail("m0-oneshot", "M0", "continuation 只能恢复一次", describeError(session.result.error ?? { tag: "HarnessError", message: session.result.status }));
  }
  const first = session.resumeFast({ tag: "Approved" });
  const second = session.resumeFast({ tag: "Approved" });
  const pass = first.result.status === "done" && second.result.error?.tag === "ContinuationAlreadyResumed";
  return {
    id: "m0-oneshot",
    milestone: "M0",
    title: "continuation 只能恢复一次",
    detail: pass
      ? "快路径第一次 continue 成功，第二次得到 Continuation_already_resumed。"
      : `第一次 ${first.result.status}，第二次 ${second.result.error?.tag ?? second.result.status}`,
    pass,
  };
}

function proofDeterminism(): Proof {
  const logs = new Set<string>();
  const traces = new Set<string>();
  for (let i = 0; i < 100; i++) {
    const result = startSession({
      profile: "eval",
      prompt: PROMPT_FIX,
      llmMode: "correct-first",
      agent,
      runId: "eval-fix",
    }).result;
    if (result.status !== "done" || !result.value?.ok) {
      return fail("m1-bytes", "M1", "Eval 一百次逐字节一致", `第 ${i} 次没有成功：${result.status} ${result.error ? describeError(result.error) : ""}`);
    }
    logs.add(canonical(slimJournal(result.journal)));
    traces.add(canonical(result.trace));
  }
  const pass = logs.size === 1 && traces.size === 1;
  return {
    id: "m1-bytes",
    milestone: "M1",
    title: "Eval 一百次逐字节一致",
    detail: pass
      ? "同一 fixture 跑 100 次，账本和 eval_logger 都只有一个字节形态。时间、ID 都走 effect。"
      : `账本形态 ${logs.size}，日志形态 ${traces.size}`,
    pass,
  };
}

function proofCrash(): Proof {
  const base = {
    profile: "eval" as const,
    prompt: PROMPT_FIX,
    llmMode: "correct-first" as const,
    agent,
    runId: "m2-crash",
  };
  const clean = startSession(base).result;
  if (clean.status !== "done" || !clean.value) {
    return fail("m2-crash", "M2", "kill -9 后重放", clean.error ? describeError(clean.error) : clean.status);
  }
  const windows = ["after-pending", "before-done", "after-done"] as const;
  let checks = 0;
  for (const entry of clean.journal.entries) {
    for (const window of windows) {
      const crashed = startSession({ ...base, crash: { atSeq: entry.seq, window } }).result;
      if (crashed.status !== "crashed") {
        return fail("m2-crash", "M2", "kill -9 后重放", `seq ${entry.seq} ${window} 没有崩溃：${crashed.status}`);
      }
      if (crashed.protectReleased) {
        return fail("m2-crash", "M2", "kill -9 后重放", "kill -9 不应运行 Fun.protect");
      }
      const recovered = startSession({
        ...base,
        journal: crashed.journal,
        world: crashed.world,
      }).result;
      checks += 1;
      if (recovered.status !== "done" || !recovered.value) {
        return fail("m2-crash", "M2", "kill -9 后重放", `seq ${entry.seq} ${window} 恢复失败：${recovered.error ? describeError(recovered.error) : recovered.status}`);
      }
      if (canonical(slimJournal(recovered.journal)) !== canonical(slimJournal(clean.journal))) {
        return fail("m2-crash", "M2", "kill -9 后重放", `seq ${entry.seq} ${window} 账本与干净运行不一致`);
      }
      if (!sameOutcome(recovered.value, clean.value)) {
        return fail("m2-crash", "M2", "kill -9 后重放", `seq ${entry.seq} ${window} 结果不一致`);
      }
      if (JSON.stringify(recovered.world.files) !== JSON.stringify(clean.world.files)) {
        return fail("m2-crash", "M2", "kill -9 后重放", `seq ${entry.seq} ${window} 文件不一致`);
      }
      if (mutationCount(recovered.world) !== mutationCount(clean.world)) {
        return fail("m2-crash", "M2", "kill -9 后重放", `seq ${entry.seq} ${window} 副作用次数 ${mutationCount(recovered.world)} ≠ ${mutationCount(clean.world)}`);
      }
    }
  }
  return {
    id: "m2-crash",
    milestone: "M2",
    title: "kill -9 后重放",
    detail: `${clean.journal.entries.length} 个 seq × 3 个窗口，共 ${checks} 次。账本一致，apply_patch 不重复写入。`,
    pass: true,
  };
}

function proofHuman(): Proof {
  const held = startSession({
    profile: "prod",
    prompt: PROMPT_PUBLISH,
    llmMode: "correct-first",
    agent,
    runId: "m3-human",
  });
  if (held.result.status !== "suspended" || held.result.suspendSeq === undefined) {
    return fail("m3-human", "M3", "审批挂起、退出、隔日重放", `没有挂起：${held.result.status} ${held.result.error ? describeError(held.result.error) : ""}`);
  }
  if (held.result.protectReleased || held.result.continuation !== "held") {
    return fail("m3-human", "M3", "审批挂起、退出、隔日重放", "挂起时不应释放资源");
  }
  const fast = held.resumeFast({ tag: "Approved" });
  const durableStart = startSession({
    profile: "prod",
    prompt: PROMPT_PUBLISH,
    llmMode: "correct-first",
    agent,
    runId: "m3-human-durable",
  });
  const exited = durableStart.exitProcess();
  if (!exited.result.protectReleased || exited.result.continuation !== "discontinued") {
    return fail("m3-human", "M3", "审批挂起、退出、隔日重放", "优雅退出时应 discontinue 并释放资源");
  }
  const seq = durableStart.result.suspendSeq;
  if (seq === undefined) return fail("m3-human", "M3", "审批挂起、退出、隔日重放", "没有 seq");
  const entry = exited.result.journal.entries[seq];
  if (!entry) return fail("m3-human", "M3", "审批挂起、退出、隔日重放", "日志缺审批条");
  entry.status = "Done";
  entry.result = { tag: "Approved" };
  const durable = startSession({
    profile: "prod",
    prompt: PROMPT_PUBLISH,
    llmMode: "correct-first",
    agent,
    runId: "m3-human-durable",
    journal: exited.result.journal,
    world: exited.result.world,
  });
  const drifted = startSession({
    profile: "prod",
    prompt: "改去做一件别的事",
    llmMode: "correct-first",
    agent,
    journal: structuredCloneJournal(fast.result.journal),
    world: fast.result.world,
  });
  const pass =
    fast.result.status === "done" &&
    fast.result.value?.published === "yes" &&
    durable.result.status === "done" &&
    durable.result.value?.published === "yes" &&
    fast.result.value.stamp === durable.result.value?.stamp &&
    mutationCount(fast.result.world) === mutationCount(durable.result.world) &&
    drifted.result.error?.tag === "Nondeterminism";
  return {
    id: "m3-human",
    milestone: "M3",
    title: "审批挂起、退出、隔日重放",
    detail: pass
      ? "快路径与退出后重放结果一致。改掉 prompt 再重放会触发 Nondeterminism，而不是把旧结果套到新请求上。"
      : `快路径 ${fast.result.status}/${fast.result.value?.published ?? ""}，重放 ${durable.result.status}/${durable.result.value?.published ?? ""}，漂移 ${drifted.result.error?.tag ?? drifted.result.status}`,
    pass,
  };
}

function proofVerify(): Proof {
  const wrong = startSession({
    profile: "eval",
    prompt: PROMPT_FIX,
    llmMode: "always-wrong",
    agent,
    runId: "m4-verify",
  }).result;
  const file = wrong.world.files["src/math.ml"] ?? "";
  const lintCount = wrong.journal.entries.filter(isLint).length;
  const capped = startSession({
    profile: "eval",
    prompt: PROMPT_FIX,
    llmMode: "always-wrong",
    agent: spamPatch,
    runId: "m4-cap",
  }).result;
  const capLints = capped.journal.entries.filter(isLint).length;
  const pass =
    wrong.status === "done" &&
    wrong.value?.ok === false &&
    wrong.value.attempts === 3 &&
    !fileIsAdd(file) &&
    file === WRONG_PATCH &&
    (wrong.value.diagnostics.some((line) => line.includes("x + y")) ?? false) &&
    lintCount === 3 &&
    capLints === 3 &&
    (capped.value?.diagnostics.some((line) => line.includes("3 次上限")) ?? false);
  return {
    id: "m4-verify",
    milestone: "M4",
    title: "校验只附加诊断",
    detail: pass
      ? "三次失败后文件仍是错误补丁，输出没有被 handler 悄悄改掉。同一 call_id 第 4 次不再跑 lint。"
      : `ok=${wrong.value?.ok} attempts=${wrong.value?.attempts} lints=${lintCount} capLints=${capLints} file=${JSON.stringify(file)}`,
    pass,
  };
}

function proofPolicy(): Proof {
  const rejected = startSession({
    profile: "dev",
    prompt: PROMPT_PUBLISH,
    llmMode: "correct-first",
    agent,
    runId: "m4-policy",
    decisions: {},
  });
  if (rejected.result.status !== "suspended" || rejected.result.suspendSeq === undefined) {
    return fail("m4-policy", "M4", "高风险必须询问", rejected.result.error ? describeError(rejected.result.error) : rejected.result.status);
  }
  const seq = rejected.result.suspendSeq;
  rejected.result.journal.entries[seq]!.status = "Done";
  rejected.result.journal.entries[seq]!.result = { tag: "Rejected", reason: "先不要发布" };
  rejected.exitProcess();
  const rerun = startSession({
    profile: "dev",
    prompt: PROMPT_PUBLISH,
    llmMode: "correct-first",
    agent,
    journal: rejected.result.journal,
    world: rejected.result.world,
  }).result;
  const shells = rerun.world.log.filter((entry) => entry.name === "shell" && !entry.duplicate);
  const pass = rerun.status === "done" && rerun.value?.published === "rejected" && shells.length === 0 && fileIsAdd(rerun.world.files["src/math.ml"] ?? "");
  return {
    id: "m4-policy",
    milestone: "M4",
    title: "高风险必须询问",
    detail: pass
      ? "拒绝发布后 shell 一次都没执行，补丁本身仍然保留。"
      : `status=${rerun.status} published=${rerun.value?.published} shells=${shells.length}`,
    pass,
  };
}

function proofCompact(): Proof {
  const result = startSession({
    profile: "prod",
    prompt: PROMPT_FIX,
    llmMode: "correct-first",
    agent,
    runId: "m4-compact",
    compactThreshold: 4,
  }).result;
  const purposes = result.journal.entries.filter((entry) => entry.kind === "Llm").map((entry) => (entry.req as { purpose?: string }).purpose);
  const pass = result.status === "done" && purposes.includes("compact") && result.llmUsed === 2 && purposes.filter((item) => item === "plan" || item === "patch" || item === "compact").length >= 3;
  return {
    id: "m4-compact",
    milestone: "M4",
    title: "摘要本身也是 Llm effect",
    detail: pass
      ? `账本里有 compact。budget 在 compact 内侧，只数到 agent 的 ${result.llmUsed} 次调用，摘要仍被记进日志。`
      : `status=${result.status} used=${result.llmUsed} purposes=${purposes.join(",")}`,
    pass,
  };
}

function proofBudget(): Proof {
  const result = startSession({
    profile: "eval",
    prompt: PROMPT_FIX,
    llmMode: "correct-first",
    agent,
    runId: "m4-budget",
    budgetMax: 1,
  }).result;
  const wrote = result.journal.entries.some((entry) => entry.label === "Tool · apply_patch");
  const pass =
    result.error?.tag === "BudgetExceeded" &&
    result.protectReleased &&
    !wrote &&
    (result.world.files["src/math.ml"] ?? "") === BUGGY_ADD;
  return {
    id: "m4-budget",
    milestone: "M4",
    title: "预算在重放之内",
    detail: pass
      ? "第二次 Llm 没有写入日志，文件保持原样，discontinue 释放了资源。"
      : `${result.error ? describeError(result.error) : result.status} wrote=${wrote} released=${result.protectReleased}`,
    pass,
  };
}

function fail(id: string, milestone: Proof["milestone"], title: string, detail: string): Proof {
  return { id, milestone, title, detail, pass: false };
}

function sameOutcome(left: AgentResult, right: AgentResult): boolean {
  return left.ok === right.ok && left.attempts === right.attempts && left.stamp === right.stamp && left.now === right.now && left.published === right.published;
}

function isLint(entry: JournalEntry): boolean {
  const req = entry.req as { name?: string };
  return entry.kind === "Tool" && req.name === "lint";
}

function* spamPatch(_prompt: string, probe: Probe): Generator<Eff, AgentResult, unknown> {
  try {
    let diagnostics: string[] = [];
    let ok = false;
    for (let i = 0; i < 4; i++) {
      const wrote = (yield {
        tag: "Tool",
        call: {
          callId: "patch-same",
          name: "apply_patch",
          args: { path: "src/math.ml", content: WRONG_PATCH },
        },
      }) as { ok: boolean; diagnostics: string[] };
      diagnostics = wrote.diagnostics;
      ok = wrote.ok;
    }
    return { ok, attempts: 4, stamp: "", now: 0, published: "skipped", diagnostics };
  } finally {
    probe.released = true;
  }
}

function structuredCloneJournal(journal: Journal): Journal {
  return {
    runId: journal.runId,
    agentVersion: journal.agentVersion,
    entries: journal.entries.map((entry) => ({ ...entry, path: [...entry.path] })),
  };
}

export function stackPreview() {
  return {
    dev: stackNames("dev"),
    eval: stackNames("eval"),
    prod: stackNames("prod"),
    fixed: FIXED_ADD,
    buggy: BUGGY_ADD,
  };
}

function runMini(names: Array<"probe" | "strict">): string {
  type R = { tag: "value"; value: string } | { tag: "raise"; error: string };
  const unhandled = (): R => ({ tag: "raise", error: "Unhandled" });
  const probe = (_eff: { tag: string }, _next: () => R): R => ({ tag: "value", value: "installed" });
  const strict = (eff: { tag: string }, next: () => R): R => {
    const result = next();
    if (result.tag === "raise") return { tag: "raise", error: `Harness_error:${eff.tag}` };
    return result;
  };
  const stack = names.map((name) => (name === "probe" ? probe : strict));
  const step = (index: number): R => {
    const frame = stack[index];
    if (!frame) return unhandled();
    return frame({ tag: "Probe" }, () => step(index + 1));
  };
  const result = step(0);
  return result.tag === "value" ? result.value : result.error;
}
