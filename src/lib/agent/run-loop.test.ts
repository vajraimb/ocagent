import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { MAX_FILE_BYTES, mergeModules, parseDeskInput, runDeskLoop, type LoopDeps } from "./run.ts";
import type { CoreJob, CoreResult, RunHooks } from "./ocaml-run.ts";

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

test("parseDeskInput refuses a workspace too big to ride along, naming the biggest files", () => {
  const base = { task: "t", harnesses: ["ocaml"], modules: [], journal: [], memory: "" };
  const huge = "x".repeat(MAX_FILE_BYTES + 1);
  const single = parseDeskInput({ ...base, files: [{ path: "lib/big.ml", content: huge }] });
  assert.ok("error" in single && /lib\/big\.ml.*单个文件最多/.test(single.error));
  const many = Array.from({ length: 8 }, (_, i) => ({ path: `lib/l${i}.ml`, content: "y".repeat(MAX_FILE_BYTES - 1) }));
  const total = parseDeskInput({ ...base, files: many });
  assert.ok("error" in total && /工作区一共.*最大的几个：lib\/l0\.ml/.test(total.error));
  const fine = parseDeskInput({ ...base, files: [{ path: "src/a.ml", content: "let a = 1" }] });
  assert.ok(!("error" in fine) && fine.files.length === 1);
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
