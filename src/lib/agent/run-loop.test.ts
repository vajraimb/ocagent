import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { moduleNameFromUrl } from "./harness.ts";
import { HISTORY_SHOWN, MAX_FILE_BYTES, MAX_SEGMENTS, assertedInStep, beyondReach, blindMisses, carriesOn, historyBlock, historyFor, mergeModules, missingInput, parseDeskState, pauseNote, promptContext, readBackInStep, runDeskLoop, type LoopDeps, type RunRecord } from "./run.ts";
import type { CoreJob, CoreResult, RunHooks } from "./ocaml-run.ts";
import { boundOrigin, type AgentEvent, type AgentEventBody } from "./progress.ts";

const block = (text: string) => `${Buffer.byteLength(text)}\n${text}\n`;
const okFrame = (reply: string, text: string, effects = "") => `ok\n${reply}\n${block(text)}${block("")}${block(effects)}0\n`;
const failFrame = (message: string) => `fail\n${block(message)}`;

type Handlers = Parameters<LoopDeps["runCore"]>[1];

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    });
  });

// A stand-in for the OCaml loop: ask the model, run a step, repeat until told to stop.
function fakeCore(modelMs: number) {
  return async (job: CoreJob, handlers: Handlers, hooks?: RunHooks): Promise<CoreResult> => {
    const steps: CoreResult["steps"] = [];
    let rounds = 0;
    while (!hooks?.signal?.aborted && rounds < 50) {
      rounds += 1;
      await sleep(modelMs, hooks?.signal);
      if (hooks?.signal?.aborted) break;
      const reply = await handlers.model("prompt");
      if (reply.startsWith("error")) break;
      await handlers.ocaml(`step\n${block("code")}0\n`);
      steps.push({ tool: "Files.write_file", detail: `src/${rounds}.ml`, output: "Ok" });
    }
    return { status: hooks?.signal?.aborted ? "stopped" : "done", answer: `after ${rounds}`, files: job.files, modules: job.modules, steps, journal: job.journal, memory: job.memory };
  };
}

const realFetch = globalThis.fetch;
before(() => {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ output: [{ type: "message", content: [{ text: "```ocaml\nmodule Step : STEP = struct let run () = Continue \"x\" end\n```" }] }] }), { status: 200 })) as typeof fetch;
});
after(() => {
  globalThis.fetch = realFetch;
});

function deps(overrides: Partial<LoopDeps>, kinds: string[]): LoopDeps {
  return {
    runCore: fakeCore(5),
    runPayload: async () => okFrame("continue", "x", "Files.write_file\tsrc/a.ml\tOk"),
    emit: (event) => kinds.push(event.kind),
    budgetMs: 60_000,
    ...overrides,
  };
}

test("the loop pauses, resumably, when the request's time budget runs out", async () => {
  const kinds: string[] = [];
  const started = Date.now();
  // 23.5 s budget minus the 20 s a round needs: the cut comes after ~3.5 s.
  const result = await runDeskLoop("key", "task", [], ["ocaml"], [], [], "", deps({ runCore: fakeCore(200), budgetMs: 23_500, minRoundMs: 20_000 }, kinds));
  assert.equal(result.ok, true);
  assert.equal(result.paused, true);
  assert.ok(Date.now() - started < 8_000, "cut well before the budget itself");
  assert.match(result.ok ? result.answer : "", /时间用完了/);
  assert.ok(result.steps.length > 0, "work done so far is carried");
});

// A model that answers after `ms`, or rejects with the signal's reason when aborted first.
function slowFetch(ms: number): typeof fetch {
  return ((_input: unknown, init?: RequestInit) =>
    new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(() => resolve(new Response(JSON.stringify({ output: [{ type: "message", content: [{ text: "```ocaml\nmodule Step : STEP = struct let run () = Continue \"x\" end\n```" }] }] }), { status: 200 })), ms);
      init?.signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(init.signal?.reason as unknown);
      });
    })) as typeof fetch;
}

test("a model call in flight when the budget runs out gets the grace to finish; its step runs; the pause comes before the next round", async () => {
  const events: AgentEventBody[] = [];
  const fetchBefore = globalThis.fetch;
  globalThis.fetch = slowFetch(2_000);
  const started = Date.now();
  try {
    const result = await runDeskLoop("key", "task", [], ["ocaml"], [], [], "", {
      runCore: fakeCore(5),
      runPayload: async () => okFrame("continue", "x", "Files.write_file\tsrc/a.ml\tOk"),
      emit: (event) => events.push(event),
      budgetMs: 1_000,
      graceMs: 5_000,
      minRoundMs: 0,
    });
    assert.equal(result.ok && result.paused, true);
    assert.ok(Date.now() - started >= 2_000 && Date.now() - started < 4_500, `took ${Date.now() - started} ms`);
    assert.equal(events.filter((event) => event.kind === "model_error").length, 0, "the round was not cut");
    assert.equal(events.filter((event) => event.kind === "step").length, 1, "the round's step ran");
    assert.equal(events.filter((event) => event.kind === "think").length, 1, "no second round was started");
  } finally {
    globalThis.fetch = fetchBefore;
  }
});

test("a model call that outlives the grace too is cut, said to be the budget's doing, and the next prompt says the round is to be redone", async () => {
  const events: AgentEventBody[] = [];
  const fetchBefore = globalThis.fetch;
  globalThis.fetch = slowFetch(10_000);
  const started = Date.now();
  try {
    const result = await runDeskLoop("key", "task", [], ["ocaml"], [], [], "", {
      runCore: fakeCore(5),
      runPayload: async () => okFrame("continue", "x"),
      emit: (event) => events.push(event),
      budgetMs: 500,
      graceMs: 700,
      minRoundMs: 0,
    });
    assert.equal(result.ok && result.paused, true);
    assert.ok(Date.now() - started < 3_000, `took ${Date.now() - started} ms`);
    const cut = events.find((event) => event.kind === "model_error");
    assert.ok(cut && cut.kind === "model_error" && cut.budget === true, "the cut is marked as the budget's");
    assert.match(cut && cut.kind === "model_error" ? cut.message : "", /这一段时间用完了/);
    assert.equal(result.last?.kind, "model_error");
    assert.match(promptContext({ round: 2, segment: 2, remainingMs: 60_000, files: [], last: result.last ?? null, plan: [], check: null, checkFailed: [], written: [], modules: [] }), /【上一轮没跑完】/);
  } finally {
    globalThis.fetch = fetchBefore;
  }
});

test("four compile failures in a row stop the loop with the last error", async () => {
  const kinds: string[] = [];
  const result = await runDeskLoop("key", "task", [], ["ocaml"], [], [], "", deps({ runPayload: async () => failFrame("Line 3: Unbound value foo") }, kinds));
  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.error, /连续 4 轮.*没编译过/s);
  assert.match(result.ok ? "" : result.error, /Unbound value foo/);
  assert.equal(kinds.filter((kind) => kind === "think").length, 4);
});

test("five rounds that continue without doing anything stop the loop", async () => {
  const kinds: string[] = [];
  const result = await runDeskLoop("key", "task", [], ["ocaml"], [], [], "", deps({ runPayload: async () => okFrame("continue", "just thinking") }, kinds));
  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.error, /连续 5 轮没有做任何事/);
  assert.equal(kinds.filter((kind) => kind === "think").length, 5);
});

test("two runner failures in a row end the run with the runner's message", async () => {
  const kinds: string[] = [];
  const result = await runDeskLoop(
    "key",
    "task",
    [],
    ["ocaml"],
    [],
    [],
    "",
    deps(
      {
        runPayload: async () => {
          throw new Error("这一步的输入没有读全（收到 213 KB，3 个文件后断了）。");
        },
      },
      kinds,
    ),
  );
  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.error, /执行这一步的环境出了问题/);
  assert.match(result.ok ? "" : result.error, /213 KB/);
  assert.equal(kinds.filter((kind) => kind === "runner_failed").length, 2);
  assert.equal(kinds.filter((kind) => kind === "think").length, 2);
});

