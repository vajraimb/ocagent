import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { commandAgent, PRESETS, understand } from "./command.ts";
import { startSession } from "./runtime.ts";
import { fileIsAdd, MATH_PATH } from "./world.ts";

describe("task agent", () => {
  it("turns a sentence into a plan and refuses chatter", () => {
    const plan = understand(PRESETS[0]!.source);
    assert.equal(plan.error, null);
    assert.deepEqual(
      plan.acts.map((act) => act.kind),
      ["read", "fix", "lint", "shell"],
    );
    const junk = understand("今天天气怎么样");
    assert.equal(junk.acts.length, 0);
    assert.ok(junk.error);
  });

  it("fixes the file, then waits for publish approval", () => {
    const source = PRESETS[0]!.source;
    const first = startSession({
      profile: "prod",
      prompt: source,
      agent: commandAgent,
      runId: "task:ship",
    });
    assert.equal(first.result.status, "suspended");
    assert.equal(first.result.approval?.action, "shell");
    assert.equal(fileIsAdd(first.result.world.files[MATH_PATH] ?? ""), true);
    const decided = first.exitProcess();
    const entry = decided.result.journal.entries[decided.result.suspendSeq ?? 0];
    assert.ok(entry);
    entry.status = "Done";
    entry.result = { tag: "Approved" };
    const next = startSession({
      profile: "prod",
      prompt: source,
      agent: commandAgent,
      runId: "task:ship",
      journal: decided.result.journal,
      world: decided.result.world,
    });
    assert.equal(next.result.status, "done");
    assert.equal(next.result.value?.published, "yes");
    assert.match(next.result.value?.answer ?? "", /x \+ y/);
    assert.equal(fileIsAdd(next.result.world.files[MATH_PATH] ?? ""), true);
  });

  it("explains a bug without writing when told not to edit", () => {
    const run = startSession({
      profile: "prod",
      prompt: PRESETS[1]!.source,
      agent: commandAgent,
      runId: "task:look",
    });
    assert.equal(run.result.status, "done");
    assert.equal(run.result.value?.ok, true);
    assert.match(run.result.value?.answer ?? "", /减法/);
    assert.equal(fileIsAdd(run.result.world.files[MATH_PATH] ?? ""), false);
    assert.equal(run.result.journal.entries.some((entry) => entry.label === "Tool · apply_patch"), false);
  });

  it("writes a bad patch, then fixes it after the lint fails", () => {
    const run = startSession({
      profile: "eval",
      prompt: PRESETS[2]!.source,
      agent: commandAgent,
      runId: "task:retry",
    });
    assert.equal(run.result.status, "done");
    assert.equal(run.result.value?.ok, true);
    assert.equal(run.result.value?.attempts, 2);
    assert.equal(fileIsAdd(run.result.world.files[MATH_PATH] ?? ""), true);
  });

  it("asks before publishing, and runs a quoted command without editing", () => {
    const asked = understand("把加法改好，问我能不能发布，同意再发布");
    assert.deepEqual(
      asked.acts.map((act) => act.kind),
      ["read", "fix", "ask", "shell"],
    );
    const shell = startSession({
      profile: "prod",
      prompt: "不要改文件，运行 echo hello",
      agent: commandAgent,
      runId: "task:echo",
    });
    assert.equal(shell.result.status, "suspended");
    assert.equal(shell.result.approval?.action, "shell");
    assert.equal(fileIsAdd(shell.result.world.files[MATH_PATH] ?? ""), false);
    const payload = shell.result.approval?.payload;
    assert.ok(payload && typeof payload === "object" && !Array.isArray(payload));
    assert.equal(payload.cmd, "echo hello");
  });
});
