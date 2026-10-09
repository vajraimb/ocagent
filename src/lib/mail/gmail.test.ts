import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_BODY_BYTES,
  buildRfc822Message,
  decodeBase64Url,
  describeSendError,
  encodeBase64Url,
  encodeHeaderValue,
  readGmailConfig,
  readMailRequest,
  sendGmail,
  type GmailTransport,
} from "./gmail.ts";
import { bearerMatches, handleMailSend, handleMailStatus } from "./endpoint.ts";

const ENV = {
  GMAIL_CLIENT_ID: "id.apps.googleusercontent.com",
  GMAIL_CLIENT_SECRET: "secret",
  GMAIL_REFRESH_TOKEN: "1//refresh",
  GMAIL_SENDER: "owner@gmail.com",
};
const TOKEN = "t".repeat(32);

function recordingTransport(result = { id: "msg-1", threadId: "thr-1" }) {
  const calls: string[] = [];
  const transport: GmailTransport = async (raw) => {
    calls.push(raw);
    return result;
  };
  return { calls, transport };
}

test("readGmailConfig names every missing variable and trims the rest", () => {
  const missing = readGmailConfig({ GMAIL_CLIENT_ID: " ", GMAIL_SENDER: "a@b.co" });
  assert.deepEqual(missing, {
    ok: false,
    missing: ["GMAIL_CLIENT_ID", "GMAIL_CLIENT_SECRET", "GMAIL_REFRESH_TOKEN"],
  });
  const ok = readGmailConfig({ ...ENV, GMAIL_SENDER: " owner@gmail.com " });
  assert.equal(ok.ok, true);
  if (ok.ok) assert.equal(ok.config.sender, "owner@gmail.com");
});

test("readMailRequest validates recipients, subject, bodies and size", () => {
  assert.equal(readMailRequest(null).ok, false);
  assert.equal(readMailRequest({ to: "nobody", subject: "s", text: "t" }).ok, false);
  assert.equal(readMailRequest({ to: "a@b.co", subject: "  ", text: "t" }).ok, false);
  assert.equal(readMailRequest({ to: "a@b.co", subject: "s", text: "" }).ok, false);
  assert.equal(readMailRequest({ to: "a@b.co", subject: "s", text: "t", html: 5 }).ok, false);
  assert.equal(
    readMailRequest({
      to: Array.from({ length: 11 }, (_, i) => `u${i}@b.co`),
      subject: "s",
      text: "t",
    }).ok,
    false,
  );
  assert.equal(
    readMailRequest({ to: "a@b.co", subject: "s", text: "x".repeat(MAX_BODY_BYTES + 1) }).ok,
    false,
  );
  const ok = readMailRequest({
    to: ["A@b.co", " a@b.co ", "c@d.org"],
    subject: "Hi\r\nBcc: x@y.z",
    text: "hello",
    html: "",
  });
  assert.deepEqual(ok, {
    ok: true,
    request: { to: ["A@b.co", "c@d.org"], subject: "Hi Bcc: x@y.z", text: "hello" },
  });
});

test("base64url round-trips and header words encode non-ASCII", () => {
  const sample = "héllo 世界 ~~~>>>???";
  assert.equal(decodeBase64Url(encodeBase64Url(sample)), sample);
  assert.doesNotMatch(encodeBase64Url(Buffer.from([251, 255, 254])), /[+/=]/);
  assert.equal(encodeHeaderValue("plain subject"), "plain subject");
  assert.equal(
    encodeHeaderValue("主题"),
    `=?UTF-8?B?${Buffer.from("主题", "utf8").toString("base64")}?=`,
  );
});

