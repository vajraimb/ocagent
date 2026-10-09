import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SEED, applyFileDelta, applyTool, batchPuts, fileDelta, safePath } from "./workspace.ts";

describe("desk workspace", () => {
  it("starts empty and rejects path escape", () => {
    assert.equal(SEED.length, 0);
    assert.equal(safePath("../etc/passwd"), false);
    assert.equal(safePath("/tmp/x"), false);
    assert.equal(safePath("notes/todo.md"), true);
  });

  it("writes, searches, and deletes any file in the desk", () => {
    const wrote = applyTool(SEED, "write_file", { path: "notes/today.md", content: "买咖啡\n" });
    assert.ok(wrote.files.some((file) => file.path === "notes/today.md"));
    const found = applyTool(wrote.files, "search", { query: "买咖啡" });
    assert.match(found.output, /notes\/today.md:1/);
    const removed = applyTool(wrote.files, "delete_file", { path: "notes/today.md" });
    assert.equal(removed.files.some((file) => file.path === "notes/today.md"), false);
    const escaped = applyTool(SEED, "write_file", { path: "../nope.md", content: "x" });
    assert.equal(escaped.files.length, SEED.length);
    assert.match(escaped.output, /路径不行/);
  });
});

describe("desk deltas", () => {
  it("fileDelta sends only new or edited files and removed paths", () => {
    const synced = new Map([
      ["a.md", "A"],
      ["b.md", "B"],
      ["gone.md", "G"],
    ]);
    const delta = fileDelta(synced, [
      { path: "a.md", content: "A" },
      { path: "b.md", content: "B2" },
      { path: "c.md", content: "C" },
    ]);
    assert.deepEqual(delta.put.map((file) => file.path), ["b.md", "c.md"]);
    assert.deepEqual(delta.remove, ["gone.md"]);
    assert.deepEqual(fileDelta(new Map(), []), { put: [], remove: [] });
  });

  it("applyFileDelta removes, replaces in place and appends", () => {
    const merged = applyFileDelta(
      [
        { path: "a.md", content: "A" },
        { path: "b.md", content: "B" },
        { path: "gone.md", content: "G" },
      ],
      { put: [{ path: "b.md", content: "B2" }, { path: "c.md", content: "C" }], remove: ["gone.md"] },
    );
    assert.deepEqual(merged, [
      { path: "a.md", content: "A" },
      { path: "b.md", content: "B2" },
      { path: "c.md", content: "C" },
    ]);
  });

  it("batchPuts keeps each request under the limit and never splits a file", () => {
    const file = (path: string, size: number) => ({ path, content: "x".repeat(size) });
    const batches = batchPuts([file("1", 400), file("2", 400), file("3", 400), file("4", 2000), file("5", 10)], 1000);
    assert.deepEqual(batches.map((batch) => batch.map((item) => item.path)), [["1", "2"], ["3"], ["4"], ["5"]]);
    assert.deepEqual(batchPuts([]), []);
  });
});
