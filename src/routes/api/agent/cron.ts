import { createFileRoute } from "@tanstack/react-router";
import { originFor } from "@/lib/agent/drive.server";
import { runDueSchedules } from "@/lib/agent/run";

// Starts the schedules whose time has come. Vercel's daily cron calls this at
// 00:00 UTC (08:00 北京时间), a desk being opened pings it between ticks, and
// anything outside can call it too. Each schedule is claimed in one row
// update, so a burst of calls still starts each one once. When CRON_SECRET is
// set, callers have to carry it (Vercel's cron does so by itself).
async function tick(request: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET?.trim();
  if (secret && request.headers.get("authorization") !== `Bearer ${secret}`) {
    return Response.json({ error: "不对的口令" }, { status: 401 });
  }
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  const origin = host ? originFor(host, request.headers.get("x-forwarded-proto")) : null;
  try {
    const result = await runDueSchedules(origin);
    return Response.json(result);
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "没有跑起来" }, { status: 500 });
  }
}

export const Route = createFileRoute("/api/agent/cron")({
  server: {
    handlers: {
      GET: ({ request }) => tick(request),
      POST: ({ request }) => tick(request),
    },
  },
});
