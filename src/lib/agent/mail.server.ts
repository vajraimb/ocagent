// The SMTP leg of mail notifications, kept out of the browser bundle: the
// server sends from the one mailbox the environment names (for Gmail, the
// address plus an app password).

import type { MailConfig, MailTransport } from "./notify.ts";

export async function smtpTransport(config: MailConfig): Promise<MailTransport> {
  const nodemailer = await import("nodemailer");
  const transporter = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.port === 465,
    auth: { user: config.user, pass: config.pass },
    connectionTimeout: 12_000,
    greetingTimeout: 12_000,
    socketTimeout: 20_000,
  });
  return async (message) => {
    await transporter.sendMail(message);
  };
}
