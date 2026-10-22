import { MAX_SNAPSHOT_PATCH_BYTES, REDACTED } from '@qualor/shared';
import { describe, expect, it } from 'vitest';
import { FAKE_KEY } from '../../test/review-snapshot';
import { finishPatch, withoutIndexLines, withoutRemovedLines } from './patches';

/** A modified file's header as git writes it. */
const HEAD = [
  'diff --git a/a.ts b/a.ts',
  'index 1111111..2222222 100644',
  '--- a/a.ts',
  '+++ b/a.ts',
];
/** The same header as a patch is sent: without git's `index` line, the blob ids of both sides. */
const SENT_HEAD = HEAD.filter((line) => !line.startsWith('index '));

describe('withoutRemovedLines', () => {
  it('makes each run of removed lines one marker, and counts the old side again', () => {
    const patch = [
      ...HEAD,
      '@@ -1,6 +1,4 @@ function f() {',
      ' keep 1',
      '-gone 1',
      '-gone 2',
      '+new 1',
      ' keep 2',
      '-gone 3',
      ' keep 3',
      '@@ -20 +18 @@',
      '-old last',
      '\\ No newline at end of file',
      '+new last',
      '\\ No newline at end of file',
      '',
    ].join('\n');
    expect(withoutRemovedLines(patch).split('\n')).toEqual([
      ...HEAD,
      // 3 context lines and 2 markers: the new side, which the review anchors to, is unchanged.
      // The function context git wrote after the ranges is gone.
      '@@ -1,5 +1,4 @@',
      ' keep 1',
      '-[2 removed lines not sent]',
      '+new 1',
      ' keep 2',
      '-[1 removed line not sent]',
      ' keep 3',
      '@@ -20 +18 @@',
      '-[1 removed line not sent]',
      '+new last',
      '\\ No newline at end of file',
      '',
    ]);
  });

  it('leaves the file headers alone, and makes a deleted file one marker line', () => {
    const deleted = [
      'diff --git a/gone.ts b/gone.ts',
      'deleted file mode 100644',
      'index 1111111..0000000',
      '--- a/gone.ts',
      '+++ /dev/null',
      '@@ -1,3 +0,0 @@',
      '-a',
      '-b',
      '-c',
      '',
    ].join('\n');
    expect(withoutRemovedLines(deleted).split('\n').slice(3)).toEqual([
      '--- a/gone.ts',
      '+++ /dev/null',
      // A count of 1 is left out, as git writes it.
      '@@ -1 +0,0 @@',
      '-[3 removed lines not sent]',
      '',
    ]);
  });

  it('rebuilds each hunk header from its ranges alone, whatever its function context holds', () => {
    // git writes the old file's nearest line above the hunk that looks like a function's start:
    // a CR, a line or paragraph separator, or a line the merge request removed.
    const tails = [' f() {\rmore', ' para\u2028graph', ' para\u2029graph', ' note removed-line'];
    for (const tail of tails) {
      const patch = [...HEAD, `@@ -1,3 +1,2 @@${tail}`, ' a', '-gone', ' b', ''].join('\n');
      expect(withoutRemovedLines(patch).split('\n').slice(4), JSON.stringify(tail)).toEqual([
        '@@ -1,3 +1,2 @@',
        ' a',
        '-[1 removed line not sent]',
        ' b',
        '',
      ]);
    }
    const counted = [...HEAD, '@@ -1,3 +1 @@ f() {\rx', ' a', '-gone', '-gone too', ''].join('\n');
    expect(withoutRemovedLines(counted).split('\n')[4]).toBe('@@ -1,2 +1 @@');
  });

  it('keeps a patch without removed lines as it is', () => {
    const added = [...HEAD, '@@ -0,0 +1,2 @@', '+a', '+-not removed: an added line', ''].join('\n');
    expect(withoutRemovedLines(added)).toBe(added);
  });
});

