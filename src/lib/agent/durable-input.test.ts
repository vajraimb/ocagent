import assert from "node:assert/strict";
import test from "node:test";
import { readCreate, readDecision, readResume } from "./durable-types.ts";

test("create rejects caller url, path, and policy", () => {
  const rejected = readCreate({ dedupeKey: "k", material: "m", task: "", fetch_url: "http://example.com/spec" });
  assert.equal("error" in rejected, true);
  const path = readCreate({ dedupeKey: "../x", material: "m", task: "" });
  assert.equal("error" in path, true);
  const ok = readCreate({ dedupeKey: "k1", material: "alpha", task: "look" });
  assert.deepEqual(ok, { dedupeKey: "k1", material: "alpha", task: "look" });
});

test("resume and decision only accept saved identities", () => {
  const runId = "a".repeat(32);
  const executionHash = "b".repeat(64);
  const requestHash = "c".repeat(64);
  assert.equal("error" in readResume({ runId, executionHash, issued: "no" }), true);
  const decision = readDecision({
    runId,
    executionHash,
    seq: 0,
    requestHash,
    callbackId: "cb-1",
    decision: { tag: "Approved" },
  });
  assert.equal("error" in decision, false);
  assert.equal("error" in readDecision({ runId, executionHash, seq: 0, requestHash, callbackId: "cb-1", decision: { tag: "Rejected", reason: "" } }), true);
});
