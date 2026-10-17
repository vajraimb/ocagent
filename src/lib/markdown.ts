// A small Markdown reader for the files the agent writes: headings, lists,
// code, quotes, tables, links and emphasis. It produces a tree the panel turns
// into React elements, so nothing is ever injected as HTML.

export type Inline =
  | { kind: "text"; text: string }
  | { kind: "code"; text: string }
  | { kind: "strong"; children: Inline[] }
  | { kind: "em"; children: Inline[] }
  | { kind: "del"; children: Inline[] }
  | { kind: "link"; href: string; children: Inline[] }
  | { kind: "image"; src: string; alt: string }
  | { kind: "br" };

export type Block =
  | { kind: "heading"; level: number; children: Inline[] }
  | { kind: "paragraph"; children: Inline[] }
  | { kind: "code"; lang: string; text: string }
  | { kind: "quote"; children: Block[] }
  | { kind: "list"; ordered: boolean; start: number; items: ListItem[] }
  | { kind: "table"; header: Inline[][]; align: ("left" | "right" | "center" | null)[]; rows: Inline[][][] }
  | { kind: "rule" };

export type ListItem = { checked: boolean | null; children: Block[] };

const FENCE = /^(\s*)(`{3,}|~{3,})\s*([\w+-]*)\s*$/;
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE = /^\s*(?:-\s*){3,}$|^\s*(?:\*\s*){3,}$|^\s*(?:_\s*){3,}$/;
const BULLET = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const TABLE_SEP = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;

export function parseMarkdown(source: string): Block[] {
  return parseBlocks(source.replace(/\r\n?/g, "\n").split("\n"));
}

function parseBlocks(lines: string[]): Block[] {
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (!line.trim()) {
      i += 1;
      continue;
    }
    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[2] ?? "```";
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !(lines[i] ?? "").trim().startsWith(marker)) {
        body.push(lines[i] ?? "");
        i += 1;
      }
      i += 1;
      blocks.push({ kind: "code", lang: fence[3] ?? "", text: body.join("\n") });
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push({ kind: "heading", level: heading[1]?.length ?? 1, children: parseInline(heading[2] ?? "") });
      i += 1;
      continue;
    }
    if (RULE.test(line)) {
      blocks.push({ kind: "rule" });
      i += 1;
      continue;
    }
    if (line.trimStart().startsWith(">")) {
      const inner: string[] = [];
      while (i < lines.length && ((lines[i] ?? "").trimStart().startsWith(">") || ((lines[i] ?? "").trim() && inner.length && !BULLET.test(lines[i] ?? "")))) {
        inner.push((lines[i] ?? "").replace(/^\s*>\s?/, ""));
        i += 1;
      }
      blocks.push({ kind: "quote", children: parseBlocks(inner) });
      continue;
    }
    if (BULLET.test(line)) {
      const list = readList(lines, i);
      blocks.push(list.block);
      i = list.next;
      continue;
    }
    if (line.includes("|") && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1] ?? "")) {
      const header = splitRow(line);
      const align = splitRow(lines[i + 1] ?? "").map((cell) => {
        const left = cell.startsWith(":");
        const right = cell.endsWith(":");
        return left && right ? "center" : right ? "right" : left ? "left" : null;
      });
      const rows: Inline[][][] = [];
      i += 2;
      while (i < lines.length && (lines[i] ?? "").includes("|") && (lines[i] ?? "").trim()) {
        rows.push(splitRow(lines[i] ?? "").map(parseInline));
        i += 1;
      }
      blocks.push({ kind: "table", header: header.map(parseInline), align, rows });
      continue;
    }
    // A paragraph runs until a blank line or the start of another block.
    const para: string[] = [line];
    i += 1;
    while (i < lines.length) {
      const next = lines[i] ?? "";
      if (!next.trim() || FENCE.test(next) || HEADING.test(next) || RULE.test(next) || BULLET.test(next) || next.trimStart().startsWith(">")) break;
      para.push(next);
      i += 1;
    }
    blocks.push({ kind: "paragraph", children: parseInline(para.join("\n")) });
  }
  return blocks;
}

function splitRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  const cells: string[] = [];
  let current = "";
  for (let i = 0; i < trimmed.length; i += 1) {
    const ch = trimmed[i];
    if (ch === "\\" && trimmed[i + 1] === "|") {
      current += "|";
      i += 1;
    } else if (ch === "|") {
      cells.push(current.trim());
      current = "";
    } else current += ch;
  }
  cells.push(current.trim());
  return cells;
}

