import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { settle } from "./budget.ts";

describe("time budget", () => {
  it("keeps a finished answer and still shows partial work after a timeout", () => {
    assert.equal(settle({ answer: "标题是 Example Domain。", note: "", steps: [], timedOut: false }), "标题是 Example Domain。");
    const partial = settle({
      answer: "",
      note: "新建了 src/pull.ml。右边可以打开看。",
      steps: [{ tool: "http_get", detail: "https://example.com", output: "HTTP 200 example.com" }],
      timedOut: true,
    });
    assert.match(partial, /src\/pull\.ml/);
    assert.match(partial, /HTTP 200/);
    assert.match(partial, /时限到了/);
  });
});
