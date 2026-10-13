import { LOGO_CID } from '../assets/logo';
import { html, raw, type SafeHtml } from './html';
import { htmlToText, wrapText } from './text';

export type BadgeTone = 'info' | 'warn' | 'bad' | 'ok';

/** A link of the footer, after the reason line (E3: "Stop watching this project"). */
export interface FooterLink {
  label: string;
  url: string;
}

export interface LayoutInput {
  /** The hidden line mail clients show after the subject. */
  preheader: string;
  title: string;
  badge?: { text: string; tone: BadgeTone };
  intro: SafeHtml;
  facts?: readonly (readonly [label: string, value: string])[];
  /** The button; `url` null (no QUALOR_PUBLIC_URL): `fallbackText` says where to go instead. */
  cta?: { label: string; url: string | null; fallbackText: string };
  after?: SafeHtml;
  /** Why the reader gets the message: the footer's first line. */
  reason: string;
  /**
   * Links after the reason line (E3: "Stop watching this project", "Notification settings"); a URL
   * that is not http(s) is left out. Without QUALOR_PUBLIC_URL a caller passes none.
   */
  footerLinks?: readonly FooterLink[];
  /** QUALOR_PUBLIC_URL's host for the header, or null. */
  instanceHost: string | null;
}

/** Fixed markup: a font stack with quotes, never data (raw() is for this file only). */
const FONT = raw(
  `'Schibsted Grotesk', system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif`,
);

const BADGE: Readonly<Record<BadgeTone, { background: string; color: string }>> = {
  info: { background: '#e8effa', color: '#1f5fbf' },
  warn: { background: '#fcf0d6', color: '#8a5a00' },
  bad: { background: '#fbe7e5', color: '#b3261e' },
  ok: { background: '#e0f3ea', color: '#157a51' },
};

