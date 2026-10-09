import { auth, gmail } from "@googleapis/gmail";
import type { GmailConfig, GmailTransport } from "./gmail.ts";

/**
 * The real `GmailTransport`: Google's official Node client (`@googleapis/gmail`,
 * the per-API slice of `googleapis`). `google-auth-library` swaps the owner's
 * refresh token for a short-lived access token on every cold start and
 * refreshes it transparently afterwards; the message itself goes to
 * `POST https://gmail.googleapis.com/gmail/v1/users/me/messages/send`.
 *
 * Kept in its own module so unit tests never import the Google SDK.
 */
export function createGoogleTransport(config: GmailConfig): GmailTransport {
  const oauth2 = new auth.OAuth2({ clientId: config.clientId, clientSecret: config.clientSecret });
  oauth2.setCredentials({ refresh_token: config.refreshToken });
  const api = gmail({ version: "v1", auth: oauth2 });
  return async (raw) => {
    const response = await api.users.messages.send(
      { userId: "me", requestBody: { raw } },
      { timeout: 20_000 },
    );
    return {
      id: response.data.id ?? "",
      ...(response.data.threadId ? { threadId: response.data.threadId } : {}),
    };
  };
}
