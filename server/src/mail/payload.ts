import { z } from 'zod';

/** The only headers a template may add (E3's unsubscribe headers, RFC 8058); the transport drops others. */
export const MAIL_HEADER_NAMES = ['List-Unsubscribe', 'List-Unsubscribe-Post'] as const;
export type MailHeaderName = (typeof MAIL_HEADER_NAMES)[number];
export type MailHeaders = Partial<Record<MailHeaderName, string>>;

/** What a template renders: the subject, the HTML and text parts, and optional headers. */
export interface RenderedMail {
  subject: string;
  html: string;
  text: string;
  headers?: MailHeaders;
}

/** The stored body of a pending message (`payload_enc`, encrypted). */
export const mailPayloadSchema = z.strictObject({
  html: z.string(),
  text: z.string(),
  headers: z
    .strictObject(
      Object.fromEntries(MAIL_HEADER_NAMES.map((name) => [name, z.string().optional()])) as Record<
        MailHeaderName,
        z.ZodOptional<z.ZodString>
      >,
    )
    .optional(),
});
export type MailPayload = z.infer<typeof mailPayloadSchema>;
