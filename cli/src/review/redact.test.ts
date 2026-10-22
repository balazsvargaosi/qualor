import { REDACT_MAX_CHARS, REDACTED, redactText } from '@qualor/shared';
import { describe, expect, it } from 'vitest';
import {
  maskSecrets,
  mergeRequestText,
  prepareSecrets,
  redactLongText,
  redactSnapshotText,
} from './redact';

const j = (...parts: string[]) => parts.join('');
/** Shapes the shared patterns know, built at run time so no scanner takes them for real ones. */
const GH = j('gh', 'p_', 'a1B2'.repeat(9));
const KEY_BEGIN = j('-----BEGIN ', 'RSA PRIVATE KEY-----');
const KEY_END = j('-----END ', 'RSA PRIVATE KEY-----');
const KEY_BODY = j('MIIEowIBAAKCAQEA', 'q7Zr'.repeat(12));

describe('prepareSecrets', () => {
  it('keeps the secrets of 8 characters or more, once each, the longest first', () => {
    expect(prepareSecrets(['short', 'abcdefgh', 'abcdefghij', 'abcdefgh', ''])).toEqual([
      'abcdefghij',
      'abcdefgh',
    ]);
  });
});

describe('maskSecrets', () => {
  it('replaces every occurrence and counts them', () => {
    expect(maskSecrets('a s3cr3t-value b s3cr3t-value', ['s3cr3t-value'])).toEqual({
      text: `a ${REDACTED} b ${REDACTED}`,
      count: 2,
    });
    expect(maskSecrets('nothing here', ['s3cr3t-value'])).toEqual({
      text: 'nothing here',
      count: 0,
    });
  });

  it('masks two secrets that overlap as one, so no piece of either is left', () => {
    // Replacing one first would leave the other's remainder in the text.
    const out = maskSecrets(
      '<abcdefgh12345678zzzz>',
      prepareSecrets(['abcdefgh12345678', '12345678zzzz']),
    );
    expect(out).toEqual({ text: `<${REDACTED}>`, count: 1 });
  });

  it('masks a secret that spans lines', () => {
    expect(maskSecrets('x\nline-one\nline-two\ny', ['line-one\nline-two']).text).toBe(
      `x\n${REDACTED}\ny`,
    );
  });
});

describe('redactLongText', () => {
  it('is redactText for a text it can scan whole', () => {
    const text = `const t = "${GH}";\nother line\n`;
    expect(redactLongText(text)).toEqual(redactText(text));
  });

  it('scans a long text in windows, so only the lines with a secret change', () => {
    const lines = Array.from({ length: 6_000 }, (_, i) => `const line${i} = ${i};`);
    lines[3_000] = `const token = "${GH}";`;
    const text = lines.join('\n');
    expect(text.length).toBeGreaterThan(2 * REDACT_MAX_CHARS);
    const out = redactLongText(text);
    expect(out.count).toBe(1);
    expect(out.text).not.toContain(GH);
    const outLines = out.text.split('\n');
    expect(outLines).toHaveLength(lines.length);
    expect(outLines[3_000]).toBe(`const token = "${REDACTED}";`);
    expect(outLines.filter((l, i) => l !== lines[i])).toHaveLength(1);
  });

  it('redacts a private key block whatever the window boundaries around it', () => {
    const filler = (n: number) =>
      Array.from({ length: n }, (_, i) => `// filler line ${i} ${'.'.repeat(40)}`);
    const key = [KEY_BEGIN, ...Array.from({ length: 30 }, () => KEY_BODY), KEY_END];
    const longKey = [KEY_BEGIN, ...Array.from({ length: 450 }, () => KEY_BODY), KEY_END];
    // Shift the keys over window boundaries, line by line; the long one spans whole windows.
    for (const [block, before] of [
      ...[150, 170, 180, 190, 200, 210, 380, 400, 560, 600, 620].map((n) => [key, n] as const),
      ...[5, 190, 333].map((n) => [longKey, n] as const),
    ]) {
      const text = [...filler(before), ...block, ...filler(2_000)].join('\n');
      const out = redactLongText(text).text.split('\n');
      for (let i = 0; i < block.length; i++) {
        expect(out[before + i], `key line ${i} after ${before}`).toBe(REDACTED);
      }
      expect(out[before - 1]).toBe(filler(before).at(-1));
    }
  });

  it('loses at most a window of lines, not the rest of the file, to a PEM header named in code', () => {
    // The shared redaction fails closed on a BEGIN line with no END in view: to the view's end.
    const lines = Array.from({ length: 1_000 }, (_, i) => `const v${i} = ${i};`);
    lines[10] = `const PEM = /^${KEY_BEGIN}$/;`;
    const out = redactLongText(lines.join('\n')).text.split('\n');
    const lost = out.filter((l, i) => l !== lines[i]).length;
    expect(lost).toBeGreaterThan(0);
    expect(lost).toBeLessThanOrEqual(200);
    expect(out.slice(300)).toEqual(lines.slice(300));
  });

  it('replaces a line too long to scan, and only that line', () => {
    const text = ['first', 'x'.repeat(REDACT_MAX_CHARS + 10), 'last'].join('\n');
    expect(redactLongText(text)).toEqual({ text: `first\n${REDACTED}\nlast`, count: 1 });
  });

  it('scans a text of exactly the shared limit in windows (redactText would mask it whole)', () => {
    const line = `${'y'.repeat(99)}\n`;
    const text = `${line.repeat(REDACT_MAX_CHARS / 100)}${'z'.repeat(REDACT_MAX_CHARS % 100)}`;
    expect(text.length).toBe(REDACT_MAX_CHARS);
    expect(redactLongText(text)).toEqual({ text, count: 0 });
  });
});

describe('redactSnapshotText', () => {
  it('masks the analyzer secrets, then runs the shared redaction', () => {
    const out = redactSnapshotText(`// plain words-not-a-pattern\nconst t = "${GH}";\n`, [
      'words-not-a-pattern',
    ]);
    expect(out.text).toBe(`// plain ${REDACTED}\nconst t = "${REDACTED}";\n`);
    expect(out.count).toBe(2);
  });
});

describe('mergeRequestText', () => {
  it('drops NUL characters and lone surrogates, then cuts to the bound in code points', () => {
    expect(mergeRequestText('a\u0000b\ud800c\udc00d😀', 100, [])).toEqual({
      text: 'abcd😀',
      count: 0,
    });
    const long = mergeRequestText('😀'.repeat(300), 255, []);
    expect([...(long.text ?? '')]).toHaveLength(255);
    expect(long.text?.endsWith('…')).toBe(true);
    expect(mergeRequestText(null, 255, [])).toEqual({ text: null, count: 0 });
  });

  it('masks a secret before cutting, so no half of it is left at the cut', () => {
    const secret = 'cut-me-in-half-1234';
    const text = `${'w'.repeat(10)} ${secret}`;
    // 10 + 1 + the marker's 10 code points.
    const out = mergeRequestText(text, 21, [secret]);
    expect(out.text).toBe(`${'w'.repeat(10)} ${REDACTED}`);
    expect(out.count).toBe(1);
    const cut = mergeRequestText(text, 15, [secret]).text;
    expect(cut).toBe(`${'w'.repeat(10)} «re…`);
    expect(cut).not.toContain('cut-me');
  });
});
