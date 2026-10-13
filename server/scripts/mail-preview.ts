import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { LOGO_CID, LOGO_PNG_BASE64 } from '../src/mail/assets/logo';
import { sampleMails } from '../src/mail/templates/samples';

/**
 * Writes every message and variant with sample data to .tmp/mail-preview/<name>.html and .txt
 * (git-ignored), the logo inlined as a data URI for the preview only (messages attach it by cid).
 */
const OUT = fileURLToPath(new URL('../../.tmp/mail-preview/', import.meta.url));
mkdirSync(OUT, { recursive: true });
for (const { name, mail } of sampleMails()) {
  writeFileSync(
    `${OUT}${name}.html`,
    mail.html.replaceAll(`cid:${LOGO_CID}`, `data:image/png;base64,${LOGO_PNG_BASE64}`),
  );
  writeFileSync(`${OUT}${name}.txt`, `Subject: ${mail.subject}\n\n${mail.text}`);
}
process.stdout.write(`wrote ${sampleMails().length} previews to ${OUT}\n`);
