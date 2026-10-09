import { createFileRoute } from "@tanstack/react-router";

/**
 * Owner-only mail endpoint. Both methods require
 * `Authorization: Bearer <OCAGENT_MAIL_TOKEN>`; see `src/lib/mail/endpoint.ts`
 * and the "Sending email through Gmail" section of the README.
 */
export const Route = createFileRoute("/api/mail/send")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const { handleMailStatus } = await import("@/lib/mail/endpoint");
        return handleMailStatus(request);
      },
      POST: async ({ request }) => {
        const { handleMailSend } = await import("@/lib/mail/endpoint");
        return handleMailSend(request);
      },
    },
  },
});
