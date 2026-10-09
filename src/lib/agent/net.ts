export function publicUrl(raw: string): URL | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.username || url.password) return null;
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (isBlockedHost(url.hostname)) return null;
  return url;
}

function isBlockedHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!host || host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) return true;
  if (host === "0.0.0.0" || host === "::" || host === "::1") return true;
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!v4) return host.includes(":");
  const octets = v4.slice(1).map(Number);
  if (octets.some((part) => part > 255)) return true;
  const [a, b] = octets;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b !== undefined && b >= 16 && b <= 31) return true;
  return false;
}

const MAX_SOURCE = 200_000;

// Pulls one OCaml source file off the public web, verbatim. Used by
// Harness.install; the result still has to pass the module checks and compile.
export async function fetchSource(raw: string): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  let current = publicUrl(raw);
  if (!current) return { ok: false, error: "这个地址不能请求。" };
  for (let hop = 0; hop < 3; hop += 1) {
    const response = await fetch(current, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
      headers: { "User-Agent": "ocagent", Accept: "text/plain, text/x-ocaml, */*" },
    });
    if (response.status >= 300 && response.status < 400) {
      const next = response.headers.get("location");
      if (!next) return { ok: false, error: `HTTP ${response.status}，没有跳转地址。` };
      current = publicUrl(new URL(next, current).toString());
      if (!current) return { ok: false, error: "跳转目标不能请求。" };
      continue;
    }
    if (!response.ok) return { ok: false, error: `HTTP ${response.status}。` };
    const type = response.headers.get("content-type") ?? "";
    if (/^(image|audio|video|application\/(octet-stream|zip|gzip|pdf))/i.test(type)) return { ok: false, error: `这不是源码（${type.split(";")[0]}）。` };
    const text = await response.text();
    if (text.length > MAX_SOURCE) return { ok: false, error: `文件太大（${Math.round(text.length / 1000)} KB），一次最多装 ${MAX_SOURCE / 1000} KB。` };
    if (text.includes("\u0000")) return { ok: false, error: "这不是文本文件。" };
    if (/^\s*<(!doctype|html)/i.test(text)) return { ok: false, error: "拿到的是网页，不是 .ml 源码。要用 raw 地址。" };
    return { ok: true, text };
  }
  return { ok: false, error: "跳转太多次。" };
}

const MAX_PAGE_TEXT = 4_000;

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", hellip: "…", mdash: "—", ndash: "–", middot: "·" };

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body: string) => {
    if (body[0] === "#") {
      const code = body[1]?.toLowerCase() === "x" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[body.toLowerCase()] ?? whole;
  });
}

function looksLikeHtml(text: string, contentType: string): boolean {
  return /text\/html|application\/xhtml/i.test(contentType) || /^\s*<(!doctype\s+html|html|head|body)\b/i.test(text);
}

const BLOCK_END = /^\/(p|div|li|tr|h[1-6]|section|article|header|footer|blockquote|pre|td|th|dt|dd)$/i;

// Replaces tags with a space, or a newline after block elements. Attribute
// values are skipped as quoted strings, so a ">" inside one (common in
// data-* JSON and inline handlers) does not end the tag early.
function stripTags(html: string): string {
  let out = "";
  let i = 0;
  while (i < html.length) {
    const ch = html[i];
    if (ch !== "<" || !/[a-zA-Z/!]/.test(html[i + 1] ?? "")) {
      out += ch;
      i += 1;
      continue;
    }
    let j = i + 1;
    let quote = "";
    while (j < html.length) {
      const c = html[j];
      if (quote) {
        if (c === quote) quote = "";
      } else if (c === '"' || c === "'") {
        quote = c;
      } else if (c === ">") {
        break;
      }
      j += 1;
    }
    const inner = html.slice(i + 1, j).trim();
    const name = inner.split(/[\s/>]/, 1)[0] ?? "";
    out += BLOCK_END.test(inner.replace(/\s.*$/s, "")) || /^br$/i.test(name) ? "\n" : " ";
    i = j + 1;
  }
  return out;
}

// A web page as text the model can use: title and description first, then the
// visible copy with markup, scripts and styles gone. Raw HTML in a 3,500-char
// window is mostly boilerplate, which was what the model used to get.
export function readablePage(html: string): string {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  const description = /<meta\s+[^>]*(?:name|property)=["'](?:description|og:description)["'][^>]*content=["']([^"']*)["']/i.exec(html)?.[1] ?? /<meta\s+[^>]*content=["']([^"']*)["'][^>]*(?:name|property)=["'](?:description|og:description)["']/i.exec(html)?.[1];
  const stripped = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|template|iframe|canvas)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<(head)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<(nav|aside|footer)\b[\s\S]*?<\/\1>/gi, " ");
  // The main column when the page marks one and it has real copy.
  const main = /<(main|article)\b[^>]*>([\s\S]*?)<\/\1>/i.exec(stripped)?.[2];
  const mainText = main ? stripTags(main) : "";
  const body = mainText.trim().length >= 400 ? mainText : stripTags(stripped);
  const text = decodeEntities(body)
    .split("\n")
    .map((line) => line.replace(/[ \t\r\f\v\u00a0]+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
  const head = [title ? `标题：${decodeEntities(title).replace(/\s+/g, " ").trim()}` : "", description ? `描述：${decodeEntities(description).replace(/\s+/g, " ").trim()}` : ""].filter(Boolean);
  return [...head, text].filter(Boolean).join("\n").slice(0, MAX_PAGE_TEXT);
}

export async function fetchPublic(raw: string): Promise<string> {
  let current = publicUrl(raw);
  if (!current) return "这个地址不能请求。";
  for (let hop = 0; hop < 3; hop += 1) {
    const response = await fetch(current, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(12_000),
      headers: { "User-Agent": "ocagent" },
    });
    if (response.status >= 300 && response.status < 400) {
      const next = response.headers.get("location");
      if (!next) return `HTTP ${response.status}，没有跳转地址。`;
      current = publicUrl(new URL(next, current).toString());
      if (!current) return "跳转目标不能请求。";
      continue;
    }
    const body = await response.text();
    const type = response.headers.get("content-type") ?? "";
    const text = looksLikeHtml(body, type) ? readablePage(body) : body.replace(/\s+/g, " ").trim().slice(0, MAX_PAGE_TEXT);
    return `HTTP ${response.status} ${current.hostname}\n${text || "（没有正文）"}`;
  }
  return "跳转太多次。";
}
