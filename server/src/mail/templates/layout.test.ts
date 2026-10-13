import { describe, expect, it } from 'vitest';
import { html } from './html';
import { renderLayout, type LayoutInput } from './layout';

const base: LayoutInput = {
  preheader: 'A short preview',
  title: 'Title <x>',
  intro: html`<p style="margin:0">Hello ${'Ada & <Co>'}.</p>`,
  reason: 'You get this because of <reasons>.',
  instanceHost: 'qualor.example.com',
};

describe('renderLayout (E1 spec, direction A)', () => {
  it('builds the light-only, table-based 560 px layout with the logo by cid', () => {
    const { html: page } = renderLayout(base);
    expect(page).toMatch(/^<!doctype html>/);
    expect(page).toContain('<html lang="en">');
    expect(page).toContain('<meta name="color-scheme" content="light">');
    expect(page).toContain('<meta name="supported-color-schemes" content="light">');
    expect(page).toContain('src="cid:logo@qualor"');
    expect(page).toMatch(/<img [^>]*alt="Qualor"/);
    expect(page).toContain('width="560"');
    expect(page).toContain('background:#0a1b33');
    expect(page).toContain('border:1px solid #d7e0ec');
    expect(page).toContain('Sent by Qualor');
    expect(page).not.toMatch(
      /<svg|<link |@import|https?:\/\/(?!qualor\.dev)[^"]*\.(png|jpe?g|gif|svg)/i,
    );
    for (const table of page.match(/<table[^>]*>/g) ?? [])
      expect(table).toContain('role="presentation"');
  });

  it('escapes the title, preheader, facts, badge and reason', () => {
    const { html: page } = renderLayout({
      ...base,
      preheader: '<pre>',
      badge: { text: '<warn>', tone: 'warn' },
      facts: [['<label>', 'a & b']],
    });
    expect(page).toContain('Title &lt;x&gt;');
    expect(page).toContain('Hello Ada &amp; &lt;Co&gt;.');
    expect(page).toContain('&lt;pre&gt;');
    expect(page).toContain('&lt;warn&gt;');
    expect(page).toContain('background:#fcf0d6');
    expect(page).toContain('&lt;label&gt;');
    expect(page).toContain('a &amp; b');
    expect(page).toContain('because of &lt;reasons&gt;.');
  });

  it('draws the bulletproof button and the link under it', () => {
    const url = 'https://qualor.example.com/settings/license';
    const { html: page } = renderLayout({
      ...base,
      cta: {
        label: 'Open licence settings',
        url,
        fallbackText: 'Open Settings → Licence in Qualor.',
      },
    });
    // The cell carries the background; the link carries the padding as borders of the same
    // colour, so the whole button is clickable (Outlook and Gmail alike).
    expect(page).toContain('<td bgcolor="#1f5fbf" style="background:#1f5fbf;border-radius:8px">');
    expect(page).toContain(
      'border-top:12px solid #1f5fbf;border-bottom:12px solid #1f5fbf;border-left:22px solid #1f5fbf;border-right:22px solid #1f5fbf',
    );
    expect(page.match(new RegExp(`href="${url}"`, 'g'))).toHaveLength(2);
    expect(page).toContain('Or open: ');
    expect(page).not.toContain('Open Settings → Licence in Qualor.');
  });

  it('shows the fallback text instead of a button without a URL, or for a URL that is not http(s)', () => {
    for (const url of [null, 'javascript:alert(1)']) {
      const { html: page } = renderLayout({
        ...base,
        cta: { label: 'Open', url, fallbackText: 'Open Settings → Licence in Qualor.' },
      });
      expect(page).toContain('Open Settings → Licence in Qualor.');
      expect(page).not.toContain('javascript:');
      expect([...page.matchAll(/href="([^"]+)"/g)].map((m) => m[1])).toEqual([
        'https://qualor.dev',
      ]);
    }
  });

  it('writes the text part: title, intro, facts, the URL alone on its line, then -- and the reason', () => {
    const url = 'https://qualor.example.com/settings/webhooks';
    const { text } = renderLayout({
      ...base,
      intro: html`<p>${'long words '.repeat(20)}</p>`,
      facts: [
        ['Organization', 'Acme <Co>'],
        ['Attempts', '7'],
      ],
      cta: { label: 'Open webhooks', url, fallbackText: 'unused' },
      after: html`<p>At most one a day.</p>`,
    });
    const lines = text.split('\n');
    expect(lines[0]).toBe('Title <x>');
    expect(lines[1]).toBe('');
    expect(text).toContain('Organization: Acme <Co>\nAttempts: 7');
    expect(lines).toContain(url);
    expect(text).toContain('At most one a day.');
    expect(text).toMatch(
      /\n--\nYou get this because of <reasons>\.\nSent by Qualor · qualor\.dev\n$/,
    );
    for (const line of lines) if (line !== url) expect(line.length).toBeLessThanOrEqual(76);
  });

  it('puts footer links after the reason line: escaped cobalt links, and Label: URL lines (E3)', () => {
    const stop = 'https://qualor.example.com/unsubscribe#t=a.b';
    const settings = 'https://qualor.example.com/settings/notifications';
    const { html: page, text } = renderLayout({
      ...base,
      footerLinks: [
        { label: 'Stop watching <this> project', url: stop },
        { label: 'Notification settings', url: settings },
        { label: 'Dropped', url: 'javascript:alert(1)' },
      ],
    });
    expect(page).toContain(
      `because of &lt;reasons&gt;.<br><a href="${stop}" style="color:#1f5fbf">Stop watching &lt;this&gt; project</a> · <a href="${settings}" style="color:#1f5fbf">Notification settings</a><br>Sent by Qualor`,
    );
    expect(page).not.toContain('javascript:');
    expect(page).not.toContain('Dropped');
    expect(text).toMatch(
      /\n--\nYou get this because of <reasons>\.\nStop watching <this> project: https:\/\/qualor\.example\.com\/unsubscribe#t=a\.b\nNotification settings: https:\/\/qualor\.example\.com\/settings\/notifications\nSent by Qualor · qualor\.dev\n$/,
    );
  });
});
