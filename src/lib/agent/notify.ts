import { publicUrl } from "./net.ts";

// Where a desk's messages go: one incoming-webhook address the user pastes in.
// The common chat tools each want a different JSON shape, told apart by host.

export type NotifyKind = "feishu" | "dingtalk" | "wecom" | "slack" | "discord" | "generic";

export const MAX_NOTIFY_TEXT = 1_500;
export const MAX_NOTIFY_URL = 600;

export function notifyKind(raw: string): NotifyKind {
  let host = "";
  try {
    host = new URL(raw).hostname.toLowerCase();
  } catch {
    return "generic";
  }
  if (host === "open.feishu.cn" || host === "open.larksuite.com" || host.endsWith(".feishu.cn") || host.endsWith(".larksuite.com")) return "feishu";
  if (host === "oapi.dingtalk.com" || host.endsWith(".dingtalk.com")) return "dingtalk";
  if (host === "qyapi.weixin.qq.com") return "wecom";
  if (host === "hooks.slack.com") return "slack";
  if (host === "discord.com" || host === "discordapp.com" || host.endsWith(".discord.com")) return "discord";
  return "generic";
}

export function notifyName(kind: NotifyKind): string {
  return { feishu: "飞书", dingtalk: "钉钉", wecom: "企业微信", slack: "Slack", discord: "Discord", generic: "通知地址" }[kind];
}

/** Checks a pasted address: a public http(s) URL, nothing else. Empty clears. */
export function checkNotifyUrl(raw: string): { ok: true; url: string } | { ok: false; error: string } {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: true, url: "" };
  if (trimmed.length > MAX_NOTIFY_URL) return { ok: false, error: "地址太长了。" };
  const url = publicUrl(trimmed);
  if (!url) return { ok: false, error: "要一个 https:// 开头的公网地址（飞书 / 钉钉 / 企业微信 / Slack 机器人的 webhook）。" };
  return { ok: true, url: url.toString() };
}

/** The request body each service expects for a plain text message. */
export function notifyPayload(kind: NotifyKind, text: string): unknown {
  const body = text.length > MAX_NOTIFY_TEXT ? `${text.slice(0, MAX_NOTIFY_TEXT - 1)}…` : text;
  switch (kind) {
    case "feishu":
      return { msg_type: "text", content: { text: body } };
    case "dingtalk":
    case "wecom":
      return { msgtype: "text", text: { content: body } };
    case "discord":
      return { content: body.slice(0, 1_900) };
    default:
      return { text: body };
  }
}

/**
 * Whether the service took the message. Feishu, DingTalk and WeCom answer
 * 200 with a code even when they refuse (keyword rules, bad token), so the
 * body decides when it carries one.
 */
export function notifyAccepted(status: number, body: string): { ok: true } | { ok: false; error: string } {
  let parsed: Record<string, unknown> | null = null;
  try {
    const value: unknown = JSON.parse(body);
    if (value && typeof value === "object") parsed = value as Record<string, unknown>;
  } catch {
    /* plain text reply */
  }
  if (parsed) {
    const code = ["code", "errcode", "StatusCode"].map((key) => parsed[key]).find((value) => typeof value === "number");
    if (typeof code === "number" && code !== 0) {
      const msg = ["msg", "errmsg", "message", "StatusMessage"].map((key) => parsed[key]).find((value) => typeof value === "string" && value) as string | undefined;
      return { ok: false, error: `对方拒收（${code}${msg ? `：${msg}` : ""}）。` };
    }
  }
  if (status >= 200 && status < 300) return { ok: true };
  return { ok: false, error: `HTTP ${status}${body.trim() ? `：${body.trim().slice(0, 160)}` : ""}` };
}

export type NotifySent = { ok: true; where: string } | { ok: false; where: string; error: string };

/** POSTs one text message to the desk's address. Never throws. */
export async function sendNotify(url: string, text: string): Promise<NotifySent> {
  const kind = notifyKind(url);
  const where = notifyName(kind);
  const target = publicUrl(url);
  if (!target) return { ok: false, where, error: "这个地址不能请求。" };
  try {
    const response = await fetch(target, {
      method: "POST",
      redirect: "manual",
      signal: AbortSignal.timeout(12_000),
      headers: { "User-Agent": "ocagent", "Content-Type": "application/json", Accept: "application/json, text/plain, */*" },
      body: JSON.stringify(notifyPayload(kind, text)),
    });
    const verdict = notifyAccepted(response.status, await response.text());
    return verdict.ok ? { ok: true, where } : { ok: false, where, error: verdict.error };
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    return { ok: false, where, error: name === "TimeoutError" ? "对方 12 秒没有回应。" : `发不出去（${err instanceof Error ? err.message : String(err)}）。` };
  }
}

/** The message a finished scheduled run sends: when, what, how it went, where to look. */
export function scheduleSummary(input: { when: string; task: string; status: string; answer: string; link: string }): string {
  const verdict = { done: "做完了", paused: "只做到一半", failed: "没做成", stopped: "停下了" }[input.status] ?? input.status;
  const answer = input.answer.replace(/\s+\n/g, "\n").trim();
  const shownAnswer = answer.length > 600 ? `${answer.slice(0, 599)}…` : answer;
  return [`【定时任务】${input.when} · ${verdict}`, `任务：${input.task.length > 200 ? `${input.task.slice(0, 199)}…` : input.task}`, shownAnswer ? `结果：${shownAnswer}` : "", input.link ? `工作区：${input.link}` : ""].filter(Boolean).join("\n");
}