describe('withoutIndexLines', () => {
  /** The header parts git writes, each with the `index` line it carries (or none). */
  const headers: [string, string[], string[]][] = [
    ['a modified file', HEAD, SENT_HEAD],
    [
      'a mode change with a content change (no mode on the index line)',
      [
        'diff --git a/a.sh b/a.sh',
        'old mode 100644',
        'new mode 100755',
        'index 1111111..2222222',
        '--- a/a.sh',
        '+++ b/a.sh',
      ],
      [
        'diff --git a/a.sh b/a.sh',
        'old mode 100644',
        'new mode 100755',
        '--- a/a.sh',
        '+++ b/a.sh',
      ],
    ],
    [
      'an added file',
      [
        'diff --git a/n.ts b/n.ts',
        'new file mode 100644',
        'index 0000000..3333333',
        '--- /dev/null',
        '+++ b/n.ts',
      ],
      ['diff --git a/n.ts b/n.ts', 'new file mode 100644', '--- /dev/null', '+++ b/n.ts'],
    ],
    [
      'a deleted file',
      [
        'diff --git a/d.ts b/d.ts',
        'deleted file mode 100644',
        'index 4444444..0000000',
        '--- a/d.ts',
        '+++ /dev/null',
      ],
      ['diff --git a/d.ts b/d.ts', 'deleted file mode 100644', '--- a/d.ts', '+++ /dev/null'],
    ],
    [
      'a rename with changes (ids of 12 digits)',
      [
        'diff --git a/x.ts b/y.ts',
        'similarity index 90%',
        'rename from x.ts',
        'rename to y.ts',
        `index ${'5'.repeat(12)}..${'6'.repeat(12)} 100644`,
        '--- a/x.ts',
        '+++ b/y.ts',
      ],
      [
        'diff --git a/x.ts b/y.ts',
        'similarity index 90%',
        'rename from x.ts',
        'rename to y.ts',
        '--- a/x.ts',
        '+++ b/y.ts',
      ],
    ],
    [
      'a file that is only renamed (no index line at all)',
      ['diff --git a/x.ts b/y.ts', 'similarity index 100%', 'rename from x.ts', 'rename to y.ts'],
      ['diff --git a/x.ts b/y.ts', 'similarity index 100%', 'rename from x.ts', 'rename to y.ts'],
    ],
  ];

  it.each(headers)('drops the index line of %s, and no other header line', (_n, written, sent) => {
    const hunk = ['@@ -1 +1 @@', '-was', '+is', ''];
    const out = withoutIndexLines([...written, ...hunk].join('\n'));
    expect(out.split('\n')).toEqual([...sent, ...hunk]);
  });

  it('drops the index line of each piece of a type change, and only from a header part', () => {
    // A file replaced by a symlink: git writes the deletion and the addition as two pieces.
    const typeChange = [
      'diff --git a/t b/t',
      'deleted file mode 100644',
      'index 7777777..0000000',
      '--- a/t',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      '-text',
      'diff --git a/t b/t',
      'new file mode 120000',
      'index 0000000..8888888',
      '--- /dev/null',
      '+++ b/t',
      '@@ -0,0 +1 @@',
      '+target',
      '\\ No newline at end of file',
      '',
    ];
    expect(withoutIndexLines(typeChange.join('\n')).split('\n')).toEqual(
      typeChange.filter((line) => !line.startsWith('index ')),
    );
  });

  it('keeps a line of a hunk that reads like an index line, whatever its prefix', () => {
    // A diff of a diff file: every line of a hunk starts with ` `, `+`, `-` or `\`.
    const like = 'index 1234567..89abcde 100644';
    const patch = [...HEAD, '@@ -1,3 +1,2 @@', ` ${like}`, `-${like}`, `+${like}`, ''].join('\n');
    expect(withoutIndexLines(patch).split('\n')).toEqual([
      ...SENT_HEAD,
      '@@ -1,3 +1,2 @@',
      ` ${like}`,
      `-${like}`,
      `+${like}`,
      '',
    ]);
  });

  it('keeps an index line that is not git’s: another shape, or with trailing text', () => {
    // Before the first hunk, but not `index <hex>..<hex> [mode]`.
    const odd = ['index abc..xyz', 'index 1111111..2222222 100644 extra', 'index 111..222 1006440'];
    const patch = [HEAD[0], ...odd, ...HEAD.slice(2), ''].join('\n');
    expect(withoutIndexLines(patch)).toBe(patch);
  });
});

