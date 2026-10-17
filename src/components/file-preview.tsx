import { useMemo, useState, type ReactNode } from "react";
import { Code2, Eye } from "lucide-react";
import { parseCsv, parseMarkdown, previewKind, type Block, type Inline, type PreviewKind } from "@/lib/markdown";

// The agent's files shown as what they are: Markdown laid out, HTML and SVG
// drawn (in a sandbox that runs no scripts), CSV as a table, JSON indented.
// Everything else, and the source of all of them, is plain text.

const KIND_LABEL: Record<PreviewKind, string> = { markdown: "排版", html: "页面", svg: "图", csv: "表格", json: "JSON", text: "" };

export function FilePreview({ path, content, className = "" }: { path: string; content: string; className?: string }) {
  const kind = previewKind(path);
  const [source, setSource] = useState(false);
  const rendered = kind !== "text" && !source;
  return (
    <div className={`flex flex-col gap-1.5 ${className}`}>
      {rendered ? <Rendered kind={kind} content={content} /> : <pre className="max-h-72 overflow-auto rounded-lg border border-border bg-bg px-3 py-2 font-mono text-xs leading-5 text-fg">{content}</pre>}
      {kind !== "text" ? (
        <button type="button" onClick={() => setSource((value) => !value)} className="inline-flex min-h-7 items-center gap-1 self-start rounded-md px-1 text-[11px] text-muted hover:text-fg">
          {source ? <Eye className="h-3 w-3" aria-hidden /> : <Code2 className="h-3 w-3" aria-hidden />}
          {source ? `看${KIND_LABEL[kind]}` : "看源码"}
        </button>
      ) : null}
    </div>
  );
}

function Rendered({ kind, content }: { kind: PreviewKind; content: string }) {
  switch (kind) {
    case "markdown":
      return (
        <div className="max-h-96 overflow-auto rounded-lg border border-border bg-bg px-3.5 py-3">
          <Markdown source={content} />
        </div>
      );
    case "html":
    case "svg":
      return <Framed kind={kind} content={content} />;
    case "csv":
      return <CsvTable source={content} />;
    case "json":
      return <JsonView source={content} />;
    default:
      return null;
  }
}

// A sandbox with no scripts and no origin: the drawing shows, nothing runs.
function Framed({ kind, content }: { kind: "html" | "svg"; content: string }) {
  const doc = useMemo(() => {
    // The sandbox would block scripts anyway; dropping them keeps the console quiet.
    const still = content.replace(/<script\b[\s\S]*?<\/script\s*>/gi, "").replace(/\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "");
    if (kind === "svg") return `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;background:#fff;display:flex;align-items:center;justify-content:center;min-height:100vh}svg{max-width:100%;height:auto}</style></head><body>${still}</body></html>`;
    return still;
  }, [kind, content]);
  return (
    <iframe
      title={kind === "svg" ? "SVG 预览" : "页面预览"}
      sandbox=""
      srcDoc={doc}
      className="h-72 w-full rounded-lg border border-border bg-white"
    />
  );
}