test("buildRfc822Message emits plain text or multipart/alternative", () => {
  const date = new Date("2026-10-09T12:00:00Z");
  const plain = buildRfc822Message({
    from: "owner@gmail.com",
    to: ["a@b.co"],
    subject: "Report",
    text: "body",
    date,
  });
  assert.match(
    plain,
    /^From: owner@gmail\.com\r\nTo: a@b\.co\r\nSubject: Report\r\nDate: Fri, 09 Oct 2026 12:00:00 GMT\r\nMIME-Version: 1\.0\r\n/,
  );
  assert.match(
    plain,
    /Content-Type: text\/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\nYm9keQ==\r\n$/,
  );
  assert.doesNotMatch(plain, /multipart/);
  const rich = buildRfc822Message({
    from: "owner@gmail.com",
    to: ["a@b.co", "c@d.org"],
    subject: "Hi",
    text: "t",
    html: "<b>t</b>",
    date,
  });
  assert.match(rich, /To: a@b\.co, c@d\.org\r\n/);
  assert.match(rich, /Content-Type: multipart\/alternative; boundary="([^"]+)"/);
  const boundary = /boundary="([^"]+)"/.exec(rich)?.[1] ?? "";
  assert.equal(rich.split(`--${boundary}`).length, 4);
  assert.match(rich, /Content-Type: text\/html; charset=UTF-8/);
  assert.match(rich, new RegExp(`--${boundary}--\\r\\n$`));
});

test("sendGmail builds the message and hands the raw payload to the transport", async () => {
  const { calls, transport } = recordingTransport();
  const result = await sendGmail(
    {
      to: "friend@example.com",
      subject: "Weekly digest",
      text: "Hello there",
      html: "<p>Hello there</p>",
    },
    { env: ENV, transport, now: () => new Date("2026-10-09T12:00:00Z") },
  );
  assert.deepEqual(result, { ok: true, id: "msg-1", threadId: "thr-1" });
  assert.equal(calls.length, 1);
  const decoded = decodeBase64Url(calls[0]);
  assert.match(decoded, /^From: owner@gmail\.com\r\n/);
  assert.match(decoded, /To: friend@example\.com\r\n/);
  assert.match(decoded, /Subject: Weekly digest\r\n/);
  assert.match(decoded, /Message-ID: <[^>]+@gmail\.com>\r\n/);
  assert.ok(decoded.includes(Buffer.from("Hello there").toString("base64")));
  assert.ok(decoded.includes(Buffer.from("<p>Hello there</p>").toString("base64")));
  assert.match(decoded, /Content-Type: multipart\/alternative/);
});

test("sendGmail fails closed without configuration and never calls the transport", async () => {
  const { calls, transport } = recordingTransport();
  const result = await sendGmail(
    { to: "a@b.co", subject: "s", text: "t" },
    { env: { GMAIL_SENDER: "x@y.co" }, transport },
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, "not_configured");
    assert.match(result.message, /GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN/);
  }
  assert.equal(calls.length, 0);
});

test("sendGmail reports invalid input before touching Gmail and maps transport errors", async () => {
  const { calls, transport } = recordingTransport();
  const invalid = await sendGmail(
    { to: "not-an-address", subject: "s", text: "t" },
    { env: ENV, transport },
  );
  assert.equal(invalid.ok, false);
  if (!invalid.ok) assert.equal(invalid.code, "invalid_request");
  assert.equal(calls.length, 0);

  const failing: GmailTransport = async () => {
    throw Object.assign(new Error("invalid_grant"), { response: { status: 401 } });
  };
  const failed = await sendGmail(
    { to: "a@b.co", subject: "s", text: "t" },
    { env: ENV, transport: failing },
  );
  assert.equal(failed.ok, false);
  if (!failed.ok) {
    assert.equal(failed.code, "send_failed");
    assert.match(failed.message, /GMAIL_REFRESH_TOKEN/);
  }
  assert.match(
    describeSendError(Object.assign(new Error("x"), { response: { status: 403 } })),
    /gmail\.send scope/,
  );
  assert.match(describeSendError(new Error("socket hang up")), /socket hang up/);
});

test("bearerMatches needs the exact token", () => {
  assert.equal(bearerMatches(`Bearer ${TOKEN}`, TOKEN), true);
  assert.equal(bearerMatches(`bearer ${TOKEN}`, TOKEN), true);
  assert.equal(bearerMatches(`Bearer ${TOKEN}x`, TOKEN), false);
  assert.equal(bearerMatches(TOKEN, TOKEN), false);
  assert.equal(bearerMatches(null, TOKEN), false);
});

