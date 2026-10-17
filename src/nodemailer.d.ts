// The slice of nodemailer this app uses; the package ships no types and
// devDependencies are not installed on deploy.
declare module "nodemailer" {
  export type TransportOptions = {
    host: string;
    port: number;
    secure?: boolean;
    auth?: { user: string; pass: string };
    connectionTimeout?: number;
    greetingTimeout?: number;
    socketTimeout?: number;
  };
  export type MailOptions = { from: string; to: string; subject: string; text: string };
  export type Transporter = { sendMail(message: MailOptions): Promise<unknown> };
  export function createTransport(options: TransportOptions): Transporter;
  const nodemailer: { createTransport: typeof createTransport };
  export default nodemailer;
}