const HTTP_URL = /^https?:\/\/[^\s"<>]+$/;

/**
 * E1 spec, direction A: an ink-navy header with the logo and the instance host, a white card
 * (badge, title, intro, facts, button), and a muted footer saying why the reader gets it. Tables
 * and inline styles only, 560 px, light only. The text part says the same in plain text.
 */
export function renderLayout(input: LayoutInput): { html: string; text: string } {
  const url =
    input.cta && input.cta.url !== null && HTTP_URL.test(input.cta.url) ? input.cta.url : null;
  const badge = input.badge
    ? html`<tr><td style="padding:0 0 12px"><span style="display:inline-block;padding:3px 10px;border-radius:999px;background:${BADGE[input.badge.tone].background};color:${BADGE[input.badge.tone].color};font-family:${FONT};font-size:12px;font-weight:600;line-height:18px">${input.badge.text}</span></td></tr>`
    : null;
  const facts =
    input.facts && input.facts.length > 0
      ? html`<tr><td style="padding:16px 0 0"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f0f4fa;border-radius:8px">${input.facts.map(
          ([label, value]) =>
            html`<tr><td style="padding:8px 14px;width:38%;vertical-align:top;font-family:${FONT};font-size:13px;color:#4a5b73">${label}</td><td style="padding:8px 14px;vertical-align:top;font-family:${FONT};font-size:13px;color:#0a1b33;word-break:break-word">${value}</td></tr>`,
        )}</table></td></tr>`
      : null;
  const cta =
    input.cta === undefined
      ? null
      : url !== null
        ? html`<tr><td style="padding:24px 0 0"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td bgcolor="#1f5fbf" style="background:#1f5fbf;border-radius:8px;padding:12px 22px"><a href="${url}" style="display:inline-block;font-family:${FONT};font-size:14px;font-weight:600;line-height:20px;color:#ffffff;text-decoration:none">${input.cta.label}</a></td></tr></table><p style="margin:12px 0 0;font-family:${FONT};font-size:12px;line-height:1.5;color:#4a5b73;word-break:break-all">Or open: <a href="${url}" style="color:#1f5fbf">${url}</a></p></td></tr>`
        : html`<tr><td style="padding:20px 0 0;font-family:${FONT};font-size:14px;line-height:1.6;color:#33455f">${input.cta.fallbackText}</td></tr>`;
  const after = input.after
    ? html`<tr><td style="padding:20px 0 0;font-family:${FONT};font-size:14px;line-height:1.6;color:#33455f">${input.after}</td></tr>`
    : null;
  const links = footerLinks(input);
  const footer =
    links.length > 0
      ? html`<br>${links.map(
          (link, i) =>
            html`${i > 0 ? ' · ' : ''}<a href="${link.url}" style="color:#1f5fbf">${link.label}</a>`,
        )}`
      : null;
  const page = html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>${input.title}</title>
</head>
<body style="margin:0;padding:0;background:#eef2f7">
<span style="display:none;font-size:1px;line-height:1px;color:#eef2f7;max-height:0;max-width:0;opacity:0;overflow:hidden">${input.preheader}</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#eef2f7">
<tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" style="width:560px;max-width:100%">
<tr><td style="background:#0a1b33;padding:14px 24px;border-radius:12px 12px 0 0">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
<td style="vertical-align:middle"><img src="cid:${LOGO_CID}" width="28" height="28" alt="Qualor" style="display:inline-block;width:28px;height:28px;border:0;vertical-align:middle"><span style="padding-left:10px;font-family:${FONT};font-size:16px;font-weight:700;color:#e6eefa;vertical-align:middle">Qualor</span></td>
<td align="right" style="vertical-align:middle;font-family:${FONT};font-size:12px;color:#b4c6e0">${input.instanceHost ?? ''}</td>
</tr></table>
</td></tr>
<tr><td style="background:#ffffff;border:1px solid #d7e0ec;border-top:0;border-radius:0 0 12px 12px;padding:28px 24px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
${badge}
<tr><td><h1 style="margin:0;font-family:${FONT};font-size:22px;line-height:1.3;font-weight:700;color:#0a1b33">${input.title}</h1></td></tr>
<tr><td style="padding:12px 0 0;font-family:${FONT};font-size:14px;line-height:1.6;color:#33455f">${input.intro}</td></tr>
${facts}
${cta}
${after}
</table>
</td></tr>
<tr><td style="padding:16px 24px;font-family:${FONT};font-size:12px;line-height:1.5;color:#4a5b73">${input.reason}${footer}<br>Sent by Qualor · <a href="https://qualor.dev" style="color:#4a5b73">qualor.dev</a></td></tr>
</table>
</td></tr>
</table>
</body>
</html>
`;
  return { html: page.toString(), text: textPart(input, url) };
}

/** The footer links whose URL is http(s). */
function footerLinks(input: LayoutInput): readonly FooterLink[] {
  return (input.footerLinks ?? []).filter((link) => HTTP_URL.test(link.url));
}

/**
 * Title, intro, facts as `Label: value`, the URL alone on its line, then `--`, the reason and a
 * `Label: URL` line per footer link.
 */
function textPart(input: LayoutInput, url: string | null): string {
  const blocks: string[] = [wrapText(input.title), wrapText(htmlToText(input.intro))];
  if (input.facts && input.facts.length > 0) {
    blocks.push(input.facts.map(([label, value]) => wrapText(`${label}: ${value}`)).join('\n'));
  }
  if (input.cta) {
    blocks.push(url !== null ? `${input.cta.label}:\n${url}` : wrapText(input.cta.fallbackText));
  }
  if (input.after) blocks.push(wrapText(htmlToText(input.after)));
  const links = footerLinks(input).map((link) => `${link.label}: ${link.url}\n`);
  blocks.push(`--\n${wrapText(input.reason)}\n${links.join('')}Sent by Qualor · qualor.dev`);
  return `${blocks.join('\n\n')}\n`;
}
