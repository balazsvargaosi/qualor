import { REDACT_MAX_CHARS, REDACTED, redactText } from '@qualor/shared';
import { describe, expect, it } from 'vitest';
import { FAKE_KEY } from '../../test/review-snapshot';
import {
  maskSecrets,
  mergeRequestText,
  prepareSecrets,
  redactLongText,
  redactSnapshotText,
  secretLines,
} from './redact';

const j = (...parts: string[]) => parts.join('');
/** Shapes the shared patterns know, built at run time so no scanner takes them for real ones. */
const GH = j('gh', 'p_', 'a1B2'.repeat(9));
const { rsaBegin: KEY_BEGIN, rsaEnd: KEY_END, pgpBegin: PGP_BEGIN, pgpEnd: PGP_END } = FAKE_KEY;
const KEY_BODY = j('MIIEowIBAAKCAQEA', 'q7Zr'.repeat(12));
const keyLine = FAKE_KEY.line;

describe('prepareSecrets', () => {
  it('keeps the secrets of 8 characters or more, once each, the longest first', () => {
    expect(prepareSecrets(['short', 'abcdefgh', 'abcdefghij', 'abcdefgh', ''])).toEqual([
      'abcdefghij',
      'abcdefgh',
    ]);
  });

  it('adds each secret with its line ends as LF (a scan of a CRLF working tree, a commit of LF)', () => {
    expect(prepareSecrets(['line-one-xx\r\nline-two-xx', 'trailing-cr-value\r'])).toEqual([
      'line-one-xx\r\nline-two-xx',
      'line-one-xx\nline-two-xx',
      'trailing-cr-value\r',
      'trailing-cr-value',
    ]);
  });
});

