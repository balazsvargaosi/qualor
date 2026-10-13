import { describe, expect, it } from 'vitest';
import { escapeHtml, html, SafeHtml } from './html';
import { adminAlertReason, htmlToText, instanceHost, publicLink, wrapText } from './text';

describe('the html tag (E1 spec, M7)', () => {
  it('escapes every interpolated string', () => {
    expect(html`<p title="${'"x"'}">${`<script>alert('y')</script> & more`}</p>`.toString()).toBe(
      '<p title="&quot;x&quot;">&lt;script&gt;alert(&#39;y&#39;)&lt;/script&gt; &amp; more</p>',
    );
    expect(escapeHtml(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&#39;');
  });

  it('passes SafeHtml through, joins arrays, prints numbers, and drops null, undefined and false', () => {
    const inner = html`<b>${'a<b'}</b>`;
    expect(
      html`${inner}|${[html`<i>1</i>`, 'x&y', 2]}|${null}${undefined}${false}`.toString(),
    ).toBe('<b>a&lt;b</b>|<i>1</i>x&amp;y2|');
  });

  it('cannot be made outside html``', () => {
    expect(() => new SafeHtml(Symbol('forged'), '<img src=x onerror=alert(1)>')).toThrow(TypeError);
  });
});

describe('text helpers (E1 spec)', () => {
  it('turns markup into text: paragraphs and line breaks kept, entities decoded once', () => {
    // "&amp;" typed by someone comes out as typed, not as "&": entities are decoded once.
    expect(htmlToText(html`<p>One ${'&amp;'} ${'<two>'}</p><p>Three<br>four</p>`)).toBe(
      'One &amp; <two>\n\nThree\nfour',
    );
  });

  it('keeps the target of an http(s) link, and the cells of a table apart (E2 and E3 bodies)', () => {
    const url = 'https://qualor.example.com/issues?branch=b1&inNewCode=true';
    expect(
      htmlToText(
        html`<p>Open <a href="${url}" style="color:#1f5fbf">the issues</a> now.</p><table role="presentation"><tr><td>Coverage</td><td>45.5%</td></tr><tr><td>Issues</td><td>3</td></tr></table>`,
      ),
    ).toBe(`Open the issues (${url}) now.\n\nCoverage · 45.5%\nIssues · 3`);
  });

  it('wraps at 76 columns and never breaks a long word', () => {
    const url = `https://qualor.example.com/${'x'.repeat(90)}`;
    const wrapped = wrapText(`${'word '.repeat(40)}${url} end`);
    for (const line of wrapped.split('\n')) {
      if (line !== url) expect(line.length).toBeLessThanOrEqual(76);
    }
    expect(wrapped.split('\n')).toContain(url);
  });

  it('keeps the public URL path in links, and has no host or link without it', () => {
    expect(publicLink('https://example.com/qualor', '/settings/license')).toBe(
      'https://example.com/qualor/settings/license',
    );
    expect(publicLink(null, '/settings/license')).toBeNull();
    expect(instanceHost('https://qualor.example.com:8443/q')).toBe('qualor.example.com:8443');
    expect(instanceHost(null)).toBeNull();
    expect(adminAlertReason(null)).toBe(
      'You get this because you are an instance administrator of this Qualor server. Turn these alerts off in Settings → Email.',
    );
  });
});
