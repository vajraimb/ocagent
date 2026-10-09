// Server-side continuation of a paused run. After a segment pauses for time,
// the instance that ran it asks the app's own public address for the next
// one, so the run goes on whether or not a page is still watching. On Vercel,
// waitUntil keeps this function alive until the next one has answered; a
// local server has no such context, and the request simply runs in the
// background of the same process.

import { getRequestHeader } from "@tanstack/react-start/server";

/** The address this app is reachable at, from the request being served. */
export function selfOrigin(): string | null {
  const configured = process.env.OCAGENT_SELF_URL?.trim();
  if (configured) return configured.replace(/\/$/, "");
  try {
    const host = getRequestHeader("x-forwarded-host") ?? getRequestHeader("host");
    if (host) return originFor(host, getRequestHeader("x-forwarded-proto"));
  } catch {
    /* not inside a request */
  }
  const vercel = process.env.VERCEL_URL;
  return vercel ? `https://${vercel}` : null;
}

export function originFor(host: string, forwardedProto: string | null | undefined): string {
  const first = host.split(",")[0]?.trim() ?? host;
  const proto = forwardedProto?.split(",")[0]?.trim() || (/^(127\.0\.0\.1|localhost|\[::1\])(:|$)/.test(first) ? "http" : "https");
  return `${proto}://${first}`;
}

export async function selfContinue(runId: string, segment: number, origin: string | null): Promise<void> {
  if (!origin) return;
  const headers: Record<string, string> = { "content-type": "application/json" };
  const bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  if (bypass) headers["x-vercel-protection-bypass"] = bypass;
  const request = fetch(`${origin}/api/agent/continue`, {
    method: "POST",
    headers,
    body: JSON.stringify({ runId, segment }),
  })
    .then(() => undefined)
    .catch(() => undefined);
  try {
    const { waitUntil } = await import("@vercel/functions");
    waitUntil(request);
  } catch {
    /* no platform context: the request just runs in this process */
  }
}