describe('secretLines', () => {
  it('is each line of every multi-line secret, of 8 characters or more, without its \\r', () => {
    // A patch shows a secret's lines apart, each behind its `+`, `-` or space.
    expect(
      secretLines(['single-line-secret', 'first-half-of-it\r\nshort\nsecond-half-of-it']),
    ).toEqual(['first-half-of-it', 'second-half-of-it']);
  });

  it('trims each line, and keeps only one of 8 or more characters that are not blank', () => {
    const lines = secretLines([
      '  first-line-of-it  \n        \n\tsecond-line\n x y z w v u t s \n a   b   c   d ',
    ]);
    expect(lines).toEqual(['first-line-of-it', 'second-line', 'x y z w v u t s']);
    // A copy indented anew is masked; a run of spaces never is.
    const patch = '+first-line-of-it\n+      second-line\n+        indented code';
    expect(maskSecrets(patch, lines).text).toBe(
      `+${REDACTED}\n+      ${REDACTED}\n+        indented code`,
    );
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

  describe('a whole key block, however its lines are decorated, is masked over every window', () => {
    const code = (n: number, tag: string) =>
      Array.from({ length: n }, (_, i) => `const ${tag}${i} = ${i};`);
    /** Every line of `block` masked, placed after `before` lines of code; the code around kept. */
    function expectMasked(block: readonly string[], before: number): void {
      const lines = [...code(before, 'a'), ...block, ...code(300, 'b')];
      const out = redactLongText(lines.join('\n')).text.split('\n');
      expect(out).toHaveLength(lines.length);
      const shown = block.filter((_, i) => out[before + i] !== REDACTED);
      expect(shown, `${shown.length} key lines in clear`).toEqual([]);
      expect(out[before - 1]).toBe(lines[before - 1]);
      expect(out[before + block.length]).toBe(lines[before + block.length]);
    }
    const body = (n: number, decorate: (line: string) => string) =>
      Array.from({ length: n }, (_, i) => decorate(keyLine(i)));

    it('a 450-line PGP block commented with `# `', () => {
      expectMasked(
        [`# ${PGP_BEGIN}`, '#', ...body(450, (l) => `# ${l}`), '# =AbCd', `# ${PGP_END}`],
        100,
      );
    });

    it('a key block written as b"…\\n" literals', () => {
      const literal = (l: string) => `    b"${l}\\n"`;
      expectMasked([literal(KEY_BEGIN), ...body(450, literal), literal(KEY_END)], 60);
    });

    it('a patch that deletes an embedded 450-line block', () => {
      const removed = (l: string) => `-    "${l}\\n" +`;
      expectMasked([removed(KEY_BEGIN), ...body(450, removed), removed(KEY_END)], 30);
    });

    it('a //-commented 230-line RSA block whose BEGIN is at line 190', () => {
      const comment = (l: string) => `// ${l}`;
      expectMasked([comment(KEY_BEGIN), ...body(228, comment), comment(KEY_END)], 190);
    });
  });

  describe('the body of a BEGIN line with no END line is masked over every window', () => {
    /** Four dashes: no END marker, as a mistyped or cut line is. */
    const BROKEN_END = j('----END RSA ', 'PRIVATE KEY-----');
    const code = (n: number, tag: string) =>
      Array.from({ length: n }, (_, i) => `const ${tag}${i} = ${i};`);
    const shapes = [
      { name: 'undecorated', begin: KEY_BEGIN, row: (l: string) => l, end: BROKEN_END },
      {
        name: 'commented with `# `',
        begin: `# ${KEY_BEGIN}`,
        separator: '#',
        row: (l: string) => `# ${l}`,
        end: `# ${BROKEN_END}`,
      },
      {
        name: 'a Java string, "…\\n" +',
        begin: `    "${KEY_BEGIN}\\n" +`,
        row: (l: string) => `    "${l}\\n" +`,
        end: `    "${BROKEN_END}\\n";`,
      },
      {
        name: 'a Java string that a patch removes',
        begin: `-    "${KEY_BEGIN}\\n" +`,
        row: (l: string) => `-    "${l}\\n" +`,
        end: `-    "${BROKEN_END}\\n";`,
      },
      {
        name: 'indented (YAML)',
        begin: `    ${KEY_BEGIN}`,
        row: (l: string) => `    ${l}`,
        end: `    ${BROKEN_END}`,
      },
      {
        name: 'a patch line added',
        begin: `+${KEY_BEGIN}`,
        row: (l: string) => `+${l}`,
        end: `+${BROKEN_END}`,
      },
    ];

    it.each(shapes)(
      '$name: 30 body lines and a short last line over the boundary of the first window, with the file around kept',
      ({ begin, separator, row, end }) => {
        const body = Array.from({ length: 30 }, (_, i) => row(keyLine(i)));
        // The last line of a key is as long as the others or shorter (4 to 64 characters). The
        // windows used to extend a run of long base64 lines to a short one next to it; the long
        // ones are masked before the windows now, so the short line itself is marked.
        for (const tail of ['AbCd1234', 'Zm9vYmE=']) {
          const block = [
            begin,
            ...(separator === undefined ? [] : [separator]),
            ...body,
            row(tail),
          ];
          // The window ends at line 200 and its view eight lines later: the body crosses both.
          for (const before of [185, 190]) {
            const lines = [...code(before, 'a'), ...block, end, ...code(2_000, 'b')];
            const out = redactLongText(lines.join('\n')).text.split('\n');
            expect(out).toHaveLength(lines.length);
            const shown = block.filter((_, i) => out[before + i] !== REDACTED);
            expect(shown, `${shown.length} key lines in clear after ${before} lines`).toEqual([]);
            // Nothing before the key, and nothing from the broken END line on, is lost.
            expect(out.slice(0, before)).toEqual(lines.slice(0, before));
            expect(out.slice(before + block.length)).toEqual(lines.slice(before + block.length));
          }
        }
      },
    );

    it.each([
      ['a Java string', (l: string) => `    "${l}\\n" +`, (l: string) => `    "${l}\\n";`],
      ['the same without the escape', (l: string) => `    "${l}" +`, (l: string) => `    "${l}";`],
      [
        'a Java string that a patch removes',
        (l: string) => `-    "${l}\\n" +`,
        (l: string) => `-    "${l}\\n";`,
      ],
    ])(
      '%s: the last line, long or short, closes the string, with the END line missing',
      (_n, row, closing) => {
        // The windows' own rule for base64 lines takes a last line with its `";`; the lines before
        // it are masked first, so the rule has no run left to start from.
        const body = Array.from({ length: 30 }, (_, i) => row(keyLine(i)));
        for (const tail of ['AbCd1234', keyLine(30)]) {
          const block = [row(KEY_BEGIN), ...body, closing(tail)];
          for (const before of [185, 190]) {
            const lines = [...code(before, 'a'), ...block, '}', ...code(2_000, 'b')];
            const out = redactLongText(lines.join('\n')).text.split('\n');
            expect(out).toHaveLength(lines.length);
            const shown = block.filter((_, i) => out[before + i] !== REDACTED);
            expect(shown, `${shown.length} key lines in clear after ${before} lines`).toEqual([]);
            expect(out.slice(before + block.length)).toEqual(lines.slice(before + block.length));
          }
        }
      },
    );
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
    const secret = j('cut-me-', 'in-half-1234');
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
