/**
 * Gmail sending through the Gmail REST API (`users.messages.send`) with an
 * OAuth2 refresh token that belongs to the site owner.
 *
 * Pure module: no framework imports and no `@/` aliases, so it runs under
 * `node --experimental-strip-types --test` and the Google call stays behind the
 * `GmailTransport` seam that tests replace with a mock. The real transport
 * lives in `./google-transport.ts` and is loaded lazily on first send.
 */

import { randomBytes } from "node:crypto";

export const GMAIL_ENV_KEYS = [
  "GMAIL_CLIENT_ID",
  "GMAIL_CLIENT_SECRET",
  "GMAIL_REFRESH_TOKEN",
  "GMAIL_SENDER",
] as const;

export type GmailEnvKey = (typeof GMAIL_ENV_KEYS)[number];

export type GmailConfig = {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  /** The Gmail address the token belongs to; used as `From`. */
  sender: string;
};

export type MailRequest = {
  to: string[];
  subject: string;
  text: string;
  html?: string;
};

export type GmailTransportResult = { id: string; threadId?: string };

/** Sends one RFC 5322 message, already base64url-encoded, as the owner. */
export type GmailTransport = (raw: string) => Promise<GmailTransportResult>;

export type SendFailureCode = "not_configured" | "invalid_request" | "send_failed";

export type SendResult =
  | { ok: true; id: string; threadId?: string }
  | { ok: false; code: SendFailureCode; message: string };

export const MAX_RECIPIENTS = 10;
// Keeps an RFC 2047 encoded all-CJK subject under the 998-byte header line limit.
export const MAX_SUBJECT_CHARS = 200;
export const MAX_BODY_BYTES = 512 * 1024;

type EnvLike = Record<string, string | undefined>;

function trimmed(env: EnvLike, key: string): string {
  return env[key]?.trim() ?? "";
}

export function readGmailConfig(
  env: EnvLike = process.env,
): { ok: true; config: GmailConfig } | { ok: false; missing: GmailEnvKey[] } {
  const missing = GMAIL_ENV_KEYS.filter((key) => trimmed(env, key) === "");
  if (missing.length > 0) return { ok: false, missing };
  return {
    ok: true,
    config: {
      clientId: trimmed(env, "GMAIL_CLIENT_ID"),
      clientSecret: trimmed(env, "GMAIL_CLIENT_SECRET"),
      refreshToken: trimmed(env, "GMAIL_REFRESH_TOKEN"),
      sender: trimmed(env, "GMAIL_SENDER"),
    },
  };
}

// Deliberately strict: one mailbox, one domain with a dot, no display names,
// no whitespace. Anything fancier goes through `readMailRequest` as an error.
const EMAIL =
  /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

export function isEmailAddress(value: string): boolean {
  return value.length <= 254 && EMAIL.test(value);
}

function readRecipients(raw: unknown): { ok: true; to: string[] } | { ok: false; error: string } {
  const list = typeof raw === "string" ? [raw] : Array.isArray(raw) ? raw : null;
  if (!list || list.length === 0)
    return { ok: false, error: "to: at least one recipient address is required" };
  const to: string[] = [];
  for (const item of list) {
    if (typeof item !== "string")
      return { ok: false, error: "to: every recipient must be a string" };
    const address = item.trim();
    if (!isEmailAddress(address))
      return { ok: false, error: `to: "${address.slice(0, 80)}" is not an email address` };
    if (!to.some((seen) => seen.toLowerCase() === address.toLowerCase())) to.push(address);
  }
  if (to.length > MAX_RECIPIENTS)
    return { ok: false, error: `to: at most ${MAX_RECIPIENTS} recipients` };
  return { ok: true, to };
}

export function readMailRequest(
  input: unknown,
): { ok: true; request: MailRequest } | { ok: false; error: string } {
  if (typeof input !== "object" || input === null || Array.isArray(input))
    return { ok: false, error: "body must be a JSON object" };
  const body = input as Record<string, unknown>;
  const recipients = readRecipients(body.to);
  if (!recipients.ok) return recipients;
  if (typeof body.subject !== "string" || body.subject.trim() === "")
    return { ok: false, error: "subject: required" };
  const subject = body.subject.replace(/[\r\n\t]+/g, " ").trim();
  if (subject.length > MAX_SUBJECT_CHARS)
    return { ok: false, error: `subject: at most ${MAX_SUBJECT_CHARS} characters` };
  if (typeof body.text !== "string" || body.text.trim() === "")
    return { ok: false, error: "text: a plain-text body is required" };
  const text = body.text;
  let html: string | undefined;
  if (body.html !== undefined && body.html !== null) {
    if (typeof body.html !== "string")
      return { ok: false, error: "html: must be a string when present" };
    if (body.html.trim() !== "") html = body.html;
  }
  const bytes = Buffer.byteLength(text, "utf8") + (html ? Buffer.byteLength(html, "utf8") : 0);
  if (bytes > MAX_BODY_BYTES)
    return { ok: false, error: `body: at most ${MAX_BODY_BYTES} bytes of text and html combined` };
  return { ok: true, request: { to: recipients.to, subject, text, ...(html ? { html } : {}) } };
}