test("parseDeskState refuses a workspace too big to store, naming the biggest files", () => {
  const base = { harnesses: ["ocaml"], modules: [], journal: [], memory: "" };
  const huge = "x".repeat(MAX_FILE_BYTES + 1);
  const single = parseDeskState({ ...base, files: [{ path: "lib/big.ml", content: huge }] });
  assert.ok("error" in single && /lib\/big\.ml.*单个文件最多/.test(single.error));
  const many = Array.from({ length: 8 }, (_, i) => ({ path: `lib/l${i}.ml`, content: "y".repeat(MAX_FILE_BYTES - 1) }));
  const total = parseDeskState({ ...base, files: many });
  assert.ok("error" in total && /工作区一共.*最大的几个：lib\/l0\.ml/.test(total.error));
  const fine = parseDeskState({ ...base, files: [{ path: "src/a.ml", content: "let a = 1" }], modules: [{ name: "Fib", body: "let fib n = n", source: "https://x.test/fib.ml", at: 1700000000000 }] });
  assert.ok(!("error" in fine) && fine.files.length === 1);
  assert.deepEqual(!("error" in fine) ? fine.modules : [], [{ name: "Fib", body: "let fib n = n", source: "https://x.test/fib.ml", at: 1700000000000 }]);
});

test("a continued segment numbers its rounds after the earlier ones and tells the model so", async () => {
  const kinds: string[] = [];
  const rounds: number[] = [];
  const prompts: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { input: { content: string }[]; reasoning: { effort: string } };
    prompts.push(`${body.reasoning.effort}\n${body.input[0]?.content ?? ""}`);
    return new Response(JSON.stringify({ output: [{ type: "message", content: [{ text: "```ocaml\nmodule Step : STEP = struct let run () = Continue \"x\" end\n```" }] }] }), { status: 200 });
  }) as typeof fetch;
  try {
    let calls = 0;
    const result = await runDeskLoop(
      "key",
      "task",
      [{ path: "notes/a.md", content: "hello" }],
      ["ocaml", "files"],
      [],
      [],
      "",
      deps(
        {
          runCore: async (job, handlers) => {
            for (let i = 0; i < 3; i += 1) {
              await handlers.model("prompt");
              await handlers.ocaml(`step\n${block("code")}0\n`);
            }
            return { status: "done", answer: "ok", files: job.files, modules: job.modules, steps: [], journal: [], memory: "" };
          },
          runPayload: async () => {
            calls += 1;
            if (calls === 1) return failFrame("Line 2: Unbound value foo");
            return `ok\ncontinue\n${block("x")}${block("")}${block("Files.read_file\tnotes/a.md\tOk hello")}1\nnotes/b.md\n${block("written")}`;
          },
          emit: (event) => {
            kinds.push(event.kind);
            if ("round" in event && event.kind === "think") rounds.push(event.round);
          },
          roundBase: 4,
          segment: 2,
        },
        kinds,
      ),
    );
    assert.equal(result.ok, true);
    assert.deepEqual(rounds, [5, 6, 7]);
    // Round 5's prompt: fresh segment, the workspace listed.
    assert.match(prompts[0] ?? "", /^low\n/);
    assert.match(prompts[0] ?? "", /第 5 轮/);
    assert.match(prompts[0] ?? "", /第 2\/10 段/);
    assert.match(prompts[0] ?? "", /notes\/a\.md（5 B）/);
    // Round 6 follows a compile failure: the error and the failed code ride along, with more care.
    assert.match(prompts[1] ?? "", /^medium\n/);
    assert.match(prompts[1] ?? "", /编译失败[\s\S]*Unbound value foo[\s\S]*module Step/);
    // Round 7 follows a step that ran: its returns and the files it left are listed.
    assert.match(prompts[2] ?? "", /^low\n/);
    assert.match(prompts[2] ?? "", /第 6 轮）执行了，返回 continue/);
    assert.match(prompts[2] ?? "", /Files\.read_file notes\/a\.md → Ok hello/);
    assert.match(prompts[2] ?? "", /notes\/b\.md（7 B）/);
    assert.doesNotMatch(prompts[2] ?? "", /notes\/a\.md（5 B）/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("the real loop script: a held Done goes round again, and the step after it ends the run with the model's own answer", async () => {
  const { runCore } = await import("./ocaml-run.ts");
  const prompts: string[] = [];
  let step = 0;
  const result = await runCore(
    { task: "把它装成 harness，然后调用一次给我看", harnesses: ["ocaml", "files"], files: [{ path: "greet.ml", content: "let hello n = \"Hello, \" ^ n" }], modules: [{ name: "Timer", body: "let t = 1" }], journal: [], memory: "" },
    {
      model: async (prompt) => {
        prompts.push(prompt);
        return `text\n${block(`\`\`\`ocaml\nmodule Step = struct let run () = Done "step ${prompts.length}" end\n\`\`\``)}`;
      },
      ocaml: async (payload) => {
        step += 1;
        assert.match(payload, /^step\n/);
        // Round 1: the step wrote a .ml and said Done; the Node side holds that
        // Done for a check (hands back Continue). Round 2: the check ran.
        if (step === 1) return `ok\ncontinue\n${block("已装成 harness 并调用 Greet.hello()")}${block("")}${block("Files.write_file\tgreet.ml\tOk\nHarness.install\tgreet.ml\tOk")}1\ngreet.ml\n${block("let hello n = n")}`;
        return okFrame("done", "已装成 harness 并调用 Greet.hello()：打印 Hello, Michael!", "Files.read_file\tgreet.ml\tOk let hello n = n");
      },
    },
  );
  assert.equal(result.status, "done");
  // No "已写下 …" stub, no trailing "没有加载成 harness。": the answer is the step's.
  assert.equal(result.answer, "已装成 harness 并调用 Greet.hello()：打印 Hello, Michael!");
  assert.equal(prompts.length, 2);
  assert.equal(step, 2);
  // Modules pass through untouched; the loop no longer installs anything itself.
  assert.deepEqual(result.modules.map((mod) => mod.name), ["Timer"]);
  assert.deepEqual(result.steps.map((item) => item.tool), ["Files.write_file", "Harness.install", "Files.read_file"]);
  assert.ok(result.journal.some((item) => item.kind === "answer"));
});

test("the real loop script ends on its own only when the same step repeats or the model stops producing code", async () => {
  const { runCore } = await import("./ocaml-run.ts");
  const same = await runCore(
    { task: "t", harnesses: ["ocaml"], files: [], modules: [], journal: [], memory: "" },
    {
      model: async () => `text\n${block("```ocaml\nmodule Step = struct let run () = Continue \"x\" end\n```")}`,
      ocaml: async () => okFrame("continue", "x"),
    },
  );
  assert.equal(same.status, "done");
  assert.equal(same.answer, "同一步重复了，没有新进展。");
  let asked = 0;
  const noCode = await runCore(
    { task: "t", harnesses: ["ocaml"], files: [], modules: [], journal: [], memory: "" },
    {
      model: async () => {
        asked += 1;
        return `text\n${block("只是文字，没有代码")}`;
      },
      ocaml: async () => okFrame("continue", "x"),
    },
  );
  assert.equal(noCode.answer, "没有拿到可执行的 OCaml。");
  assert.equal(asked, 3);
  const modelDown = await runCore(
    { task: "t", harnesses: ["ocaml"], files: [], modules: [], journal: [], memory: "" },
    { model: async () => `error\n${block("模型没有接上（503）。")}`, ocaml: async () => okFrame("continue", "x") },
  );
  assert.equal(modelDown.status, "done");
  assert.equal(modelDown.answer, "模型没有接上（503）。");
});

test("a busy model endpoint is asked again before the round is given up", async () => {
  const realFetch = globalThis.fetch;
  const statuses = [429, 503, 200, 400];
  let calls = 0;
  globalThis.fetch = (async () => {
    const status = statuses[calls] ?? 200;
    calls += 1;
    if (status !== 200) return new Response("busy", { status });
    return new Response(JSON.stringify({ output: [{ type: "message", content: [{ text: "```ocaml\nmodule Step : STEP = struct let run () = Done \"x\" end\n```" }] }] }), { status: 200 });
  }) as typeof fetch;
  const kinds: string[] = [];
  const replies: string[] = [];
  try {
    const started = Date.now();
    await runDeskLoop(
      "key",
      "task",
      [],
      ["ocaml"],
      [],
      [],
      "",
      deps(
        {
          runCore: async (job, handlers) => {
            replies.push(await handlers.model("prompt"));
            replies.push(await handlers.model("prompt"));
            return { status: "done", answer: "ok", files: job.files, modules: job.modules, steps: [], journal: [], memory: "" };
          },
        },
        kinds,
      ),
    );
    // 429 and 503 were retried (two pauses), 200 answered; the 400 was not retried.
    assert.equal(calls, 4);
    assert.ok(Date.now() - started >= 3_500);
    assert.match(replies[0] ?? "", /^text\n/);
    assert.match(replies[1] ?? "", /^error\n[\s\S]*模型没有接上（400）/);
    assert.equal(kinds.filter((kind) => kind === "model_error").length, 1);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("promptContext stays bounded and names what the model needs", () => {
  const files = Array.from({ length: 80 }, (_, i) => ({ path: `src/f${i}.ml`, bytes: 2048 * (i + 1) }));
  const effects = Array.from({ length: 20 }, (_, i) => ({ tool: "Files.read_file", detail: `src/f${i}.ml`, output: "x".repeat(5000) }));
  const text = promptContext({ round: 3, segment: 1, remainingMs: 41_400, files, last: { kind: "ran", round: 2, reply: "continue", text: "", effects } });
  assert.ok(text.length <= 20_100, `context is ${text.length} chars`);
  assert.match(text, /共 80 个文件/);
  assert.match(text, /还有 6 次调用/);
  assert.match(text, /还剩约 41 秒/);
  assert.doesNotMatch(text, /第 1 段|第 1 段/);
});

test("moduleNameFromUrl derives a module name from the file at the end of a URL", () => {
  assert.equal(moduleNameFromUrl("https://raw.githubusercontent.com/ocaml/ocaml/trunk/stdlib/option.ml"), "Option");
  assert.equal(moduleNameFromUrl("https://x.test/lib/pdf-gen.ml?raw=1"), "Pdf_gen");
  assert.equal(moduleNameFromUrl("https://x.test/"), null);
});

test("a module unloaded by a step leaves the carried set; dropped modules are announced", async () => {
  const kinds: string[] = [];
  const mods = [
    { name: "A", body: "let a = 1" },
    { name: "B", body: "let b = 2" },
  ];
  const result = await runDeskLoop(
    "key",
    "task",
    [],
    ["ocaml"],
    mods,
    [],
    "",
    deps(
      {
        runCore: async (job, handlers) => {
          await handlers.model("p");
          await handlers.ocaml(`step\n${block("code")}0\n`);
          return { status: "done", answer: "ok", files: [], modules: job.modules, steps: [], journal: [], memory: "" };
        },
        runPayload: async (_payload, _harnesses, _key, hooks) => {
          hooks?.onUnload?.("A");
          return okFrame("done", "ok", "Harness.unload\tA\tOk 已卸下 module A。");
        },
        dropped: [{ name: "C", error: "module C 编译失败" }],
      },
      kinds,
    ),
  );
  assert.deepEqual(
    result.modules.map((mod) => mod.name),
    ["B"],
  );
  assert.ok(kinds.includes("module_dropped"));
});

test("mergeModules keeps verified loads, honours unloads", () => {
  const merged = mergeModules([{ name: "A", body: "old" }, { name: "B", body: "b" }], [{ name: "A", body: "new" }], ["B"]);
  assert.deepEqual(merged, [{ name: "A", body: "new" }]);
});

// A loop stand-in that honours the frame's reply: Done ends it, Continue asks again.
function replyAwareCore(frames: string[], prompts: string[] = []) {
  return async (job: CoreJob, handlers: Handlers): Promise<CoreResult> => {
    let rounds = 0;
    let answer = "";
    while (rounds < frames.length + 2) {
      rounds += 1;
      const reply = await handlers.model("prompt");
      if (reply.startsWith("error")) break;
      prompts.push(reply);
      const raw = await handlers.ocaml(`step\n${block("code")}0\n`);
      const kind = raw.split("\n")[1];
      answer = raw;
      if (kind === "done" || kind === "partial" || kind === "ask") break;
    }
    return { status: "done", answer, files: job.files, modules: job.modules, steps: [], journal: job.journal, memory: job.memory };
  };
}

test("Plan.set / Plan.tick become a checklist the next prompt sees, carried in the result", async () => {
  const events: AgentEventBody[] = [];
  const contexts: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    contexts.push(JSON.parse(String(init?.body)).input[0].content as string);
    return new Response(JSON.stringify({ output: [{ type: "message", content: [{ text: "```ocaml\nx\n```" }] }] }), { status: 200 });
  }) as typeof fetch;
  const frames = [
    okFrame("continue", "planned", `Plan.set\t\t写 a.ml\u001f写 b.ml\u001f核对\nFiles.write_file\ta.ml\tOk\nPlan.tick\t1\ta.ml 12 行`),
    okFrame("continue", "b", "Files.write_file\tb.ml\tOk\nPlan.tick\t2\tb.ml 写好"),
    okFrame("done", "全部写好", "Files.read_file\ta.ml\tOk let x = 1\nPlan.tick\t3\t核对过"),
    okFrame("done", "全部写好", ""),
  ];
  let i = 0;
  try {
    const result = await runDeskLoop("key", "task", [], ["ocaml", "files"], [], [], "", {
      runCore: replyAwareCore(frames),
      runPayload: async () => frames[i++] ?? okFrame("done", "x"),
      emit: (event) => events.push(event),
      budgetMs: 60_000,
    });
    assert.equal(result.ok, true);
    assert.deepEqual(
      result.plan.items.map((item) => [item.text, item.done]),
      [
        ["写 a.ml", true],
        ["写 b.ml", true],
        ["核对", true],
      ],
    );
    assert.equal(result.plan.items[0]?.note, "a.ml 12 行");
    const todos = events.filter((event) => event.kind === "todo");
    assert.equal(todos.length, 3);
    // Plan effects are not shown as calls; the writes still are.
    assert.ok(!events.some((event) => event.kind === "effect" && event.tool.startsWith("Plan.")));
    assert.ok(events.some((event) => event.kind === "effect" && event.tool === "Files.write_file"));
    assert.match(contexts[1] ?? "", /【计划 1\/3】[\s\S]*\[x\] 1\. 写 a\.ml — a\.ml 12 行[\s\S]*\[ \] 2\. 写 b\.ml/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("the first Done of a run that wrote files is held for one check round, the second goes through", async () => {
  const events: AgentEventBody[] = [];
  const contexts: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    contexts.push(JSON.parse(String(init?.body)).input[0].content as string);
    return new Response(JSON.stringify({ output: [{ type: "message", content: [{ text: "```ocaml\nx\n```" }] }] }), { status: 200 });
  }) as typeof fetch;
  const frames = [okFrame("done", "写好了 a.ml", "Files.write_file\ta.ml\tOk"), okFrame("done", "核对过，a.ml 没问题", "Files.read_file\ta.ml\tOk let x = 1")];
  let i = 0;
  try {
    const result = await runDeskLoop("key", "task", [], ["ocaml", "files"], [], [], "", {
      runCore: replyAwareCore(frames),
      runPayload: async () => frames[i++] ?? okFrame("done", "x"),
      emit: (event) => events.push(event),
      budgetMs: 60_000,
    });
    assert.equal(result.ok, true);
    assert.equal(i, 2, "two steps ran: the held Done, then the check");
    const check = events.find((event) => event.kind === "check");
    assert.ok(check && check.kind === "check" && check.answer === "写好了 a.ml");
    const steps = events.filter((event) => event.kind === "step");
    assert.deepEqual(
      steps.map((event) => (event.kind === "step" ? event.reply : "")),
      ["continue", "done"],
    );
    assert.match(contexts[1] ?? "", /【收尾前核对】你上一步想用这个答案结束：「写好了 a\.ml」/);
    assert.equal(result.plan.checks, 1);
    assert.equal(result.plan.pending, null);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a step that reads back what it wrote is not held: it already checked", async () => {
  const events: AgentEventBody[] = [];
  const frames = [okFrame("done", "改好了 todo.md", "Files.replace\ttodo.md\tOk 替换了 1 处\nFiles.append\ttodo.md\tOk\nFiles.read_file\ttodo.md\tOk 买豆奶\n交电费\n预约牙医")];
  let i = 0;
  const result = await runDeskLoop("key", "task", [], ["ocaml", "files"], [], [], "", {
    runCore: replyAwareCore(frames),
    runPayload: async () => frames[i++] ?? okFrame("done", "x"),
    emit: (event) => events.push(event),
    budgetMs: 60_000,
  });
  assert.equal(result.ok, true);
  assert.equal(i, 1, "one step: the Done went straight through");
  assert.equal(events.some((event) => event.kind === "check"), false);
  assert.equal(result.plan.checks, 0);
  // Reading back in a later round counts too; a write with no read-back does not.
  const written = new Set(["a.md"]);
  assert.equal(readBackInStep([{ tool: "Files.read_file", detail: "a.md", output: "Ok hi" }], written), true);
  assert.equal(readBackInStep([{ tool: "Files.read_file", detail: "b.md", output: "Ok hi" }], written), false);
  assert.equal(readBackInStep([{ tool: "Files.read_file", detail: "a.md", output: "Ok hi" }, { tool: "Files.append", detail: "a.md", output: "Ok" }], written), false);
  assert.equal(readBackInStep([{ tool: "Files.write_file", detail: "c.md", output: "Ok" }, { tool: "Files.read_file", detail: "c.md", output: "Error 没有" }], new Set(["c.md"])), false);
});

test("a run that only looked things up is not held for a check", async () => {
  const events: AgentEventBody[] = [];
  const frames = [okFrame("done", "东京 18°C", "Trace.note\t\t已查")];
  let i = 0;
  const result = await runDeskLoop("key", "task", [], ["ocaml", "web"], [], [], "", {
    runCore: replyAwareCore(frames),
    runPayload: async () => frames[i++] ?? okFrame("done", "x"),
    emit: (event) => events.push(event),
    budgetMs: 60_000,
  });
  assert.equal(result.ok, true);
  assert.equal(i, 1);
  assert.ok(!events.some((event) => event.kind === "check"));
  assert.equal(result.plan.checks, 0);
});

test("a continued segment inherits the plan and does not check twice", async () => {
  const events: AgentEventBody[] = [];
  const frames = [okFrame("done", "补完了", "Files.write_file\tb.ml\tOk\nPlan.tick\t2\tb.ml")];
  let i = 0;
  const result = await runDeskLoop("key", "task", [], ["ocaml", "files"], [], [], "", {
    runCore: replyAwareCore(frames),
    runPayload: async () => frames[i++] ?? okFrame("done", "x"),
    emit: (event) => events.push(event),
    budgetMs: 60_000,
    roundBase: 3,
    segment: 2,
    plan: { items: [{ text: "写 a.ml", done: true, note: "" }, { text: "写 b.ml", done: false, note: "" }], checks: 1, wrote: true, pending: null, failed: [], written: [], origin: {} },
  });
  assert.equal(result.ok, true);
  assert.equal(i, 1, "the Done went straight through");
  assert.ok(!events.some((event) => event.kind === "check"));
  assert.deepEqual(result.plan.items.map((item) => item.done), [true, true]);
});

test("pictures in the desk ride along with every model call, and a refusal falls back to text", async () => {
  const bodies: { content: unknown }[] = [];
  const realFetch = globalThis.fetch;
  let refusals = 0;
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { input: { content: unknown }[] };
    bodies.push(body.input[0]!);
    const hasImage = Array.isArray(body.input[0]!.content);
    if (hasImage && refusals === 0) {
      refusals += 1;
      return new Response("{}", { status: 400 });
    }
    return new Response(JSON.stringify({ output: [{ type: "message", content: [{ text: "```ocaml\nx\n```" }] }] }), { status: 200 });
  }) as typeof fetch;
  const picture = { path: "images/cat.jpg", content: `data:image/jpeg;base64,${"A".repeat(400)}` };
  const frames = [okFrame("done", "是一只猫", "")];
  let i = 0;
  try {
    const result = await runDeskLoop("key", "照片里是什么", [picture, { path: "notes.md", content: "x" }], ["ocaml", "files"], [], [], "", {
      runCore: replyAwareCore(frames),
      runPayload: async () => frames[i++] ?? okFrame("done", "x"),
      emit: () => {},
      budgetMs: 60_000,
    });
    assert.equal(result.ok, true);
    // First attempt carried the picture as an input_image part…
    const first = bodies[0]!.content as { type: string; image_url?: string; text?: string }[];
    assert.ok(Array.isArray(first));
    assert.equal(first[0]?.type, "input_text");
    assert.match(first[0]?.text ?? "", /【图片】下面 1 张图片已经附在这条提示里[\s\S]*images\/cat\.jpg/);
    assert.match(first[0]?.text ?? "", /images\/cat\.jpg（图片，300 B）/);
    assert.equal(first[1]?.type, "input_image");
    assert.equal(first[1]?.image_url, picture.content);
    // …and after the 400 the same round was retried as plain text.
    assert.equal(bodies.length, 2);
    assert.equal(typeof bodies[1]!.content, "string");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("after a vision refusal the next round tells the model it cannot see the pictures", async () => {
  const texts: string[] = [];
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { input: { content: unknown }[] };
    calls += 1;
    if (Array.isArray(body.input[0]!.content)) return new Response("{}", { status: 400 });
    texts.push(body.input[0]!.content as string);
    return new Response(JSON.stringify({ output: [{ type: "message", content: [{ text: "```ocaml\nx\n```" }] }] }), { status: 200 });
  }) as typeof fetch;
  const picture = { path: "images/cat.jpg", content: `data:image/jpeg;base64,${"A".repeat(40)}` };
  // The step's frame lists the workspace it left, picture included.
  const withPicture = (reply: string, text: string, effects: string) => `ok\n${reply}\n${block(text)}${block("")}${block(effects)}1\n${picture.path}\n${block(picture.content)}`;
  const frames = [withPicture("continue", "看看", "Trace.note\t\t想看图"), withPicture("done", "看不到图", "")];
  let i = 0;
  try {
    await runDeskLoop("key", "照片里是什么", [picture], ["ocaml", "files"], [], [], "", {
      runCore: replyAwareCore(frames),
      runPayload: async () => frames[i++] ?? okFrame("done", "x"),
      emit: () => {},
      budgetMs: 60_000,
    });
    assert.equal(calls, 3, "one refused attempt, then text-only rounds without retrying pictures");
    assert.match(texts[1] ?? "", /模型接口没有接受图片，你看不到它们的内容/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("earlier exchanges in the desk are shown to the model, and a pending Ask is marked as answered", async () => {
  const texts: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { input: { content: string }[] };
    texts.push(body.input[0]!.content);
    return new Response(JSON.stringify({ output: [{ type: "message", content: [{ text: "```ocaml\nx\n```" }] }] }), { status: 200 });
  }) as typeof fetch;
  const frames = [okFrame("done", "好的，叫 notes.md")];
  let i = 0;
  try {
    await runDeskLoop("key", "就叫 notes 吧", [], ["ocaml", "files"], [], [], "", {
      runCore: replyAwareCore(frames),
      runPayload: async () => frames[i++] ?? okFrame("done", "x"),
      emit: () => {},
      budgetMs: 60_000,
      history: [
        { task: "查一下东京天气", answer: "东京今天大约 18–24°C，多云。", status: "done" },
        { task: "把结果写成文件", answer: "文件叫什么名字？", status: "done", asked: true },
      ],
    });
    const prompt = texts[0] ?? "";
    assert.match(prompt, /【之前的对话】/);
    assert.match(prompt, /用户：查一下东京天气\n你答：东京今天大约 18–24°C，多云。/);
    assert.match(prompt, /你问：文件叫什么名字？/);
    assert.match(prompt, /用户这次说的话就是回答/);
    // The conversation comes before the workspace listing, as it reads in order.
    assert.ok(prompt.indexOf("【之前的对话】") < prompt.indexOf("【工作区现在有】"));
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("historyFor leaves out the current run, running runs and runs without a result; keeps the newest", () => {
  const run = (id: string, status: "done" | "running" | "failed", answer: string | null): RunRecord =>
    ({ id, deskId: "desk-x", task: `t-${id}`, trigger: "user", status, segment: 1, rounds: 1, events: [], result: answer === null ? null : { ok: true, answer, steps: [], touched: [] }, stopRequested: false, createdAt: 0, updatedAt: 0, endedAt: null }) as RunRecord;
  const runs = [run("a", "done", "A"), run("b", "failed", "B"), run("c", "done", null), run("d", "running", "D"), run("me", "done", "ME")];
  const history = historyFor(runs, "me");
  assert.deepEqual(history.map((item) => item.task), ["t-a", "t-b"]);
  assert.equal(history[1]?.status, "failed");
  const many = Array.from({ length: 10 }, (_, n) => run(`r${n}`, "done", `${n}`));
  assert.equal(historyFor(many, "none").length, HISTORY_SHOWN);
  assert.equal(historyFor(many, "none")[0]?.task, "t-r4");
  assert.equal(historyBlock([]), "");
});

test("Memory.remember adds to the desk's notes: shown to the model next round, in the timeline, carried in the result", async () => {
  const texts: string[] = [];
  const kinds: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { input: { content: string }[] };
    texts.push(body.input[0]!.content);
    return new Response(JSON.stringify({ output: [{ type: "message", content: [{ text: "```ocaml\nx\n```" }] }] }), { status: 200 });
  }) as typeof fetch;
  const frames = [okFrame("continue", "记下了", "Memory.remember\t\t用户偏好摄氏\nMemory.forget\t1\t"), okFrame("done", "好")];
  let i = 0;
  const events: AgentEventBody[] = [];
  try {
    const result = await runDeskLoop("key", "以后都用摄氏", [], ["ocaml", "files"], [], [], "", {
      runCore: replyAwareCore(frames),
      runPayload: async () => frames[i++] ?? okFrame("done", "x"),
      emit: (event) => {
        kinds.push(event.kind);
        events.push(event);
      },
      budgetMs: 60_000,
      notes: ["用户在东京"],
    });
    assert.match(texts[0] ?? "", /【记住的】[^\n]*\n1\. 用户在东京/);
    assert.match(texts[1] ?? "", /【记住的】[^\n]*\n1\. 用户偏好摄氏\n/);
    assert.doesNotMatch(texts[1] ?? "", /用户在东京/);
    const remembered = events.filter((event) => event.kind === "remember");
    assert.deepEqual(remembered.map((event) => (event.kind === "remember" ? [event.text, event.forgot] : null)), [["用户偏好摄氏", false], ["用户在东京", true]]);
    // Memory effects are bookkeeping, not visible calls.
    assert.ok(!events.some((event) => event.kind === "effect" && event.tool.startsWith("Memory.")));
    assert.deepEqual(result.notes, ["用户偏好摄氏"]);
  } finally {
    globalThis.fetch = realFetch;
  }
});

// A frame whose step wrote files, with their contents, so the run can look at them.
const okFrameWithFiles = (reply: string, text: string, effects: string, files: { path: string; content: string }[]) =>
  `ok\n${reply}\n${block(text)}${block("")}${block(effects)}${files.length}\n${files.map((file) => `${file.path}\n${block(file.content)}`).join("")}`;

function capturing(contexts: string[]) {
  return (async (_url: unknown, init?: RequestInit) => {
    contexts.push(JSON.parse(String(init?.body)).input[0].content as string);
    return new Response(JSON.stringify({ output: [{ type: "message", content: [{ text: "```ocaml\nx\n```" }] }] }), { status: 200 });
  }) as typeof fetch;
}

test("a Done backed by passing assertions goes straight through; the check prompt asks for assertions and names the files written", async () => {
  const events: AgentEventBody[] = [];
  const contexts: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = capturing(contexts);
  try {
    // Assertions in the Done step itself: no check round.
    const asserted = [okFrame("done", "写好了", "Files.write_file\ta.ml\tOk\nCheck.contains\ta.ml 含 let x\t通过\nCheck.that\t有两行\t通过")];
    let i = 0;
    const result = await runDeskLoop("key", "task", [], ["ocaml", "files"], [], [], "", {
      runCore: replyAwareCore(asserted),
      runPayload: async () => asserted[i++] ?? okFrame("done", "x"),
      emit: (event) => events.push(event),
      budgetMs: 60_000,
    });
    assert.equal(result.ok, true);
    assert.equal(i, 1);
    assert.ok(!events.some((event) => event.kind === "check"));
    assert.ok(assertedInStep([{ tool: "Check.that", detail: "d", output: "通过" }]));
    assert.ok(!assertedInStep([{ tool: "Check.that", detail: "d", output: "通过" }, { tool: "Check.equal", detail: "e", output: "没通过：期望 1，实际 2" }]));
    assert.ok(!assertedInStep([{ tool: "Files.read_file", detail: "a", output: "Ok" }]));
    // No assertion and no read-back: held, and the check prompt lists what to assert about.
    contexts.length = 0;
    const plain = [okFrame("done", "写好了 b.ml", "Files.write_file\tb.ml\tOk"), okFrame("done", "核对过", "Check.contains\tb.ml 含 let y\t通过")];
    let j = 0;
    const held = await runDeskLoop("key", "task", [], ["ocaml", "files"], [{ name: "Fib", body: "let fib n = n" }], [], "", {
      runCore: replyAwareCore(plain),
      runPayload: async () => plain[j++] ?? okFrame("done", "x"),
      emit: () => {},
      budgetMs: 60_000,
    });
    assert.equal(held.ok, true);
    assert.equal(j, 2);
    assert.match(contexts[1] ?? "", /【收尾前核对】[\s\S]*Check\.contains[\s\S]*这次任务写过的文件：b\.ml[\s\S]*装着的 module：Fib/);
    assert.deepEqual(held.plan.written, ["b.ml"]);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a Done with a failing assertion is sent back to fix it, at most twice; after that the answer says what failed", async () => {
  const events: AgentEventBody[] = [];
  const contexts: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = capturing(contexts);
  const failing = "Files.write_file\tc.md\tOk\nCheck.contains\tc.md 含 第二节\t没通过：文件里没有这段";
  const frames = [okFrame("done", "写好了 c.md", failing), okFrame("done", "还是写好了", failing), okFrame("done", "我说写好了", failing)];
  let i = 0;
  try {
    const result = await runDeskLoop("key", "task", [], ["ocaml", "files"], [], [], "", {
      runCore: replyAwareCore(frames),
      runPayload: async () => frames[i++] ?? okFrame("done", "x"),
      emit: (event) => events.push(event),
      budgetMs: 60_000,
    });
    assert.equal(i, 3, "held twice, the third Done went through");
    const checks = events.filter((event) => event.kind === "check");
    assert.equal(checks.length, 2);
    assert.deepEqual(checks[0]?.kind === "check" ? checks[0].failed : [], ["c.md 含 第二节"]);
    assert.match(contexts[1] ?? "", /【核对没通过，不能这样结束】[\s\S]*「c\.md 含 第二节」[\s\S]*Files\.restore/);
    assert.match(contexts[2] ?? "", /【核对没通过，不能这样结束】/);
    const steps = events.filter((event) => event.kind === "step");
    assert.deepEqual(steps.map((event) => (event.kind === "step" ? event.reply : "")), ["continue", "continue", "done"]);
    const last = steps[steps.length - 1];
    assert.match(last?.kind === "step" ? last.text : "", /我说写好了\n\n（有 1 条核对没通过：c\.md 含 第二节）/);
    assert.equal(result.plan.checks, 2);
    // A failing assertion in a Continue step gets a retreat hint next round.
    contexts.length = 0;
    const retreat = [okFrame("continue", "改了一半", "Files.replace\td.md\tOk 替换了 1 处\nCheck.contains\td.md 含 标题\t没通过：文件里没有这段"), okFrame("done", "好", "Check.contains\td.md 含 标题\t通过")];
    let j = 0;
    await runDeskLoop("key", "task", [], ["ocaml", "files"], [], [], "", {
      runCore: replyAwareCore(retreat),
      runPayload: async () => retreat[j++] ?? okFrame("done", "x"),
      emit: () => {},
      budgetMs: 60_000,
    });
    assert.match(contexts[1] ?? "", /有 1 条断言没通过[\s\S]*Files\.restore 退回那个文件重做/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a Partial that gives up on a Check.contains miss without reading the file is sent to look first", async () => {
  const events: AgentEventBody[] = [];
  const contexts: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = capturing(contexts);
  const miss = "Check.contains\tweather/beijing.md 含 Beijing\t没通过：文件里没有这段；文件里实际是：北京：20.9°C";
  const frames = [
    okFrame("partial", "城市文件里没有英文名", `Files.write_file\tweather/beijing.md\tOk\n${miss}`),
    okFrame("done", "文件里是中文名，断言改过后都通过", "Check.contains\tweather/beijing.md 含 北京\t通过"),
  ];
  let i = 0;
  try {
    await runDeskLoop("key", "task", [], ["ocaml", "files"], [], [], "", {
      runCore: replyAwareCore(frames),
      runPayload: async () => frames[i++] ?? okFrame("done", "x"),
      emit: (event) => events.push(event),
      budgetMs: 60_000,
    });
    assert.equal(i, 2, "the Partial was held and the loop went on");
    const check = events.find((event) => event.kind === "check");
    assert.ok(check && check.kind === "check" && check.gaveUp === true && check.failed[0] === "weather/beijing.md 含 Beijing");
    assert.match(contexts[1] ?? "", /【核对没通过，不能这样结束】[\s\S]*文件里实际的内容[\s\S]*改断言/);
    assert.match(contexts[1] ?? "", /北京：20\.9°C/, "the prompt shows what the file holds");
    const steps = events.filter((event) => event.kind === "step");
    assert.deepEqual(steps.map((event) => (event.kind === "step" ? event.reply : "")), ["continue", "done"]);
    // A Partial with an honest, looked-into failure is not held.
    const honest = [okFrame("partial", "文件看过了，确实缺第二节", "Files.read_file\tc.md\tOk 第一节\nCheck.contains\tc.md 含 第二节\t没通过：文件里没有这段；文件里实际是：第一节\nCheck.that\t拿到温度\t没通过")];
    let k = 0;
    const replies: string[] = [];
    await runDeskLoop("key", "task", [], ["ocaml", "files"], [], [], "", {
      runCore: replyAwareCore(honest),
      runPayload: async () => honest[k++] ?? okFrame("done", "x"),
      emit: (event) => { if (event.kind === "step") replies.push(event.reply); },
      budgetMs: 60_000,
    });
    assert.deepEqual(replies, ["partial"]);
  } finally {
    globalThis.fetch = realFetch;
  }
  // Only misses on files the step never read count as blind; a missing file or a Check.that does not.
  const effects = (lines: string) => lines.split("\n").map((line) => { const [tool = "", detail = "", output = ""] = line.split("\t"); return { tool, detail, output }; });
  assert.deepEqual(blindMisses(effects(miss)), ["weather/beijing.md 含 Beijing"]);
  assert.deepEqual(blindMisses(effects(`Files.read_file\tweather/beijing.md\tOk 北京\n${miss}`)), []);
  assert.deepEqual(blindMisses(effects("Check.contains\tnone.md 含 x\t没通过：没有这个文件\nCheck.that\t两行\t没通过")), []);
});

test("a Done on a task that asks for a schedule without registering one, or needs a reminder or a message, becomes a Partial that says so", async () => {
  // The pure judgement: a schedule asked for and not registered; reminders, background jobs, messages.
  assert.equal(beyondReach("定时北京时间每天早上8点把这5个城市天气预报汇总", "done")?.what, "定时（没有用 Schedule.daily 登记）");
  assert.equal(beyondReach("每天帮我查一次汇率", "done")?.what, "定时（没有用 Schedule.daily 登记）");
  assert.equal(beyondReach("每天帮我查一次汇率", "done", true), null, "registered: nothing is beyond reach");
  assert.equal(beyondReach("过十分钟提醒我开会", "done")?.what, "过一会儿提醒");
  assert.equal(beyondReach("后台一直盯着这个页面有没有更新", "done")?.what, "后台一直运行");
  assert.equal(beyondReach("把结果发邮件给我", "done")?.what, "发邮件或短信");
  assert.equal(beyondReach("把结果发邮件给我", "done", { notify: "sent" })?.what, "发邮件或短信", "a notify address is not email");
  assert.equal(beyondReach("查完汇率发消息通知我", "done")?.what, "发消息");
  assert.equal(beyondReach("查完汇率发消息通知我", "done", { notify: "unused" })?.what, "发消息（没有用 Notify.send 发出去）");
  assert.match(beyondReach("查完汇率发消息通知我", "done", { notify: "none" })?.note ?? "", /面板「通知」/);
  assert.equal(beyondReach("查完汇率发消息通知我", "done", { notify: "sent" }), null, "sent through the desk's address: the Done stands");
  assert.equal(beyondReach("每天早上提醒我喝水", "done", { scheduled: true }), null, "a registered daily schedule is the reminder");
  assert.equal(beyondReach("写一首关于每天早起的诗", "done"), null, "no schedule asked for");
  assert.equal(beyondReach("每天的天气都不一样，查一下今天的", "done"), null);
  assert.equal(beyondReach("定时北京时间每天早上8点汇总", "partial"), null, "a Partial already says it is not done");
  // In the loop: the Done that writes a "scheduler script" instead of registering turns into a Partial with the note.
  const events: AgentEventBody[] = [];
  const contexts: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = capturing(contexts);
  const frames = [
    okFrame("done", "已写下 run_daily.ml 和调度说明。", "Files.write_file\trun_daily.ml\tOk\nCheck.contains\trun_daily.ml 含 08:00\t通过"),
  ];
  let i = 0;
  try {
    const result = await runDeskLoop("key", "定时北京时间每天早上8点把这5个城市天气预报汇总", [], ["ocaml", "files"], [], [], "", {
      runCore: replyAwareCore(frames),
      runPayload: async () => frames[i++] ?? okFrame("done", "x"),
      emit: (event) => events.push(event),
      budgetMs: 60_000,
    });
    const steps = events.filter((event) => event.kind === "step");
    assert.deepEqual(steps.map((event) => (event.kind === "step" ? event.reply : "")), ["partial"]);
    const last = steps[0];
    assert.match(last?.kind === "step" ? last.text : "", /已写下 run_daily\.ml[\s\S]*这不能算做成[\s\S]*Schedule\.daily/);
    const limit = events.find((event) => event.kind === "limit");
    assert.ok(limit && limit.kind === "limit" && limit.what === "定时（没有用 Schedule.daily 登记）");
    assert.ok(result.ok);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("Schedule.daily in a step registers a schedule: a schedule event, the list in the next prompt, and a Done that stands", async () => {
  const events: AgentEventBody[] = [];
  const contexts: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = capturing(contexts);
  const frames = [
    okFrame("continue", "今天的先做好了，登记每天的。", "Files.write_file\tweather/today.md\tOk\nSchedule.daily\t08:00\tOk 查 5 个城市天气，汇总写进 weather/today.md"),
    okFrame("done", "每天 08:00 会自动汇总。", "Check.contains\tweather/today.md 含 北京\t通过"),
  ];
  let i = 0;
  try {
    const result = await runDeskLoop("key", "定时北京时间每天早上8点把这5个城市天气预报汇总", [], ["ocaml", "files"], [], [], "", {
      runCore: replyAwareCore(frames),
      runPayload: async () => frames[i++] ?? okFrame("done", "x"),
      emit: (event) => events.push(event),
      budgetMs: 60_000,
      schedules: [{ time: "21:30", tz: "Asia/Shanghai", task: "整理当天笔记" }],
    });
    const scheduled = events.find((event) => event.kind === "schedule");
    assert.ok(scheduled && scheduled.kind === "schedule");
    assert.equal(scheduled.time, "08:00");
    assert.equal(scheduled.tz, "Asia/Shanghai");
    assert.equal(scheduled.task, "查 5 个城市天气，汇总写进 weather/today.md");
    assert.ok(!events.some((event) => event.kind === "effect" && event.tool === "Schedule.daily"), "the registration is its own event, not an effect line");
    const steps = events.filter((event) => event.kind === "step");
    assert.deepEqual(steps.map((event) => (event.kind === "step" ? event.reply : "")), ["continue", "done"]);
    assert.ok(!events.some((event) => event.kind === "limit"), "registered: the Done stands");
    assert.ok(result.ok);
    // The prompt after the registration lists both schedules, numbered, with the existing one first.
    const after = contexts.slice(1).join("\n");
    assert.match(after, /【定时任务】[\s\S]*1\. 每天 21:30（北京时间）：整理当天笔记[\s\S]*2\. 每天 08:00（北京时间）：查 5 个城市天气/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("Schedule.cancel n drops the n-th listed schedule and says which; a run a schedule started is told so", async () => {
  const events: AgentEventBody[] = [];
  const contexts: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = capturing(contexts);
  const frames = [okFrame("done", "取消了。", "Schedule.cancel\t2\t")];
  let i = 0;
  try {
    await runDeskLoop("key", "把每天晚上整理笔记的定时取消", [], ["ocaml"], [], [], "", {
      runCore: replyAwareCore(frames),
      runPayload: async () => frames[i++] ?? okFrame("done", "x"),
      emit: (event) => events.push(event),
      budgetMs: 60_000,
      schedules: [
        { time: "08:00", tz: "Asia/Shanghai", task: "查天气" },
        { time: "21:30", tz: "Asia/Shanghai", task: "整理当天笔记" },
      ],
      scheduled: true,
    });
    const gone = events.find((event) => event.kind === "unschedule");
    assert.ok(gone && gone.kind === "unschedule");
    assert.equal(gone.n, 2);
    assert.equal(gone.task, "整理当天笔记");
    assert.match(contexts[0] ?? "", /【这是定时任务】/);
    assert.deepEqual(events.filter((event) => event.kind === "step").map((event) => (event.kind === "step" ? event.reply : "")), ["done"]);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("the origin of a changed file is kept for Files.restore, bounded, and carried across segments", async () => {
  const frames = [okFrameWithFiles("done", "改好了", "Files.replace\tnotes.md\tOk 替换了 1 处\nCheck.contains\tnotes.md 含 新\t通过", [{ path: "notes.md", content: "新" }])];
  let i = 0;
  const result = await runDeskLoop("key", "task", [{ path: "notes.md", content: "旧" }], ["ocaml", "files"], [], [], "", {
    runCore: replyAwareCore(frames),
    runPayload: async (_payload, _harnesses, _key, hooks) => {
      // What the runner does: the first change to a file records its pre-step content.
      assert.deepEqual(hooks?.origin?.(), {});
      hooks?.onOrigin?.("notes.md", "旧");
      hooks?.onOrigin?.("new.md", null);
      hooks?.onOrigin?.("notes.md", "不该覆盖");
      return frames[i++] ?? okFrame("done", "x");
    },
    emit: () => {},
    budgetMs: 60_000,
  });
  assert.deepEqual(result.plan.origin, { "notes.md": "旧", "new.md": null });
  const big = "x".repeat(200 * 1024);
  const bounded = boundOrigin({ "a.txt": big, "b.txt": big, "c.txt": "small", "d.txt": null });
  const kept = Object.keys(bounded).sort();
  assert.equal(kept.length, 3, "one of the two big files had to go");
  assert.ok(kept.includes("c.txt") && kept.includes("d.txt"));
});

test("the real runner: Check.* verdicts land in the effects, and Files.restore steps a file back to how the task found it", async () => {
  const { runStep } = await import("./ocaml-run.ts");
  const files = [{ path: "notes.md", content: "第一节\n改坏了\n" }, { path: "extra.md", content: "多出来的" }];
  const source = `module Step : STEP = struct
  let run () =
    let a = Check.contains "notes.md" "第一节" in
    let b = Check.contains "notes.md" "第二节" in
    let c = Check.that (1 + 1 = 2) "一加一等于二" in
    let d = Check.equal "a" "b" "字母相同" in
    match Files.restore "notes.md", Files.restore "extra.md", Files.restore "untouched.md" with
    | Ok _, Ok _, Error _ ->
        let back = Check.contains "notes.md" "原来的" in
        let gone = match Files.read_file "extra.md" with Error _ -> true | Ok _ -> false in
        Continue (Printf.sprintf "%b %b %b %b %b %b" a b c d back gone)
    | _ -> Partial "restore 不对"
end`;
  const payload = `${block(source)}${files.length}\n${files.map((file) => `${file.path}\n${block(file.content)}`).join("")}`;
  const origin = { "notes.md": "第一节\n原来的\n", "extra.md": null };
  const recorded: [string, string | null][] = [];
  const raw = await runStep(payload, ["ocaml", "files"], undefined, { origin: () => ({ ...origin }), onOrigin: (path, content) => recorded.push([path, content]) });
  const { describeStepFrame } = await import("./progress.ts");
  const frame = describeStepFrame(raw);
  assert.ok(frame && frame.kind === "ok", raw.slice(0, 400));
  if (!frame || frame.kind !== "ok") return;
  assert.equal(frame.text, "true false true false true true");
  const verdicts = frame.effects.filter((effect) => effect.tool.startsWith("Check.")).map((effect) => [effect.tool, effect.detail, effect.output.startsWith("通过")]);
  assert.deepEqual(verdicts, [
    ["Check.contains", "notes.md 含 第一节", true],
    ["Check.contains", "notes.md 含 第二节", false],
    ["Check.that", "一加一等于二", true],
    ["Check.equal", "字母相同", false],
    ["Check.contains", "notes.md 含 原来的", true],
  ]);
  const miss = frame.effects.find((effect) => effect.detail === "notes.md 含 第二节");
  assert.equal(miss?.output, "没通过：文件里没有这段；文件里实际是：第一节 改坏了", "a miss shows what the file holds");
  const restored = frame.effects.filter((effect) => effect.tool === "Files.restore").map((effect) => effect.output);
  assert.match(restored[0] ?? "", /^Ok 已退回任务开始时的版本/);
  assert.match(restored[1] ?? "", /^Ok 任务开始时没有这个文件，已删掉/);
  assert.match(restored[2] ?? "", /^Error 没有这个文件/);
  assert.deepEqual(frame.files?.map((file) => [file.path, file.content]), [["notes.md", "第一节\n原来的\n"]]);
  // Restoring is not a first change, so nothing new is recorded as origin.
  assert.deepEqual(recorded, []);
  // A first write to a file the task had not touched records what it was.
  const first = `module Step : STEP = struct let run () = (match Files.write_file "fresh.md" "新" with Ok () -> () | Error _ -> ()); (match Files.append "notes.md" "尾巴" with Ok () -> () | Error _ -> ()); Continue "w" end`;
  const payload2 = `${block(first)}${files.length}\n${files.map((file) => `${file.path}\n${block(file.content)}`).join("")}`;
  const seen: [string, string | null][] = [];
  await runStep(payload2, ["ocaml", "files"], undefined, { origin: () => ({}), onOrigin: (path, content) => seen.push([path, content]) });
  assert.deepEqual(seen, [["fresh.md", null], ["notes.md", "第一节\n改坏了\n"]]);
});

test("the real runner: Schedule.daily checks the time and the task, and logs what it registered", async () => {
  const { runStep } = await import("./ocaml-run.ts");
  const source = `module Step : STEP = struct
  let run () =
    let a = Schedule.daily "08:00" "查 5 个城市天气，汇总写进 weather/today.md" in
    let b = Schedule.daily "8:30 Asia/Tokyo" "整理笔记" in
    let c = Schedule.daily "早上八点" "查天气" in
    let d = Schedule.daily "25:00" "查天气" in
    let e = Schedule.daily "08:00" "   " in
    let f = Schedule.daily "08:00" (String.make 400 'x') in
    Schedule.cancel 2;
    let show = function Ok () -> "ok" | Error m -> "err:" ^ m in
    Continue (String.concat " | " (List.map show [a; b; c; d; e; f]))
end`;
  const raw = await runStep(`${block(source)}0\n`, ["ocaml"], undefined);
  const { describeStepFrame } = await import("./progress.ts");
  const frame = describeStepFrame(raw);
  assert.ok(frame && frame.kind === "ok", raw.slice(0, 400));
  if (!frame || frame.kind !== "ok") return;
  assert.match(frame.text, /^ok \| ok \| err:时间要写成 08:00[^|]*\| err:时间要写成 08:00[^|]*\| err:要定时做的事是空的 \| err:要定时做的事太长了/);
  const logged = frame.effects.filter((effect) => effect.tool.startsWith("Schedule.")).map((effect) => [effect.tool, effect.detail, effect.output]);
  assert.equal(logged.length, 7);
  assert.deepEqual(logged[0], ["Schedule.daily", "08:00", "Ok 查 5 个城市天气，汇总写进 weather/today.md"]);
  assert.deepEqual(logged[1], ["Schedule.daily", "8:30 Asia/Tokyo", "Ok 整理笔记"]);
  assert.deepEqual(logged.slice(2, 6).map((row) => [row[1], row[2]?.split("，")[0]]), [
    ["早上八点", "Error 时间要写成 08:00（默认北京时间）"],
    ["25:00", "Error 时间要写成 08:00（默认北京时间）"],
    ["08:00", "Error 要定时做的事是空的"],
    ["08:00", "Error 要定时做的事太长了"],
  ]);
  assert.deepEqual(logged[6], ["Schedule.cancel", "2", ""]);
  const { scheduleChanges } = await import("./schedule.ts");
  assert.deepEqual(scheduleChanges(frame.effects), [
    { kind: "daily", spec: { time: "08:00", tz: "Asia/Shanghai", task: "查 5 个城市天气，汇总写进 weather/today.md" } },
    { kind: "daily", spec: { time: "08:30", tz: "Asia/Tokyo", task: "整理笔记" } },
    { kind: "cancel", n: 2 },
  ]);
});

test("a task about 我的… answered with a placeholder becomes an Ask, unless the desk already knows the fact", async () => {
  const written = [{ path: "README.md", content: "# <名字> 的主页\n" }];
  const placeholder = okFrameWithFiles("done", "已写下 README.md，标题处留了名字的位置", "Files.write_file\tREADME.md\tOk\nCheck.contains\tREADME.md 含 主页\t通过", written);
  const events: AgentEventBody[] = [];
  let i = 0;
  const asked = await runDeskLoop("key", "把我的名字写进 README.md 的标题", [], ["ocaml", "files"], [], [], "", {
    runCore: replyAwareCore([placeholder]),
    runPayload: async () => (i++ === 0 ? placeholder : okFrame("done", "x")),
    emit: (event) => events.push(event),
    budgetMs: 60_000,
  });
  assert.equal(asked.ok, true);
  assert.equal(i, 1);
  const need = events.find((event) => event.kind === "need_input");
  assert.ok(need && need.kind === "need_input");
  assert.deepEqual(need.topics, ["名字"]);
  const step = events.find((event) => event.kind === "step");
  assert.equal(step?.kind === "step" ? step.reply : "", "ask");
  assert.match(step?.kind === "step" ? step.text : "", /还差一样只有你知道的：你的名字/);
  // The frame handed back to the loop is an Ask too, so the run ends waiting on the user.
  assert.match(asked.answer, /^ok\nask\n/);
  // Known from the conversation: no question.
  events.length = 0;
  i = 0;
  const known = await runDeskLoop("key", "把我的名字写进 README.md 的标题", [], ["ocaml", "files"], [], [], "", {
    runCore: replyAwareCore([placeholder]),
    runPayload: async () => (i++ === 0 ? placeholder : okFrame("done", "x")),
    emit: (event) => events.push(event),
    budgetMs: 60_000,
    history: [{ task: "我叫小王", answer: "记住了", status: "done" }],
  });
  assert.equal(known.ok, true);
  assert.ok(!events.some((event) => event.kind === "need_input"));
  // The pure check: topics, placeholders, what counts as known.
  assert.equal(missingInput("查一下东京天气", "18°C", [], ""), null);
  assert.equal(missingInput("把我的城市写进简介", "已写入：你住在东京", [], ""), null, "no placeholder: nothing to ask");
  assert.deepEqual(missingInput("把我的城市和我的名字写进简介", "写好了", [{ path: "bio.md", content: "我是 [名字]，住在 your_city" }], "")?.topics, ["城市", "名字"]);
  assert.deepEqual(missingInput("把我的城市和我的名字写进简介", "写好了", [{ path: "bio.md", content: "我是 [名字]，住在 your_city" }], "用户在东京")?.topics, ["名字"]);
  assert.equal(missingInput("把我的名字写进去", "写好了，名字做成了参数 name", [], "我叫小王"), null);
});

test("carriesOn: a paused run continues by itself while it makes progress and has segments left", () => {
  const base: RunRecord = { id: "run-aaaaaaaaaa", deskId: "desk-aaaaaaaaaa", task: "t", trigger: "user", status: "paused", segment: 1, rounds: 3, events: [], result: null, stopRequested: false, createdAt: 0, updatedAt: 0, endedAt: null };
  const progressed: AgentEvent[] = [
    { kind: "start", task: "t", seq: 1, at: 0 },
    { kind: "step", round: 1, reply: "continue", text: "", seq: 2, at: 0 },
  ];
  assert.equal(carriesOn({ ...base, events: progressed }), true);
  assert.equal(carriesOn({ ...base, events: [{ kind: "start", task: "t", seq: 1, at: 0 }, { kind: "think", round: 1, seq: 2, at: 0 }] }), false, "a segment that did nothing would just spin");
  assert.equal(carriesOn({ ...base, events: progressed, segment: MAX_SEGMENTS }), false);
  assert.equal(carriesOn({ ...base, events: progressed, status: "done" }), false);
  assert.equal(MAX_SEGMENTS, 10);
});

test("a pause says what happens next: carrying on by itself, stopped at the cap with how to continue, or stopped for doing nothing", () => {
  const seg = "这一段时间用完了（4 轮，3 次调用），做到的都留在工作区里。";
  assert.equal(pauseNote(seg, 2, 9, true), `${seg}马上自动接着做（第 3/${MAX_SEGMENTS} 段）。`);
  const capped = pauseNote(seg, MAX_SEGMENTS, 41, false);
  assert.match(capped, new RegExp(`已经自动连做了 ${MAX_SEGMENTS} 段（共 41 轮），到了一次任务的上限`));
  assert.match(capped, /「接着做」再续一段/);
  assert.match(capped, /新任务/);
  const idle = pauseNote(seg, 3, 12, false);
  assert.match(idle, /没有做出任何一步有效果的事，所以没有自动继续/);
  assert.match(idle, /「接着做」/);
  // The last automatic segment is told to wrap up, not to start new work.
  const ctx = { round: 30, remainingMs: 90_000, files: [], last: null, plan: [], check: null, checkFailed: [], written: [], modules: [] };
  const lastSeg = promptContext({ ...ctx, segment: MAX_SEGMENTS });
  assert.match(lastSeg, new RegExp(`自动接续的最后一段（第 ${MAX_SEGMENTS}/${MAX_SEGMENTS} 段）`));
  assert.match(lastSeg, /Trace\.note 记下做到哪/);
  assert.match(lastSeg, /Partial/);
  const midSeg = promptContext({ ...ctx, segment: 2 });
  assert.match(midSeg, new RegExp(`接着上一段继续的第 2/${MAX_SEGMENTS} 段`));
  assert.doesNotMatch(midSeg, /最后一段/);
  assert.doesNotMatch(promptContext({ ...ctx, segment: 1 }), /第 1\/|最后一段/);
});

test("Notify.send goes through the desk's address: a notify event (not an effect line), the prompt says it is connected, and a 发消息 Done stands only when one went through", async () => {
  const sent: string[] = [];
  const fakeSend = async (url: string, text: string) => {
    sent.push(`${url} ${text}`);
    return { ok: true as const, where: "飞书" };
  };
  const run = async (useIt: boolean) => {
    const events: AgentEventBody[] = [];
    const contexts: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = capturing(contexts);
    const frames = [
      okFrame("continue", "查到了", "Net.get\thttps://api.example/rate\tOk HTTP 200 api.example {\"usd\":7.1}"),
      okFrame("done", "美元 7.1，已发到飞书。", useIt ? "Notify.send\t\tOk 已发到飞书" : ""),
    ];
    let i = 0;
    try {
      const result = await runDeskLoop("key", "查一下美元汇率，然后发消息通知我", [], ["ocaml", "net"], [], [], "", {
        runCore: replyAwareCore(frames),
        runPayload: async (_payload, _harnesses, _key, hooks) => {
          const frame = frames[i++] ?? okFrame("done", "x");
          if (i === 2 && useIt) {
            assert.ok(hooks?.notify, "the step can reach the desk's address");
            const outcome = await hooks.notify("美元 7.1");
            assert.ok(outcome.ok);
          }
          return frame;
        },
        emit: (event) => events.push(event),
        budgetMs: 60_000,
        notifyUrl: "https://open.feishu.cn/open-apis/bot/v2/hook/abc",
        sendNotify: fakeSend,
      });
      return { events, contexts, result };
    } finally {
      globalThis.fetch = realFetch;
    }
  };
  const used = await run(true);
  assert.deepEqual(sent, ["https://open.feishu.cn/open-apis/bot/v2/hook/abc 美元 7.1"]);
  const notify = used.events.find((event) => event.kind === "notify");
  assert.ok(notify && notify.kind === "notify" && notify.ok && notify.where === "飞书" && !notify.auto);
  assert.ok(!used.events.some((event) => event.kind === "effect" && event.tool === "Notify.send"), "the delivery is its own event");
  assert.ok(!used.events.some((event) => event.kind === "limit"), "sent: the Done stands");
  assert.match(used.contexts[0] ?? "", /【通知已接通】这个工作区填了飞书的通知地址/);
  assert.ok(used.result.ok);

  const unused = await run(false);
  const limit = unused.events.find((event) => event.kind === "limit");
  assert.ok(limit && limit.kind === "limit" && limit.what === "发消息（没有用 Notify.send 发出去）");
  const steps = unused.events.filter((event) => event.kind === "step");
  assert.deepEqual(steps.map((event) => (event.kind === "step" ? event.reply : "")), ["continue", "partial"]);
});
