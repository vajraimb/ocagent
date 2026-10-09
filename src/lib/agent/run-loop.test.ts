import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { moduleNameFromUrl } from "./harness.ts";
import { MAX_FILE_BYTES, mergeModules, parseDeskState, promptContext, runDeskLoop, type LoopDeps } from "./run.ts";
import type { CoreJob, CoreResult, RunHooks } from "./ocaml-run.ts";
import type { AgentEventBody } from "./progress.ts";

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
  // 15.5 s budget minus the 12 s a round needs: the cut comes after ~3.5 s.
  const result = await runDeskLoop("key", "task", [], ["ocaml"], [], [], "", deps({ runCore: fakeCore(200), budgetMs: 15_500 }, kinds));
  assert.equal(result.ok, true);
  assert.equal(result.paused, true);
  assert.ok(Date.now() - started < 8_000, "cut well before the budget itself");
  assert.match(result.ok ? result.answer : "", /时间用完了/);
  assert.ok(result.steps.length > 0, "work done so far is carried");
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
    assert.match(prompts[0] ?? "", /第 2 段/);
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
    plan: { items: [{ text: "写 a.ml", done: true, note: "" }, { text: "写 b.ml", done: false, note: "" }], checks: 1, wrote: true, pending: null },
  });
  assert.equal(result.ok, true);
  assert.equal(i, 1, "the Done went straight through");
  assert.ok(!events.some((event) => event.kind === "check"));
  assert.deepEqual(result.plan.items.map((item) => item.done), [true, true]);
});