function post(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("http://app.test/api/mail/send", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

test("the endpoint is invisible until OCAGENT_MAIL_TOKEN is set", async () => {
  const { calls, transport } = recordingTransport();
  const response = await handleMailSend(
    post({ to: "a@b.co", subject: "s", text: "t" }, { authorization: "Bearer anything" }),
    { env: ENV, transport },
  );
  assert.equal(response.status, 404);
  const short = await handleMailSend(post({}, { authorization: "Bearer short" }), {
    env: { ...ENV, OCAGENT_MAIL_TOKEN: "short" },
    transport,
  });
  assert.equal(short.status, 404);
  assert.equal(calls.length, 0);
});

test("the endpoint rejects wrong or missing bearer tokens", async () => {
  const { calls, transport } = recordingTransport();
  const env = { ...ENV, OCAGENT_MAIL_TOKEN: TOKEN };
  const payload = { to: "a@b.co", subject: "s", text: "t" };
  assert.equal((await handleMailSend(post(payload), { env, transport })).status, 401);
  assert.equal(
    (
      await handleMailSend(post(payload, { authorization: `Bearer ${"u".repeat(32)}` }), {
        env,
        transport,
      })
    ).status,
    401,
  );
  assert.equal(calls.length, 0);
});

test("the endpoint sends with a valid bearer and maps failures to status codes", async () => {
  const { calls, transport } = recordingTransport();
  const env = { ...ENV, OCAGENT_MAIL_TOKEN: TOKEN };
  const auth = { authorization: `Bearer ${TOKEN}` };
  const ok = await handleMailSend(post({ to: "a@b.co", subject: "s", text: "t" }, auth), {
    env,
    transport,
  });
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { ok: true, id: "msg-1", threadId: "thr-1" });
  assert.equal(calls.length, 1);

  const bad = await handleMailSend(post("{not json", auth), { env, transport });
  assert.equal(bad.status, 400);
  const invalid = await handleMailSend(post({ to: "a@b.co", subject: "", text: "t" }, auth), {
    env,
    transport,
  });
  assert.equal(invalid.status, 400);
  const unconfigured = await handleMailSend(post({ to: "a@b.co", subject: "s", text: "t" }, auth), {
    env: { OCAGENT_MAIL_TOKEN: TOKEN },
    transport,
  });
  assert.equal(unconfigured.status, 503);
  const failing: GmailTransport = async () => {
    throw new Error("boom");
  };
  const upstream = await handleMailSend(post({ to: "a@b.co", subject: "s", text: "t" }, auth), {
    env,
    transport: failing,
  });
  assert.equal(upstream.status, 502);
  assert.equal(calls.length, 1);
});

test("the status probe reports configuration names, never values", async () => {
  const env = { ...ENV, OCAGENT_MAIL_TOKEN: TOKEN };
  const get = (headers: Record<string, string> = {}) =>
    new Request("http://app.test/api/mail/send", { headers });
  assert.equal(handleMailStatus(get(), { env }).status, 401);
  assert.equal(
    handleMailStatus(get({ authorization: `Bearer ${TOKEN}` }), {
      env: { OCAGENT_MAIL_TOKEN: TOKEN },
    }).status,
    200,
  );
  const body = await handleMailStatus(get({ authorization: `Bearer ${TOKEN}` }), { env }).json();
  assert.deepEqual(body, { ok: true, gmail: true, sender: "owner@gmail.com", missing: [] });
  const partial = await handleMailStatus(get({ authorization: `Bearer ${TOKEN}` }), {
    env: { OCAGENT_MAIL_TOKEN: TOKEN, GMAIL_SENDER: "o@g.com" },
  }).json();
  assert.deepEqual(partial.missing, [
    "GMAIL_CLIENT_ID",
    "GMAIL_CLIENT_SECRET",
    "GMAIL_REFRESH_TOKEN",
  ]);
  assert.equal(JSON.stringify(body).includes("secret"), false);
});
