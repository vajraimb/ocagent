import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseCsv, parseInline, parseMarkdown, plainText, previewKind } from "./markdown.ts";

describe("markdown", () => {
  it("reads headings, paragraphs, lists (nested, checked, numbered), quotes, code and rules", () => {
    const blocks = parseMarkdown(`# 天气汇总

今天 **最热** 的是 *新加坡*，\`31°C\`。
第二行接着。

- 北京 21°C
  - 晴
- [x] 上海 24°C
- [ ] 东京

1. 先查
2. 再写

> 注意：数据来自假数据。

\`\`\`ocaml
let x = 1
\`\`\`

---
`);
    assert.deepEqual(blocks.map((block) => block.kind), ["heading", "paragraph", "list", "list", "quote", "code", "rule"]);
    const [heading, para, list, ordered, quote, code] = blocks;
    assert.ok(heading?.kind === "heading" && heading.level === 1 && plainText(heading.children) === "天气汇总");
    assert.ok(para?.kind === "paragraph");
    assert.deepEqual(
      para.children.map((node) => node.kind),
      ["text", "strong", "text", "em", "text", "code", "text"],
    );
    assert.equal(plainText(para.children), "今天 最热 的是 新加坡，31°C。 第二行接着。");
    assert.ok(list?.kind === "list" && !list.ordered && list.items.length === 3);
    assert.equal(list.items[0]?.children.length, 2, "the first item carries a nested list");
    assert.equal(list.items[0]?.children[1]?.kind, "list");
    assert.equal(list.items[1]?.checked, true);
    assert.equal(list.items[2]?.checked, false);
    assert.ok(ordered?.kind === "list" && ordered.ordered && ordered.start === 1 && ordered.items.length === 2);
    assert.ok(quote?.kind === "quote" && quote.children[0]?.kind === "paragraph");
    assert.ok(code?.kind === "code" && code.lang === "ocaml" && code.text === "let x = 1");
  });

  it("reads pipe tables with alignment", () => {
    const [table] = parseMarkdown(`| 城市 | 气温 |\n|:--|--:|\n| 北京 | 21 |\n| 上海 | 24 |`);
    assert.ok(table?.kind === "table");
    assert.deepEqual(table.header.map(plainText), ["城市", "气温"]);
    assert.deepEqual(table.align, ["left", "right"]);
    assert.deepEqual(table.rows.map((row) => row.map(plainText)), [["北京", "21"], ["上海", "24"]]);
  });

  it("keeps links and images only with safe targets, and leaves snake_case alone", () => {
    const nodes = parseInline("见 [文档](https://example.com/a) 和 [坏的](javascript:alert(1))，变量 user_name_x，https://auto.example/x 自动成链接。");
    const link = nodes.find((node) => node.kind === "link");
    assert.ok(link && link.kind === "link" && link.href === "https://example.com/a");
    assert.ok(!nodes.some((node) => node.kind === "link" && node.href.startsWith("javascript:")));
    assert.ok(plainText(nodes).includes("坏的"), "the unsafe link keeps its text");
    assert.ok(plainText(nodes).includes("user_name_x"));
    assert.ok(!nodes.some((node) => node.kind === "em"), "underscores inside a word are not emphasis");
    assert.ok(nodes.some((node) => node.kind === "link" && node.href === "https://auto.example/x"));
    const image = parseInline("![图](data:image/png;base64,AAAA) ![no](file:///etc/passwd)");
    assert.equal(image.filter((node) => node.kind === "image").length, 1);
  });

  it("parses CSV with quotes, and picks the delimiter from the first line", () => {
    const csv = parseCsv('城市,气温,备注\n北京,21,"晴, 微风"\n上海,24,"说""好""的"\n');
    assert.deepEqual(csv.header, ["城市", "气温", "备注"]);
    assert.deepEqual(csv.rows, [["北京", "21", "晴, 微风"], ["上海", "24", '说"好"的']]);
    assert.equal(csv.more, 0);
    assert.deepEqual(parseCsv("a\tb\n1\t2").rows, [["1", "2"]]);
    assert.deepEqual(parseCsv("a;b\n1;2").rows, [["1", "2"]]);
    assert.equal(parseCsv("h\n" + "x\n".repeat(600), 500).more, 100);
  });

  it("names the preview by extension", () => {
    assert.equal(previewKind("weather/today.md"), "markdown");
    assert.equal(previewKind("chart.svg"), "svg");
    assert.equal(previewKind("index.html"), "html");
    assert.equal(previewKind("data.csv"), "csv");
    assert.equal(previewKind("data.json"), "json");
    assert.equal(previewKind("src/fib.ml"), "text");
  });
});
