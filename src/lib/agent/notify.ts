import { publicUrl } from "./net.ts";

// Where a desk's messages go: one address the user pastes in — an incoming
// webhook (the common chat tools each want a different JSON shape, told apart
// by host) or a `mailto:` address, sent from the mailbox the server is
// configured with.

export type NotifyKind = "feishu" | "dingtalk" | "wecom" | "slack" | "discord" | "generic" | "email";

export const MAX_NOTIFY_TEXT = 1_500;
export const MAX_NOTIFY_URL = 600;
const MAX_MAIL_TEXT = 20_000;

const EMAIL = /^[^\s@<>()[\],;:"]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/i;

/** The bare address of a `mailto:` notify target, or null for a webhook. */
export function mailAddress(raw: string): string | null {
  const trimmed = raw.trim();
  if (!/^mailto:/i.test(trimmed)) return null;
  const address = decodeURIComponent(trimmed.slice(7).split("?")[0] ?? "").trim();
  return EMAIL.test(address) ? address : null;
}

export function notifyKind(raw: string): NotifyKind {
  if (/^mailto:/i.test(raw.trim())) return "email";
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
  return { feishu: "飞书", dingtalk: "钉钉", wecom: "企业微信", slack: "Slack", discord: "Discord", generic: "通知地址", email: "邮箱" }[kind];
}

/**
 * Checks a pasted address: an email (bare or `mailto:`), or a public http(s)
 * URL. Empty clears. Emails are stored as `mailto:user@host`.
 */
export function checkNotifyUrl(raw: string): { ok: true; url: string } | { ok: false; error: string } {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: true, url: "" };
  if (trimmed.length > MAX_NOTIFY_URL) return { ok: false, error: "地址太长了。" };
  const bare = trimmed.replace(/^mailto:/i, "").trim();
  if (EMAIL.test(bare)) {
    const at = bare.lastIndexOf("@");
    return { ok: true, url: `mailto:${bare.slice(0, at)}@${bare.slice(at + 1).toLowerCase()}` };
  }
  if (/^mailto:/i.test(trimmed) || (bare.includes("@") && !/^https?:/i.test(trimmed))) return { ok: false, error: "邮箱地址不对，要像 name@gmail.com 这样。" };
  const url = publicUrl(trimmed);
  if (!url) return { ok: false, error: "要一个邮箱地址，或 https:// 开头的公网地址（飞书 / 钉钉 / 企业微信 / Slack 机器人的 webhook）。" };
  return { ok: true, url: url.toString() };
}

// ---------------------------------------------------------------------------
// Mail. The server sends from one mailbox given in the environment — for
// Gmail, the address plus an app password (not the login password). Nothing
// about it is stored with a desk; a desk only names the recipient.

export type MailConfig = { host: string; port: number; user: string; pass: string };

export const MAIL_USER_VAR = "NOTIFY_MAIL_USER";
export const MAIL_PASS_VAR = "NOTIFY_MAIL_PASS";

export function mailConfig(env: Record<string, string | undefined> = typeof process === "undefined" ? {} : process.env): MailConfig | null {
  const user = env[MAIL_USER_VAR]?.trim() ?? "";
  // Google shows app passwords in groups of four with spaces; both forms work.
  const pass = (env[MAIL_PASS_VAR] ?? "").replace(/\s+/g, "");
  if (!user || !pass) return null;
  const host = env.NOTIFY_MAIL_HOST?.trim() || "smtp.gmail.com";
  const port = Number(env.NOTIFY_MAIL_PORT) || 465;
  return { host, port, user, pass };
}

/** True when the server can send mail (the panel says so before a test send). */
export function mailReady(): boolean {
  return mailConfig() !== null;
}

export const MAIL_UNSET = `服务器还没配发件邮箱：在部署设置里加 ${MAIL_USER_VAR}（发件的 Gmail 地址）和 ${MAIL_PASS_VAR}（它的应用专用密码，不是登录密码），重新发布后就能发。`;

export type MailMessage = { from: string; to: string; subject: string; text: string };
export type MailTransport = (message: MailMessage) => Promise<void>;

/** The subject line: the first line of the text, short. */
export function mailSubject(text: string): string {
  const first = text.split("\n").map((line) => line.trim()).find(Boolean) ?? "ocagent 的消息";
  const subject = first.length > 80 ? `${first.slice(0, 79)}…` : first;
  return /ocagent/i.test(subject) ? subject : `${subject} · ocagent`;
}

function mailError(err: unknown): string {
  const code = err && typeof err === "object" && "code" in err ? String((err as { code?: unknown }).code ?? "") : "";
  const message = err instanceof Error ? err.message : String(err);
  if (code === "EAUTH" || /535|Username and Password not accepted|Invalid login/i.test(message)) return "发件邮箱不接受这个账号或应用专用密码：确认两步验证已开、密码是 16 位应用专用密码。";
  if (code === "ETIMEDOUT" || code === "ECONNECTION" || /timeout|ECONNREFUSED|ENOTFOUND/i.test(message)) return "连不上发件服务器。";
  if (/5\d\d.*(recipient|address)/i.test(message)) return "收件地址被拒收。";
  return `发不出去（${message.slice(0, 160)}）。`;
}

/** Sends one plain-text mail to `to` from the configured mailbox. Never throws. */
export async function sendMail(to: string, text: string, config: MailConfig | null = mailConfig(), transport?: MailTransport): Promise<NotifySent> {
  const where = notifyName("email");
  if (!config) return { ok: false, where, error: MAIL_UNSET };
  const body = text.length > MAX_MAIL_TEXT ? `${text.slice(0, MAX_MAIL_TEXT - 1)}…` : text;
  try {
    const send = transport ?? (await (await import("./mail.server.ts")).smtpTransport(config));
    await send({ from: config.user, to, subject: mailSubject(body), text: body });
    return { ok: true, where };
  } catch (err) {
    return { ok: false, where, error: mailError(err) };
  }
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

/** Sends one text message to the desk's address — a webhook POST, or a mail. Never throws. */
export async function sendNotify(url: string, text: string): Promise<NotifySent> {
  const kind = notifyKind(url);
  const where = notifyName(kind);
  if (kind === "email") {
    const to = mailAddress(url);
    return to ? sendMail(to, text) : { ok: false, where, error: "邮箱地址不对。" };
  }
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