export function encodeBase64Url(value: string | Buffer): string {
  const buffer = typeof value === "string" ? Buffer.from(value, "utf8") : value;
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function decodeBase64Url(value: string): string {
  const padded =
    value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (value.length % 4)) % 4);
  return Buffer.from(padded, "base64").toString("utf8");
}

/** RFC 2047 encoded-word for header values that are not plain ASCII. */
export function encodeHeaderValue(value: string): string {
  if (/^[\x20-\x7e]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

function base64Lines(value: string): string {
  return Buffer.from(value, "utf8")
    .toString("base64")
    .replace(/(.{76})/g, "$1\r\n");
}

export function buildRfc822Message(
  message: MailRequest & { from: string; date?: Date; messageId?: string },
): string {
  const date = message.date ?? new Date();
  const headers = [
    `From: ${message.from}`,
    `To: ${message.to.join(", ")}`,
    `Subject: ${encodeHeaderValue(message.subject)}`,
    `Date: ${date.toUTCString()}`,
    "MIME-Version: 1.0",
  ];
  if (message.messageId) headers.push(`Message-ID: <${message.messageId}>`);
  const textPart = [
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    base64Lines(message.text),
  ];
  if (!message.html) return [...headers, ...textPart].join("\r\n") + "\r\n";
  const boundary = `=_ocagent_${randomBytes(12).toString("hex")}`;
  const htmlPart = [
    "Content-Type: text/html; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    base64Lines(message.html),
  ];
  return (
    [
      ...headers,
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      "",
      `--${boundary}`,
      ...textPart,
      `--${boundary}`,
      ...htmlPart,
      `--${boundary}--`,
    ].join("\r\n") + "\r\n"
  );
}

export function buildRawMessage(
  message: MailRequest & { from: string; date?: Date; messageId?: string },
): string {
  return encodeBase64Url(buildRfc822Message(message));
}

export type SendGmailOptions = {
  env?: EnvLike;
  /** Replaces the Google client (tests, dry runs). */
  transport?: GmailTransport;
  now?: () => Date;
};

export function describeSendError(error: unknown): string {
  const status =
    (error as { response?: { status?: number }; status?: number; code?: number | string } | null)
      ?.response?.status ?? (error as { status?: number } | null)?.status;
  const text = error instanceof Error ? error.message : String(error);
  if (status === 401 || /invalid_grant|invalid_client|unauthorized_client/i.test(text)) {
    return "Gmail rejected the credentials; re-check GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET and mint a new GMAIL_REFRESH_TOKEN with the gmail.send scope";
  }
  if (status === 403)
    return "Gmail refused the send (403): the OAuth client lacks the gmail.send scope or the Gmail API is not enabled on the project";
  if (status === 429) return "Gmail rate limit hit (429); try again later";
  return `Gmail send failed${status ? ` (${status})` : ""}: ${text.slice(0, 300)}`;
}

/**
 * Validate, build the MIME message, and send it as the owner. Never throws for
 * expected failures; callers branch on `result.ok`.
 */
export async function sendGmail(
  input: unknown,
  options: SendGmailOptions = {},
): Promise<SendResult> {
  const parsed = readMailRequest(input);
  if (!parsed.ok) return { ok: false, code: "invalid_request", message: parsed.error };
  const configured = readGmailConfig(options.env ?? process.env);
  if (!configured.ok) {
    return {
      ok: false,
      code: "not_configured",
      message: `Gmail sending is not configured; missing ${configured.missing.join(", ")}`,
    };
  }
  const { config } = configured;
  const transport = options.transport ?? (await loadGoogleTransport(config));
  const date = (options.now ?? (() => new Date()))();
  const messageId = `${date.getTime().toString(36)}.${randomBytes(8).toString("hex")}@${config.sender.split("@")[1] ?? "ocagent"}`;
  const raw = buildRawMessage({ ...parsed.request, from: config.sender, date, messageId });
  try {
    const sent = await transport(raw);
    return { ok: true, id: sent.id, ...(sent.threadId ? { threadId: sent.threadId } : {}) };
  } catch (error) {
    return { ok: false, code: "send_failed", message: describeSendError(error) };
  }
}

async function loadGoogleTransport(config: GmailConfig): Promise<GmailTransport> {
  const mod = await import("./google-transport.ts");
  return mod.createGoogleTransport(config);
}