describe('finishPatch', () => {
  const key = [
    ...HEAD,
    '@@ -1,4 +1 @@',
    ' const k =',
    `-  "${FAKE_KEY.rsaBegin}\\n" +`,
    `-  "${FAKE_KEY.line(1)}\\n" +`,
    `-  "${FAKE_KEY.rsaEnd}\\n";`,
    '',
  ].join('\n');

  it('keeps the diff prefix of each line the redaction masks whole', () => {
    const out = finishPatch(Buffer.from(key), { secrets: [], removedLinesScanned: true });
    expect(out?.text.split('\n').slice(SENT_HEAD.length)).toEqual([
      '@@ -1,4 +1 @@',
      ' const k =',
      `-${REDACTED}`,
      `-${REDACTED}`,
      `-${REDACTED}`,
      '',
    ]);
    expect(out?.redactions).toBe(3);
  });

  it('sends no removed line unless the scan of the merge base held them', () => {
    const out = finishPatch(Buffer.from(key), { secrets: [], removedLinesScanned: false });
    expect(out?.text.split('\n').slice(SENT_HEAD.length)).toEqual([
      '@@ -1,2 +1 @@',
      ' const k =',
      '-[3 removed lines not sent]',
      '',
    ]);
  });

  it('sends no index line of git’s, whether the removed lines go or not', () => {
    // The ids of both blobs would let whoever holds the snapshot test guesses of a masked secret
    // (or of a removed line that is not sent) offline, by hashing them as git blobs.
    for (const removedLinesScanned of [true, false]) {
      const out = finishPatch(Buffer.from(key), { secrets: [], removedLinesScanned });
      expect(out?.text, String(removedLinesScanned)).not.toMatch(/^index /m);
      expect(out?.text.split('\n').slice(0, SENT_HEAD.length)).toEqual(SENT_HEAD);
    }
  });

  it('rebuilds every hunk header from its ranges alone, whether the removed lines go or not', () => {
    const tailed = [
      ...HEAD,
      '@@ -1,3 +1,3 @@ note qk7-removed-line-0001',
      ' a',
      '-b',
      '+B',
      ' c',
      '@@ -10 +10 @@ settings:',
      '-x',
      '+y',
      '',
    ].join('\n');
    for (const removedLinesScanned of [true, false]) {
      const out = finishPatch(Buffer.from(tailed), { secrets: [], removedLinesScanned });
      const headers = out?.text.split('\n').filter((l) => l.startsWith('@@'));
      expect(headers, String(removedLinesScanned)).toEqual(['@@ -1,3 +1,3 @@', '@@ -10 +10 @@']);
      expect(out?.text).not.toContain('qk7');
    }
  });

  it('gives a hunk header the redaction masks whole its ranges back, and nothing more', () => {
    // A key block over two hunks: the redaction masks every line from its BEGIN to its END.
    const spanning = [
      ...HEAD,
      '@@ -1,2 +1 @@',
      ' k',
      `-${FAKE_KEY.rsaBegin}`,
      '@@ -9,2 +8 @@',
      `-${FAKE_KEY.rsaEnd}`,
      ' z',
      '',
    ].join('\n');
    const out = finishPatch(Buffer.from(spanning), { secrets: [], removedLinesScanned: true });
    expect(out?.text.split('\n').slice(SENT_HEAD.length)).toEqual([
      '@@ -1,2 +1 @@',
      ' k',
      `-${REDACTED}`,
      '@@ -9,2 +8 @@',
      `-${REDACTED}`,
      ' z',
      '',
    ]);
  });

  it('sends no patch with a hunk it cannot read, or a removed line left out of every hunk', () => {
    const unsent = { secrets: [], removedLinesScanned: false };
    // A header it cannot rebuild, whether the removed lines go or not: a combined diff's header
    // is enough, with no removed line after it.
    const unreadable = [
      [...HEAD, '@@ -x +y @@', '-gone', ''],
      [...HEAD, '@@@ -1,2 -1,2 +1,3 @@@', '  kept', '++added', ''],
    ];
    for (const lines of unreadable) {
      for (const removedLinesScanned of [false, true]) {
        const out = finishPatch(Buffer.from(lines.join('\n')), {
          secrets: [],
          removedLinesScanned,
        });
        expect(out, `${lines[4] ?? ''} ${String(removedLinesScanned)}`).toBeNull();
      }
    }
    const outside = [
      // A hunk that ends before a removed line: the line is in no hunk.
      [...HEAD, '@@ -1 +1 @@', '-gone', '+new', '-also gone', ''],
      // A run of removed lines longer than the hunk's old side: the rest is in no hunk either.
      [...HEAD, '@@ -1 +1,2 @@', '-gone', '-gone too', '+a', '+b', ''],
      // A removed `-- comment` reads `--- comment`: a file header only before a `+++ ` line.
      [...HEAD, '@@ -1 +1 @@', '-a', '+b', '--- comment', ''],
    ];
    for (const lines of outside) {
      expect(finishPatch(Buffer.from(lines.join('\n')), unsent), lines.at(-2)).toBeNull();
    }
    // The scan held the old side: its removed lines go wherever they are.
    const sent = finishPatch(Buffer.from(outside[0]?.join('\n') ?? ''), {
      secrets: [],
      removedLinesScanned: true,
    });
    expect(sent?.text).toContain('\n-also gone\n');
  });

  it('masks the secrets, and is null for a patch with a NUL, not UTF-8, or over the bound', () => {
    const plain = [...HEAD, '@@ -1 +1 @@', '-was a-plain-secret-1', '+is fine', ''].join('\n');
    const out = finishPatch(Buffer.from(plain), {
      secrets: ['a-plain-secret-1'],
      removedLinesScanned: true,
    });
    expect(out?.text).toContain(`\n-was ${REDACTED}\n`);
    const scanned = { secrets: [], removedLinesScanned: true };
    expect(finishPatch(Buffer.from(`${plain}\u0000`), scanned)).toBeNull();
    expect(finishPatch(Buffer.from([...Buffer.from(plain), 0xe9]), scanned)).toBeNull();
    const big = `${plain}${'+x\n'.repeat(MAX_SNAPSHOT_PATCH_BYTES / 3)}`;
    expect(finishPatch(Buffer.from(big), scanned)).toBeNull();
  });
});
