import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyTool, SEED, safePath } from "./workspace.ts";

describe("desk workspace", () => {
  it("starts with more than one file and rejects path escape", () => {
    assert.ok(SEED.length >= 4);
    assert.ok(SEED.some((file) => file.path !== "src/math.ml"));
    assert.equal(safePath("../etc/passwd"), false);
    assert.equal(safePath("/tmp/x"), false);
    assert.equal(safePath("notes/todo.md"), true);
  });

  it("writes, searches, and deletes any file in the desk", () => {
    const wrote = applyTool(SEED, "write_file", { path: "notes/today.md", content: "买咖啡\n" });
    assert.ok(wrote.files.some((file) => file.path === "notes/today.md"));
    const found = applyTool(wrote.files, "search", { query: "买咖啡" });
    assert.match(found.output, /notes\/today.md:1/);
    const removed = applyTool(wrote.files, "delete_file", { path: "src/greet.ml" });
    assert.equal(removed.files.some((file) => file.path === "src/greet.ml"), false);
    const escaped = applyTool(SEED, "write_file", { path: "../nope.md", content: "x" });
    assert.equal(escaped.files.length, SEED.length);
    assert.match(escaped.output, /路径不行/);
  });
});
