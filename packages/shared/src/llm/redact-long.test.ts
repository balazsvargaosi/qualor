import { describe, expect, it } from 'vitest';
import { REDACTED } from '../sarif/normalize';
import { REDACT_MAX_CHARS, redactText } from './redact';
import { redactLongText } from './redact-long';

const j = (...parts: string[]) => parts.join('');
/** Shapes the shared patterns know, built at run time so no scanner takes them for real ones. */
const GH = j('gh', 'p_', 'a1B2'.repeat(9));
const KEY_BEGIN = j('-----BEGIN ', 'RSA PRIVATE KEY-----');
const KEY_END = j('-----END ', 'RSA PRIVATE KEY-----');
/** Line `i` of a key body: base64 letters and digits, never a real key. */
const keyLine = (i: number): string =>
  j('lQOYBF', String(i).padStart(4, '0'), 'Qm9ndXMga2V5IGJvZHk'.repeat(2));
const code = (n: number, tag: string): string[] =>
  Array.from({ length: n }, (_, i) => `const ${tag}${i} = ${i};`);

describe('redactLongText (llm.md §5.2, for a text of any length)', () => {
  it('is redactText for a text it can scan whole', () => {
    const text = `const t = "${GH}";\nother line\n`;
    expect(redactLongText(text)).toEqual(redactText(text));
  });

  it('scans a long text in windows, so only the lines with a secret change', () => {
    const lines = code(6_000, 'line');
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

  it('masks a private key block whatever the window boundaries around it', () => {
    const block = [KEY_BEGIN, ...Array.from({ length: 30 }, (_, i) => keyLine(i)), KEY_END];
    // Shift the key over the first window's edge (line 200) and its view (eight lines further).
    for (const before of [150, 180, 190, 199, 200, 210, 395]) {
      const lines = [...code(before, 'a'), ...block, ...code(2_000, 'b')];
      const out = redactLongText(lines.join('\n')).text.split('\n');
      expect(out).toHaveLength(lines.length);
      for (let i = 0; i < block.length; i++) {
        expect(out[before + i], `key line ${i} after ${before}`).toBe(REDACTED);
      }
      expect(out.slice(0, before)).toEqual(lines.slice(0, before));
      expect(out.slice(before + block.length)).toEqual(lines.slice(before + block.length));
    }
  });

  it('masks a line that only the whole text shows to be part of a key', () => {
    // A single line of base64 is code or data; next to a key block, or in the middle of one, it is
    // the key. A line masked on its own is not masked: the text is masked whole.
    const body = Array.from({ length: 30 }, (_, i) => keyLine(i));
    const lines = ['before', KEY_BEGIN, ...body, KEY_END, keyLine(99), 'after'];
    const out = redactLongText(lines.join('\n')).text.split('\n');
    expect(out).toEqual(['before', ...lines.slice(1, -1).map(() => REDACTED), 'after']);
    // The body in the middle, and the line after the key, left alone when masked by themselves.
    expect(redactText(body[14] ?? '').text).toBe(body[14]);
    expect(redactText(keyLine(99)).text).toBe(keyLine(99));
  });

  it('masks the body of a BEGIN line with no END line, however far the window is from it', () => {
    const broken = j('----END RSA ', 'PRIVATE KEY-----');
    const body = Array.from({ length: 30 }, (_, i) => keyLine(i));
    const lines = [...code(190, 'a'), KEY_BEGIN, ...body, broken, ...code(2_000, 'b')];
    const out = redactLongText(lines.join('\n')).text.split('\n');
    expect(out).toHaveLength(lines.length);
    for (let i = 0; i < body.length; i++) expect(out[191 + i]).toBe(REDACTED);
    expect(out.slice(0, 190)).toEqual(lines.slice(0, 190));
    expect(out.slice(222)).toEqual(lines.slice(222));
  });

  it('loses at most a window of lines, not the rest of the file, to a PEM header named in code', () => {
    // The shared redaction fails closed on a BEGIN line with no END in view: to the view's end.
    const lines = code(1_000, 'v');
    lines[10] = `const PEM = /^${KEY_BEGIN}$/;`;
    const out = redactLongText(lines.join('\n')).text.split('\n');
    const lost = out.filter((l, i) => l !== lines[i]).length;
    expect(lost).toBeGreaterThan(0);
    expect(lost).toBeLessThanOrEqual(200);
    expect(out.slice(300)).toEqual(lines.slice(300));
  });

  it('counts each replacement once: a secret, and a key block line by line', () => {
    const lines = [...code(500, 'a'), `const t = "${GH}";`, KEY_BEGIN, keyLine(0), KEY_END];
    expect(redactLongText(lines.join('\n')).count).toBe(1 + 3);
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