// A list is read item by item; a continuation line indented at least as far
// as the item's text belongs to that item, so nested lists and multi-line
// items come out right.
function readList(lines: string[], start: number): { block: Block; next: number } {
  const first = BULLET.exec(lines[start] ?? "");
  const indent = first?.[1]?.length ?? 0;
  const ordered = /\d/.test(first?.[2] ?? "");
  const startAt = ordered ? parseInt(first?.[2] ?? "1", 10) || 1 : 1;
  const items: ListItem[] = [];
  let i = start;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    const match = BULLET.exec(line);
    if (!match || (match[1]?.length ?? 0) !== indent || /\d/.test(match[2] ?? "") !== ordered) break;
    const textIndent = indent + (match[2]?.length ?? 1) + 1;
    let text = match[3] ?? "";
    let checked: boolean | null = null;
    const box = /^\[([ xX])\]\s+(.*)$/.exec(text);
    if (box) {
      checked = box[1] !== " ";
      text = box[2] ?? "";
    }
    const body: string[] = [text];
    i += 1;
    while (i < lines.length) {
      const next = lines[i] ?? "";
      if (!next.trim()) {
        // A blank line ends the item unless more indented text follows.
        const after = lines[i + 1] ?? "";
        if (after.trim() && (after.length - after.trimStart().length) >= textIndent) {
          body.push("");
          i += 1;
          continue;
        }
        break;
      }
      const lead = next.length - next.trimStart().length;
      if (lead >= textIndent) {
        body.push(next.slice(textIndent));
        i += 1;
        continue;
      }
      const nested = BULLET.exec(next);
      if (nested && (nested[1]?.length ?? 0) > indent) {
        body.push(next.slice(Math.min(textIndent, nested[1]?.length ?? 0)));
        i += 1;
        continue;
      }
      break;
    }
    items.push({ checked, children: parseBlocks(body) });
  }
  return { block: { kind: "list", ordered, start: startAt, items }, next: i };
}

