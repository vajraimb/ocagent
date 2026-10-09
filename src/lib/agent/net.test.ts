import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkModule, moduleFromFile } from "./harness.ts";
import { postPublic, publicUrl, readablePage } from "./net.ts";

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

describe("module checks", () => {
  it("accepts a well-named safe module and rejects the rest", () => {
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

describe("postPublic", () => {
  it("sends JSON as JSON, text as text, keeps JSON replies intact and refuses local targets", async () => {
    const realFetch = globalThis.fetch;
    const seen: { url: string; type: string; body: string }[] = [];
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      seen.push({ url: String(url), type: headers["Content-Type"] ?? "", body: String(init?.body) });
      if (String(url).endsWith("/moved")) return new Response("", { status: 302, headers: { location: "https://api.test/v2" } });
      return new Response(JSON.stringify({ ok: true, echo: JSON.parse(String(init?.body)) }, null, 2), { status: 201, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    try {
      const reply = await postPublic("https://api.test/items", '{"name":"a"}');
      assert.equal(seen[0]?.type, "application/json");
      assert.equal(reply, 'HTTP 201 api.test\n{"ok":true,"echo":{"name":"a"}}');
      await postPublic("https://api.test/items", "plain words").catch(() => undefined);
      assert.match(seen[1]?.type ?? "", /^text\/plain/);
      assert.match(await postPublic("https://api.test/moved", "{}"), /HTTP 302 api\.test\n对方要求跳转到 https:\/\/api\.test\/v2/);
      assert.equal(await postPublic("http://127.0.0.1:8080/x", "{}"), "这个地址不能请求。");
      assert.match(await postPublic("https://api.test/items", "x".repeat(30_000)), /太长/);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
