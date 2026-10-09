import { createFileRoute } from "@tanstack/react-router";
import { driveNextSegment, isRunId } from "@/lib/agent/run";

// The server's own way of carrying a paused run on: after a segment pauses for
// time, the instance that ran it asks this address for the next one, so the
// run keeps going whether or not a page is still watching. Run ids are
// unguessable, and a run that is not paused (or has moved past the segment
// named) is left alone, so a stray or repeated request does nothing.
export const Route = createFileRoute("/api/agent/continue")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        let body: Record<string, unknown> = {};
        try {
          const parsed: unknown = await request.json();
          if (parsed && typeof parsed === "object") body = parsed as Record<string, unknown>;
        } catch {
          return Response.json({ error: "请求不对" }, { status: 400 });
        }
        const runId = body.runId;
        if (!isRunId(runId)) return Response.json({ error: "任务编号不对。" }, { status: 400 });
        const segment = typeof body.segment === "number" && Number.isInteger(body.segment) && body.segment > 0 ? body.segment : null;
        const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
        const proto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() || (host && /^(127\.0\.0\.1|localhost)(:|$)/.test(host) ? "http" : "https");
        const origin = host ? `${proto}://${host.split(",")[0]?.trim()}` : null;
        try {
          const reply = await driveNextSegment(runId, segment, origin);
          return Response.json({ runId: reply.run.id, status: reply.run.status, segment: reply.run.segment });
        } catch (err) {
          return Response.json({ error: err instanceof Error ? err.message : "没有跑起来" }, { status: 409 });
        }
      },
    },
  },
});
