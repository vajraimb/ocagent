import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkModule, moduleFromFile, prelude } from "./harness.ts";
import { publicUrl, readablePage } from "./net.ts";

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
    const both = prelude(["net", "web", "ocaml"]);
    assert.match(both, /module Net/);
    assert.match(both, /module Search/);
    const netOnly = prelude([]);
    assert.doesNotMatch(netOnly, /module Net/);
    assert.doesNotMatch(netOnly, /module Search/);
    const custom = prelude(["ocaml"], [{ name: "Twice", body: "let apply n = n * 2" }]);
    assert.match(custom, /module Twice/);
    assert.equal(checkModule("twice", "let apply n = n * 2"), null);
    assert.equal(checkModule("Twice", "Sys.command \"ls\""), null);
    assert.equal(checkModule("Twice", "let t = Sys.time ()")?.name, "Twice");
    const fromFile = moduleFromFile("Timer", "module Timer = struct\nlet t = Sys.time ()\nend\n");
    assert.equal(fromFile?.body, "let t = Sys.time ()");
    assert.equal(checkModule("Twice", "let apply n = n * 2")?.name, "Twice");
  });
});

describe("readable pages", () => {
  it("keeps the title, description and visible text, drops markup and scripts", () => {
    const html = `<!DOCTYPE html><html><head><title> Example &amp; Co </title>
<meta name="description" content="A tiny &quot;site&quot;"><style>body{color:red}</style>
<script>window.x = "<p>not text</p>";</script></head>
<body><nav><a href="/">Home</a></nav><h1>Hello&nbsp;world</h1><p>First&#8230; line.<br>Second line.</p>
<ul><li>one</li><li>two</li></ul><svg><text>icon</text></svg><!-- hidden --></body></html>`;
    const text = readablePage(html);
    assert.match(text, /^标题：Example & Co\n描述：A tiny "site"\n/);
    assert.match(text, /Hello world\nFirst… line\.\nSecond line\.\none\ntwo/);
    assert.doesNotMatch(text, /not text|color:red|icon|hidden|<p>/);
  });
});
