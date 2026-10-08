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
    const text = (await response.text()).replace(/\s+/g, " ").trim().slice(0, 3500);
    return `HTTP ${response.status} ${current.hostname}\n${text || "（没有正文）"}`;
  }
  return "跳转太多次。";
}
