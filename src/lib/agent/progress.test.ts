import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { describeModelReply, describeStepFrame, extractCode, foldRounds, ProgressRegistry, type AgentEvent } from "./progress.ts";

function block(text: string): string {
  return `${Buffer.byteLength(text)}\n${text}\n`;
}

describe("progress registry", () => {
  it("numbers events, hands out only the new ones, and keeps the result once closed", () => {
    let clock = 1000;
    const registry = new ProgressRegistry<{ answer: string }>(() => clock);
    registry.open("job-aaaaaaaa");
    registry.emit("job-aaaaaaaa", { kind: "think", round: 1 });
    clock += 10;
    registry.emit("job-aaaaaaaa", { kind: "plan", round: 1, code: "module Step = struct end" });
    const first = registry.read("job-aaaaaaaa");
    assert.equal(first.found, true);
    assert.equal(first.done, false);
    assert.deepEqual(
      first.events.map((event) => event.seq),
      [1, 2],
    );
    assert.equal(registry.read("job-aaaaaaaa", 2).events.length, 0);
    registry.close("job-aaaaaaaa", { answer: "做完了" }, true);
    const last = registry.read("job-aaaaaaaa", 2);
    assert.equal(last.done, true);
    assert.equal(last.events[0]?.kind, "finish");
    assert.deepEqual(last.result, { answer: "做完了" });
    registry.emit("job-aaaaaaaa", { kind: "think", round: 2 });
    assert.equal(registry.read("job-aaaaaaaa", 3).events.length, 0);
  });

  it("forgets jobs after half an hour and reports unknown ids", () => {
    let clock = 0;
    const registry = new ProgressRegistry<null>(() => clock);
    registry.open("job-old00000");
    registry.close("job-old00000", null, true);
    clock = 31 * 60_000;
    registry.open("job-new00000");
    assert.equal(registry.read("job-old00000").found, false);
    assert.equal(registry.read("job-new00000").found, true);
  });

  it("cancels only a live job that registered an abort", () => {
    const registry = new ProgressRegistry<null>();
    let aborted = 0;
    registry.open("job-live0000");
    assert.equal(registry.cancel("job-live0000"), false);
    registry.attachAbort("job-live0000", () => {
      aborted += 1;
    });
    assert.equal(registry.cancel("job-live0000"), true);
    assert.equal(aborted, 1);
    registry.close("job-live0000", null, false);
    assert.equal(registry.cancel("job-live0000"), false);
  });
});

describe("bridge envelopes", () => {
  it("reads model text and errors", () => {
    assert.deepEqual(describeModelReply(`text\n${block("```ocaml\nmodule Step : STEP = struct let run () = Done \"好\" end\n```")}`), {
      kind: "text",
      text: '```ocaml\nmodule Step : STEP = struct let run () = Done "好" end\n```',
    });
    assert.deepEqual(describeModelReply(`error\n${block("模型太慢")}`), { kind: "error", message: "模型太慢" });
    assert.equal(describeModelReply("garbage"), null);
  });

  it("pulls the ocaml block out of a reply", () => {
    assert.equal(extractCode("```ocaml\nlet x = 1\n```"), "let x = 1");
    assert.equal(extractCode("```\nlet y = 2\n```\n"), "let y = 2");
    assert.equal(extractCode("module Step : STEP = struct end"), "module Step : STEP = struct end");
    assert.equal(extractCode("只是文字"), "");
  });

  it("reads a step frame with multibyte effects and drops the injected result note", () => {
    const effects = ["Search.query\t东京 天气\tOk 晴，19°C", "Trace.note\t\t记下：19", "Trace.note\t\t【结果】内部提示"].join("\n");
    const raw = `ok\ncontinue\n${block("再来一轮")}${block("记下：19")}${block(effects)}0\n`;
    const frame = describeStepFrame(raw);
    assert.ok(frame && frame.kind === "ok");
    assert.equal(frame.reply, "continue");
    assert.equal(frame.text, "再来一轮");
    assert.deepEqual(frame.effects, [
      { tool: "Search.query", detail: "东京 天气", output: "Ok 晴，19°C" },
      { tool: "Trace.note", detail: "", output: "记下：19" },
    ]);
    assert.deepEqual(describeStepFrame(`fail\n${block("编译失败 (第 3 行)")}`), { kind: "fail", message: "编译失败 (第 3 行)" });
    assert.equal(describeStepFrame("nope"), null);
  });
});

describe("timeline rounds", () => {
  it("folds events into rounds and clears in-flight calls when the step lands", () => {
    const events: AgentEvent[] = [
      { seq: 1, at: 0, kind: "start", task: "查天气" },
      { seq: 2, at: 0, kind: "think", round: 1 },
      { seq: 3, at: 0, kind: "plan", round: 1, code: "let a = 1" },
      { seq: 4, at: 0, kind: "run", round: 1 },
      { seq: 5, at: 0, kind: "call", round: 1, tool: "Net.get", detail: "https://example.com" },
      { seq: 6, at: 0, kind: "effect", round: 1, tool: "Net.get", detail: "https://example.com", output: "Ok HTTP 200" },
      { seq: 7, at: 0, kind: "step", round: 1, reply: "continue", text: "" },
      { seq: 8, at: 0, kind: "think", round: 2 },
    ];
    const rounds = foldRounds(events);
    assert.equal(rounds.length, 2);
    assert.equal(rounds[0]?.code, "let a = 1");
    assert.equal(rounds[0]?.running, false);
    assert.deepEqual(rounds[0]?.calls, []);
    assert.equal(rounds[0]?.effects.length, 1);
    assert.equal(rounds[0]?.reply?.kind, "continue");
    assert.equal(rounds[1]?.thinking, true);
  });

  it("keeps a compile failure on its round", () => {
    const rounds = foldRounds([
      { seq: 1, at: 0, kind: "think", round: 1 },
      { seq: 2, at: 0, kind: "plan", round: 1, code: "bad" },
      { seq: 3, at: 0, kind: "run", round: 1 },
      { seq: 4, at: 0, kind: "compile_failed", round: 1, message: "编译失败" },
    ]);
    assert.equal(rounds[0]?.compileError, "编译失败");
    assert.equal(rounds[0]?.running, false);
  });
});
