#!/usr/bin/env node
/**
 * One-off helper the site owner runs ON THEIR OWN MACHINE to mint the
 * `GMAIL_REFRESH_TOKEN` the app needs. Nothing here runs in the deployed app.
 *
 *   GMAIL_CLIENT_ID=… GMAIL_CLIENT_SECRET=… node scripts/gmail-oauth-token.mjs
 *
 * It prints a Google consent URL (scope: gmail.send only), listens on
 * http://127.0.0.1:8787/oauth2callback for the redirect, exchanges the code,
 * and prints the refresh token once. The OAuth client must be of type
 * "Desktop app" so that loopback redirect URIs are accepted without
 * registration. Copy the printed values into the deployment's secrets; never
 * commit them.
 */
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

export const GMAIL_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send";
export const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
export const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
export const DEFAULT_PORT = 8787;

/**
 * @param {{ clientId: string; redirectUri: string; state: string }} input
 */
export function buildConsentUrl({ clientId, redirectUri, state }) {
  const url = new URL(AUTH_ENDPOINT);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", GMAIL_SEND_SCOPE);
  // `offline` + `consent` is what makes Google return a refresh token, and
  // return one again if the owner re-runs this later.
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("include_granted_scopes", "false");
  url.searchParams.set("state", state);
  return url.toString();
}

/**
 * @param {{ clientId: string; clientSecret: string; redirectUri: string; code: string; fetchImpl?: typeof fetch }} input
 * @returns {Promise<{ refreshToken: string; scope: string; expiresIn: number }>}
 */
export async function exchangeCode({
  clientId,
  clientSecret,
  redirectUri,
  code,
  fetchImpl = fetch,
}) {
  const body = new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
  });
  const response = await fetchImpl(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  /** @type {{ refresh_token?: string; scope?: string; expires_in?: number; error?: string; error_description?: string }} */
  const json = await response.json();
  if (!response.ok || json.error) {
    throw new Error(
      `token exchange failed: ${json.error ?? response.status}${json.error_description ? ` — ${json.error_description}` : ""}`,
    );
  }
  if (!json.refresh_token) {
    throw new Error(
      "Google returned no refresh_token. Revoke the app at https://myaccount.google.com/permissions and run again.",
    );
  }
  const scope = json.scope ?? "";
  if (!scope.split(/\s+/).includes(GMAIL_SEND_SCOPE)) {
    throw new Error(
      `granted scope "${scope}" does not include ${GMAIL_SEND_SCOPE}; approve the send permission on the consent screen.`,
    );
  }
  return { refreshToken: json.refresh_token, scope, expiresIn: json.expires_in ?? 0 };
}

/**
 * @param {string[]} argv
 * @param {Record<string, string | undefined>} env
 */
export function readOptions(argv, env) {
  const flags = new Map();
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (!item.startsWith("--")) continue;
    const [key, inline] = item.slice(2).split("=", 2);
    flags.set(key, inline ?? argv[++i] ?? "");
  }
  const clientId = (flags.get("client-id") ?? env.GMAIL_CLIENT_ID ?? "").trim();
  const clientSecret = (flags.get("client-secret") ?? env.GMAIL_CLIENT_SECRET ?? "").trim();
  const port = Number(flags.get("port") ?? env.GMAIL_OAUTH_PORT ?? DEFAULT_PORT);
  if (!clientId || !clientSecret) {
    throw new Error(
      "set GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET (or pass --client-id / --client-secret)",
    );
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error(`bad port: ${String(port)}`);
  return { clientId, clientSecret, port };
}

async function main() {
  const { clientId, clientSecret, port } = readOptions(process.argv.slice(2), process.env);
  const redirectUri = `http://127.0.0.1:${port}/oauth2callback`;
  const state = randomBytes(16).toString("hex");

  const result = await new Promise((resolve, reject) => {
    const server = createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", redirectUri);
      if (url.pathname !== "/oauth2callback") {
        res.writeHead(404).end("not found");
        return;
      }
      const finish = (status, text) => {
        res.writeHead(status, { "content-type": "text/plain; charset=utf-8" }).end(text);
        server.close();
      };
      if (url.searchParams.get("state") !== state)
        return finish(400, "state mismatch; run the script again.");
      const error = url.searchParams.get("error");
      if (error) return (finish(400, `Google returned: ${error}`), reject(new Error(error)));
      const code = url.searchParams.get("code");
      if (!code) return finish(400, "no code in callback");
      try {
        const tokens = await exchangeCode({ clientId, clientSecret, redirectUri, code });
        finish(200, "Refresh token issued. You can close this tab and return to the terminal.");
        resolve(tokens);
      } catch (err) {
        finish(500, err instanceof Error ? err.message : String(err));
        reject(err);
      }
    });
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      process.stderr.write(
        [
          "",
          "1. Open this URL in a browser, signed in as the Gmail account that will send mail:",
          "",
          `   ${buildConsentUrl({ clientId, redirectUri, state })}`,
          "",
          `2. Approve the single "Send email on your behalf" permission. Google redirects to ${redirectUri}.`,
          "",
          "Waiting for the redirect…",
          "",
        ].join("\n"),
      );
    });
  });

  process.stdout.write(
    [
      "",
      "# Add these to the deployment's environment variables / secrets.",
      "# GMAIL_SENDER must be the address of the account you just approved.",
      `GMAIL_CLIENT_ID=${clientId}`,
      "GMAIL_CLIENT_SECRET=<the client secret you already have>",
      `GMAIL_REFRESH_TOKEN=${result.refreshToken}`,
      "GMAIL_SENDER=<the approved Gmail address>",
      "",
    ].join("\n"),
  );
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((err) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
