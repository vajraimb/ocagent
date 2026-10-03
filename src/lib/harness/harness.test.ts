import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runProofs } from "./proofs.ts";

describe("ocagent harness", () => {
  it("passes the M0–M4 acceptance proofs", () => {
    const proofs = runProofs();
    const failed = proofs.filter((proof) => !proof.pass);
    assert.deepEqual(
      failed.map((proof) => `${proof.id}: ${proof.detail}`),
      [],
    );
    assert.equal(proofs.length, 9);
  });
});