function CsvTable({ source }: { source: string }) {
  const table = useMemo(() => parseCsv(source, 300), [source]);
  if (table.header.length === 0) return <p className="text-xs text-muted">（空表）</p>;
  return (
    <div className="max-h-80 overflow-auto rounded-lg border border-border bg-bg">
      <table className="w-full border-collapse text-xs">
        <thead className="sticky top-0 bg-raised">
          <tr>
            {table.header.map((cell, index) => (
              <th key={index} className="border-b border-border px-2.5 py-1.5 text-left font-medium text-fg">
                {cell}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((row, r) => (
            <tr key={r} className="odd:bg-bg even:bg-surface">
              {table.header.map((_, c) => (
                <td key={c} className="whitespace-nowrap border-b border-border/60 px-2.5 py-1 font-mono text-fg">
                  {row[c] ?? ""}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {table.more > 0 ? <p className="px-2.5 py-1.5 text-[11px] text-muted">还有 {table.more} 行没显示；下载后看全部。</p> : null}
    </div>
  );
}

function JsonView({ source }: { source: string }) {
  const pretty = useMemo(() => {
    try {
      return JSON.stringify(JSON.parse(source), null, 2);
    } catch {
      return null;
    }
  }, [source]);
  if (pretty === null) return <pre className="max-h-72 overflow-auto rounded-lg border border-warn/40 bg-bg px-3 py-2 font-mono text-xs leading-5 text-fg">{`（不是合法的 JSON）\n${source}`}</pre>;
  return <pre className="max-h-72 overflow-auto rounded-lg border border-border bg-bg px-3 py-2 font-mono text-xs leading-5 text-fg">{pretty}</pre>;
}

export function Markdown({ source }: { source: string }) {
  const blocks = useMemo(() => parseMarkdown(source), [source]);
  if (blocks.length === 0) return <p className="text-xs text-muted">（空文件）</p>;
  return <div className="md-body flex flex-col gap-2.5 text-[13px] leading-6 text-fg">{blocks.map((block, index) => renderBlock(block, index))}</div>;
}

function renderBlock(block: Block, key: number): ReactNode {
  switch (block.kind) {
    case "heading": {
      const size = block.level === 1 ? "text-lg font-semibold" : block.level === 2 ? "text-base font-semibold" : "text-sm font-semibold";
      const Tag = `h${Math.min(6, block.level)}` as "h1";
      return (
        <Tag key={key} className={`${size} mt-1 leading-snug text-fg`}>
          {renderInline(block.children)}
        </Tag>
      );
    }
    case "paragraph":
      return (
        <p key={key} className="break-words [overflow-wrap:anywhere]">
          {renderInline(block.children)}
        </p>
      );
    case "code":
      return (
        <pre key={key} className="overflow-auto rounded-md border border-border bg-surface px-3 py-2 font-mono text-xs leading-5">
          {block.text}
        </pre>
      );
    case "quote":
      return (
        <blockquote key={key} className="flex flex-col gap-2 border-l-2 border-border pl-3 text-muted">
          {block.children.map((child, index) => renderBlock(child, index))}
        </blockquote>
      );
    case "list": {
      const Tag = block.ordered ? "ol" : "ul";
      return (
        <Tag key={key} start={block.ordered ? block.start : undefined} className={`flex flex-col gap-1 pl-5 ${block.ordered ? "list-decimal" : "list-disc"}`}>
          {block.items.map((item, index) => (
            <li key={index} className={item.checked !== null ? "list-none -ml-5" : ""}>
              {item.checked !== null ? (
                <span className="flex items-start gap-2">
                  <input type="checkbox" readOnly checked={item.checked} className="mt-1.5 h-3.5 w-3.5 accent-[var(--color-accent)]" aria-label={item.checked ? "已完成" : "未完成"} />
                  <span className="flex min-w-0 flex-1 flex-col gap-1">{item.children.map((child, at) => renderBlock(child, at))}</span>
                </span>
              ) : (
                <span className="flex flex-col gap-1">{item.children.map((child, at) => renderBlock(child, at))}</span>
              )}
            </li>
          ))}
        </Tag>
      );
    }
    case "table":
      return (
        <div key={key} className="overflow-auto rounded-md border border-border">
          <table className="w-full border-collapse text-xs">
            <thead className="bg-raised">
              <tr>
                {block.header.map((cell, index) => (
                  <th key={index} className="border-b border-border px-2.5 py-1.5 font-medium text-fg" style={{ textAlign: block.align[index] ?? "left" }}>
                    {renderInline(cell)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, r) => (
                <tr key={r} className="odd:bg-bg even:bg-surface">
                  {block.header.map((_, c) => (
                    <td key={c} className="border-b border-border/60 px-2.5 py-1" style={{ textAlign: block.align[c] ?? "left" }}>
                      {renderInline(row[c] ?? [])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "rule":
      return <hr key={key} className="border-border" />;
    default:
      return null;
  }
}

function renderInline(nodes: Inline[]): ReactNode[] {
  return nodes.map((node, index) => {
    switch (node.kind) {
      case "text":
        return node.text;
      case "code":
        return (
          <code key={index} className="rounded bg-surface px-1 py-0.5 font-mono text-[12px]">
            {node.text}
          </code>
        );
      case "strong":
        return <strong key={index}>{renderInline(node.children)}</strong>;
      case "em":
        return <em key={index}>{renderInline(node.children)}</em>;
      case "del":
        return <del key={index}>{renderInline(node.children)}</del>;
      case "link":
        return (
          <a key={index} href={node.href} target="_blank" rel="noopener noreferrer nofollow" className="text-accent underline underline-offset-2">
            {renderInline(node.children)}
          </a>
        );
      case "image":
        return <img key={index} src={node.src} alt={node.alt} className="my-1 max-h-64 max-w-full rounded-md border border-border" loading="lazy" />;
      case "br":
        return <br key={index} />;
      default:
        return null;
    }
  });
}
