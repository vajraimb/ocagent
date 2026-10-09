import { createHash, timingSafeEqual } from "node:crypto";
import { readGmailConfig, sendGmail, type SendGmailOptions, type SendResult } from "./gmail.ts";

/**
 * `POST /api/mail/send` — the HTTP face of `sendGmail` for the owner's own
 * automations. It is **not** a public form: every call must carry
 * `Authorization: Bearer <OCAGENT_MAIL_TOKEN>`. Without that secret in the
 * environment the route answers 404 and nothing can send mail, so the public
 * site never exposes the mailbox even when the Gmail secrets are present.
 */

export const MAIL_TOKEN_ENV = "OCAGENT_MAIL_TOKEN";
const MIN_TOKEN_CHARS = 24;
const MAX_REQUEST_BYTES = 768 * 1024;

type EnvLike = Record<string, string | undefined>;

export type MailEndpointDeps = {
  env?: EnvLike;
  send?: (input: unknown, options: SendGmailOptions) => Promise<SendResult>;
  transport?: SendGmailOptions["transport"];
};

function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

export function bearerMatches(header: string | null, expected: string): boolean {
  if (!header) return false;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
  if (!match) return false;
  return timingSafeEqual(digest(match[1]), digest(expected));
}

export function mailEndpointEnabled(env: EnvLike = process.env): boolean {
  return (env[MAIL_TOKEN_ENV]?.trim().length ?? 0) >= MIN_TOKEN_CHARS;
}

export async function handleMailSend(
  request: Request,
  deps: MailEndpointDeps = {},
): Promise<Response> {
  const env = deps.env ?? process.env;
  const token = env[MAIL_TOKEN_ENV]?.trim() ?? "";
  if (token.length < MIN_TOKEN_CHARS) return json(404, { ok: false, error: "not_found" });
  if (!bearerMatches(request.headers.get("authorization"), token)) {
    return json(401, { ok: false, error: "unauthorized" });
  }
  if (request.method !== "POST") return json(405, { ok: false, error: "method_not_allowed" });
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_REQUEST_BYTES)
    return json(413, { ok: false, error: "payload_too_large" });
  let body: unknown;
  try {
    const text = await request.text();
    if (Buffer.byteLength(text, "utf8") > MAX_REQUEST_BYTES)
      return json(413, { ok: false, error: "payload_too_large" });
    body = JSON.parse(text);
  } catch {
    return json(400, { ok: false, error: "invalid_request", message: "body must be JSON" });
  }
  const send = deps.send ?? sendGmail;
  const result = await send(body, { env, transport: deps.transport });
  if (result.ok)
    return json(200, {
      ok: true,
      id: result.id,
      ...(result.threadId ? { threadId: result.threadId } : {}),
    });
  const status =
    result.code === "invalid_request" ? 400 : result.code === "not_configured" ? 503 : 502;
  return json(status, { ok: false, error: result.code, message: result.message });
}

/**
 * `GET /api/mail/send` with the same bearer: tells the owner whether the Gmail
 * secrets are all present (names only, never values) so a deploy can be
 * checked without sending a real message.
 */
export function handleMailStatus(
  request: Request,
  deps: Pick<MailEndpointDeps, "env"> = {},
): Response {
  const env = deps.env ?? process.env;
  const token = env[MAIL_TOKEN_ENV]?.trim() ?? "";
  if (token.length < MIN_TOKEN_CHARS) return json(404, { ok: false, error: "not_found" });
  if (!bearerMatches(request.headers.get("authorization"), token)) {
    return json(401, { ok: false, error: "unauthorized" });
  }
  const configured = readGmailConfig(env);
  return json(200, {
    ok: true,
    gmail: configured.ok,
    sender: configured.ok ? configured.config.sender : null,
    missing: configured.ok ? [] : configured.missing,
  });
}
