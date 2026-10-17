import assert from "node:assert/strict";
import { test } from "node:test";
import { bannedCall, checkModule, moduleExports, moduleFromFile, moduleNameFor, normalizeModules, MAX_MODULES } from "./harness.ts";

test("moduleNameFor turns a file path into a module name and refuses reserved ones", () => {
  assert.equal(moduleNameFor("src/fib_fast.ml"), "Fib_fast");
  assert.equal(moduleNameFor("lib/myopt.ml"), "Myopt");
  assert.equal(moduleNameFor("notes/todo.md"), null);
  assert.equal(moduleNameFor("src/net.ml"), null);
  assert.equal(moduleNameFor("src/9lives.ml"), null);
  assert.equal(moduleNameFor(""), null);
});

test("moduleExports lists top-level bindings once, in order", () => {
  const body = ["let rec fib n = if n < 2 then n else fib (n - 1) + fib (n - 2)", "and helper x = x", "let ( +: ) a b = a + b", "  let inner = 1", "let fib n = n", "type t = A", "let _ = ()"].join("\n");
  assert.deepEqual(moduleExports(body), ["fib", "helper"]);
});

test("bannedCall names the offending call so the error can say it", () => {
  assert.equal(bannedCall("let f x = Obj.magic x"), "Obj.");
  assert.equal(bannedCall("let () = ignore (Sys.command \"ls\")"), "Sys.command");
  assert.equal(bannedCall("#load \"unix.cma\""), "#load");
  assert.equal(bannedCall("let f x = x + 1"), null);
});

test("checkModule rejects banned calls and reserved names but keeps clean bodies", () => {
  assert.equal(checkModule("Bad", "let f x = Marshal.to_string x []"), null);
  assert.equal(checkModule("Harness", "let f x = x"), null);
  assert.deepEqual(checkModule("Fib", "  let fib n = n  "), { name: "Fib", body: "let fib n = n" });
});

test("moduleFromFile strips a matching module wrapper", () => {
  const file = "module Greet = struct\n  let hello name = \"hi \" ^ name\nend\n";
  assert.deepEqual(moduleFromFile("Greet", file), { name: "Greet", body: "let hello name = \"hi \" ^ name" });
  assert.deepEqual(moduleFromFile("Other", file)?.body, file.trim());
});

test("normalizeModules caps the list and drops duplicates", () => {
  const many = Array.from({ length: MAX_MODULES + 3 }, (_, index) => ({ name: `M${index}`, body: "let x = 1" }));
  assert.equal(normalizeModules(many).length, MAX_MODULES);
  const dup = normalizeModules([
    { name: "A", body: "let x = 1" },
    { name: "A", body: "let x = 2" },
  ]);
  assert.deepEqual(dup, [{ name: "A", body: "let x = 1" }]);
});
