import nodemailer from "nodemailer";
import { Applicant } from "./types.js";

export function mailerFromEnv(env: NodeJS.ProcessEnv = process.env) {
  if (!env.SMTP_HOST || !env.SMTP_USER || !env.SMTP_PASS) return null;
  const port = Number(env.SMTP_PORT ?? 465);
  const transport = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port,
    secure: port === 465,
    auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
  });
  const from = env.SMTP_FROM ?? env.SMTP_USER;

  return {
    async sendApplication(a: Applicant, to: string, subject: string, body: string): Promise<void> {
      await transport.sendMail({
        from: `${a.firstName} ${a.lastName} <${from}>`,
        replyTo: a.email,
        to,
        subject,
        text: `${body}\n\n${a.phone}\n${[a.linkedin, a.github, a.portfolio].filter(Boolean).join("\n")}`,
        attachments: [{ path: a.cvPath, filename: `${a.firstName}-${a.lastName}-CV.pdf` }],
      });
    },
    async sendReport(to: string, subject: string, markdown: string): Promise<void> {
      await transport.sendMail({ from, to, subject, text: markdown });
    },
  };
}

export type Mailer = NonNullable<ReturnType<typeof mailerFromEnv>>;