const SAFE_HREF = /^(https?:|mailto:|#|\/|\.\/|\.\.\/)/i;
const SAFE_SRC = /^(https?:|data:image\/)/i;

export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  let buf = "";
  const flush = () => {
    if (buf) out.push({ kind: "text", text: buf });
    buf = "";
  };
  let i = 0;
  while (i < text.length) {
    const ch = text[i] ?? "";
    const rest = text.slice(i);
    if (ch === "\\" && i + 1 < text.length && /[\\`*_~[\]()#>|!-]/.test(text[i + 1] ?? "")) {
      buf += text[i + 1];
      i += 2;
      continue;
    }
    if (ch === "`") {
      const run = /^`+/.exec(rest)?.[0] ?? "`";
      const end = text.indexOf(run, i + run.length);
      if (end > 0) {
        flush();
        out.push({ kind: "code", text: text.slice(i + run.length, end).trim() });
        i = end + run.length;
        continue;
      }
    }
    if (ch === "!" && text[i + 1] === "[") {
      const link = readLink(text, i + 1);
      if (link) {
        flush();
        out.push(SAFE_SRC.test(link.href) ? { kind: "image", src: link.href, alt: link.text } : { kind: "text", text: link.text });
        i = link.end;
        continue;
      }
    }
    if (ch === "[") {
      const link = readLink(text, i);
      if (link) {
        flush();
        const children = parseInline(link.text);
        out.push(SAFE_HREF.test(link.href) ? { kind: "link", href: link.href, children } : { kind: "text", text: link.text });
        i = link.end;
        continue;
      }
    }
    const auto = /^https?:\/\/[^\s<>()\]）】，。；！？"']+/i.exec(rest);
    if (auto && (i === 0 || /[\s(（>，。；：、]/.test(text[i - 1] ?? ""))) {
      flush();
      out.push({ kind: "link", href: auto[0], children: [{ kind: "text", text: auto[0] }] });
      i += auto[0].length;
      continue;
    }
    const span = readSpan(text, i);
    if (span) {
      flush();
      out.push({ kind: span.kind, children: parseInline(span.text) });
      i = span.end;
      continue;
    }
    if (ch === "\n") {
      const hard = buf.endsWith("  ");
      buf = buf.trimEnd();
      flush();
      out.push(hard ? { kind: "br" } : { kind: "text", text: " " });
      i += 1;
      continue;
    }
    buf += ch;
    i += 1;
  }
  flush();
  return mergeText(out);
}

function mergeText(items: Inline[]): Inline[] {
  const merged: Inline[] = [];
  for (const item of items) {
    const last = merged[merged.length - 1];
    if (item.kind === "text" && last?.kind === "text") last.text += item.text;
    else merged.push(item);
  }
  return merged;
}

function readLink(text: string, at: number): { text: string; href: string; end: number } | null {
  let depth = 0;
  let i = at;
  for (; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "\\") {
      i += 1;
      continue;
    }
    if (ch === "[") depth += 1;
    else if (ch === "]") {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  if (depth !== 0 || text[i + 1] !== "(") return null;
  const close = text.indexOf(")", i + 2);
  if (close < 0) return null;
  const target = text.slice(i + 2, close).trim().split(/\s+/)[0] ?? "";
  return { text: text.slice(at + 1, i), href: target.replace(/^<|>$/g, ""), end: close + 1 };
}

// **strong**, __strong__, *em*, _em_, ~~del~~ — closed on the same inline run.
function readSpan(text: string, at: number): { kind: "strong" | "em" | "del"; text: string; end: number } | null {
  const rest = text.slice(at);
  const marker = rest.startsWith("**") || rest.startsWith("__") ? rest.slice(0, 2) : rest.startsWith("~~") ? "~~" : rest[0] === "*" || rest[0] === "_" ? rest[0] : null;
  if (!marker) return null;
  const next = text[at + marker.length] ?? "";
  if (!next || /\s/.test(next)) return null;
  if (marker === "_" || marker === "__") {
    // Underscores inside words (snake_case) are not emphasis.
    const before = text[at - 1] ?? "";
    if (/[\p{L}\p{N}]/u.test(before)) return null;
  }
  let i = at + marker.length;
  while (i < text.length) {
    if (text[i] === "\\") {
      i += 2;
      continue;
    }
    if (text.startsWith(marker, i) && !/\s/.test(text[i - 1] ?? "") && (marker.length === 2 || text[i + 1] !== marker)) {
      const inner = text.slice(at + marker.length, i);
      if (!inner.trim() || inner.includes("\n\n")) return null;
      return { kind: marker === "~~" ? "del" : marker.length === 2 ? "strong" : "em", text: inner, end: i + marker.length };
    }
    if (text[i] === "\n") return null;
    i += 1;
  }
  return null;
}

/** The text of a tree, for previews and tests. */
export function plainText(nodes: Inline[]): string {
  return nodes
    .map((node) => {
      switch (node.kind) {
        case "text":
        case "code":
          return node.text;
        case "image":
          return node.alt;
        case "br":
          return "\n";
        default:
          return plainText(node.children);
      }
    })
    .join("");
}

// ---------------------------------------------------------------------------
// CSV, for the table view.

export function parseCsv(source: string, maxRows = 500): { header: string[]; rows: string[][]; more: number } {
  const text = source.replace(/\r\n?/g, "\n");
  const delimiter = text.split("\n", 1)[0]?.includes("\t") ? "\t" : text.split("\n", 1)[0]?.split(";").length > text.split("\n", 1)[0]?.split(",").length ? ";" : ",";
  const records: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i] ?? "";
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else quoted = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"' && cell === "") quoted = true;
    else if (ch === delimiter) {
      row.push(cell);
      cell = "";
    } else if (ch === "\n") {
      row.push(cell);
      if (row.some((value) => value.trim())) records.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((value) => value.trim())) records.push(row);
  const [header = [], ...rest] = records;
  return { header, rows: rest.slice(0, maxRows), more: Math.max(0, rest.length - maxRows) };
}

export type PreviewKind = "markdown" | "html" | "svg" | "csv" | "json" | "text";

/** How the panel shows a file, by its name. */
export function previewKind(path: string): PreviewKind {
  const ext = (path.split(".").pop() ?? "").toLowerCase();
  if (ext === "md" || ext === "markdown") return "markdown";
  if (ext === "html" || ext === "htm") return "html";
  if (ext === "svg") return "svg";
  if (ext === "csv" || ext === "tsv") return "csv";
  if (ext === "json") return "json";
  return "text";
}
