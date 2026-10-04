import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { prelude } from "./harness.ts";
import { publicUrl } from "./net.ts";

describe("public urls", () => {
  it("allows a public https url and rejects local targets", () => {
    assert.equal(publicUrl("https://example.com/a")?.hostname, "example.com");
    assert.equal(publicUrl("http://127.0.0.1/"), null);
    assert.equal(publicUrl("http://169.254.169.254/"), null);
    assert.equal(publicUrl("http://10.0.0.8/"), null);
    assert.equal(publicUrl("file:///etc/passwd"), null);
    assert.equal(publicUrl("https://user:pass@example.com"), null);
  });
});

describe("ocaml prelude", () => {
  it("only exposes harnesses that are turned on", () => {
    const both = prelude(["net", "search", "ocaml"]);
    assert.match(both, /module Net/);
    assert.match(both, /module Search/);
    const netOnly = prelude([]);
    assert.doesNotMatch(netOnly, /module Net/);
    assert.doesNotMatch(netOnly, /module Search/);
  });
});
