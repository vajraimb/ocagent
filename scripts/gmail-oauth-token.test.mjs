import assert from "node:assert/strict";
import test from "node:test";
import {
  GMAIL_SEND_SCOPE,
  TOKEN_ENDPOINT,
  buildConsentUrl,
  exchangeCode,
  readOptions,
} from "./gmail-oauth-token.mjs";

test("consent url asks for gmail.send only and forces a refresh token", () => {
  const url = new URL(
    buildConsentUrl({
      clientId: "cid",
      redirectUri: "http://127.0.0.1:8787/oauth2callback",
      state: "s1",
    }),
  );
  assert.equal(url.origin + url.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
  assert.equal(url.searchParams.get("client_id"), "cid");
  assert.equal(url.searchParams.get("scope"), GMAIL_SEND_SCOPE);
  assert.equal(url.searchParams.get("access_type"), "offline");
  assert.equal(url.searchParams.get("prompt"), "consent");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("state"), "s1");
});

test("exchangeCode posts the grant and returns the refresh token", async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, init });
    return new Response(
      JSON.stringify({
        refresh_token: "1//r",
        scope: `${GMAIL_SEND_SCOPE} openid`,
        expires_in: 3599,
      }),
      { status: 200 },
    );
  };
  const tokens = await exchangeCode({
    clientId: "cid",
    clientSecret: "cs",
    redirectUri: "http://127.0.0.1:8787/oauth2callback",
    code: "abc",
    fetchImpl,
  });
  assert.deepEqual(tokens, {
    refreshToken: "1//r",
    scope: `${GMAIL_SEND_SCOPE} openid`,
    expiresIn: 3599,
  });
  assert.equal(seen[0].url, TOKEN_ENDPOINT);
  const body = new URLSearchParams(seen[0].init.body);
  assert.equal(body.get("grant_type"), "authorization_code");
  assert.equal(body.get("code"), "abc");
  assert.equal(body.get("client_secret"), "cs");
});

test("exchangeCode explains Google errors, missing tokens and missing scope", async () => {
  const reply = (status, json) => async () => new Response(JSON.stringify(json), { status });
  const base = {
    clientId: "cid",
    clientSecret: "cs",
    redirectUri: "http://127.0.0.1:8787/oauth2callback",
    code: "abc",
  };
  await assert.rejects(
    exchangeCode({
      ...base,
      fetchImpl: reply(400, { error: "invalid_grant", error_description: "Bad Request" }),
    }),
    /invalid_grant — Bad Request/,
  );
  await assert.rejects(
    exchangeCode({ ...base, fetchImpl: reply(200, { scope: GMAIL_SEND_SCOPE }) }),
    /no refresh_token/,
  );
  await assert.rejects(
    exchangeCode({ ...base, fetchImpl: reply(200, { refresh_token: "r", scope: "openid" }) }),
    /does not include/,
  );
});

test("readOptions takes flags over env and rejects missing credentials", () => {
  assert.deepEqual(readOptions(["--client-id", "a", "--client-secret=b", "--port", "9999"], {}), {
    clientId: "a",
    clientSecret: "b",
    port: 9999,
  });
  assert.deepEqual(readOptions([], { GMAIL_CLIENT_ID: "x", GMAIL_CLIENT_SECRET: "y" }), {
    clientId: "x",
    clientSecret: "y",
    port: 8787,
  });
  assert.throws(() => readOptions([], { GMAIL_CLIENT_ID: "x" }), /GMAIL_CLIENT_SECRET/);
  assert.throws(
    () => readOptions(["--port", "0"], { GMAIL_CLIENT_ID: "x", GMAIL_CLIENT_SECRET: "y" }),
    /bad port/,
  );
});
