import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { callsThisRound, orderCalls, webSearchSteps } from "./search.ts";

describe("web search steps", () => {
  it("keeps the query and the http sources", () => {
    const steps = webSearchSteps([
      { type: "reasoning" },
      {
        type: "web_search_call",
        action: {
          query: "上海明天天气",
          sources: [
            { url: "https://m.tianqi.com/shanghai/mingtian" },
            { url: "not a url" },
            { url: "https://m.tianqi.com/shanghai/mingtian" },
          ],
        },
      },
    ]);
    assert.equal(steps.length, 1);
    assert.equal(steps[0]?.tool, "web_search");
    assert.equal(steps[0]?.detail, "上海明天天气");
    assert.equal(steps[0]?.output, "https://m.tianqi.com/shanghai/mingtian");
  });

  it("runs a search before any write from the same turn", () => {
    const round = callsThisRound([
      { name: "web_search" },
      { name: "write_file" },
    ]);
    assert.deepEqual(round.run.map((call) => call.name), ["web_search"]);
    assert.deepEqual(round.defer.map((call) => call.name), ["write_file"]);
    assert.deepEqual(callsThisRound([{ name: "write_file" }]).run.map((call) => call.name), ["write_file"]);
    assert.deepEqual(
      orderCalls([
        { name: "ocaml_run" },
        { name: "load_harness" },
        { name: "write_file" },
        { name: "web_search" },
      ]).map((call) => call.name),
      ["web_search", "write_file", "load_harness", "ocaml_run"],
    );
  });
});
