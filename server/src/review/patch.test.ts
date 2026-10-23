import { describe, expect, it } from 'vitest';
import { parsePatch } from './patch';

/** `git diff -U3` of a 30-line file against a 28-line base: three hunks, the last one at the last line. */
const APP_PATCH = `${[
  'diff --git a/src/app.ts b/src/app.ts',
  '--- a/src/app.ts',
  '+++ b/src/app.ts',
  '@@ -1,5 +1,5 @@',
  ' line 1',
  '-line 2',
  '+line 2 changed',
  ' line 3',
  ' line 4',
  ' line 5',
  '@@ -11,6 +11,8 @@',
  ' line 11',
  ' line 12',
  ' line 13',
  '+inserted A',
  '+inserted B',
  ' line 16',
  ' line 17',
  ' line 18',
  '@@ -25,4 +27,4 @@',
  ' line 27',
  ' line 28',
  ' line 29',
  '-line 30',
  '+line 30 changed',
].join('\n')}\n`;

describe('parsePatch', () => {
  it('numbers added and context rows on the new side, removed rows unnumbered', () => {
    expect(parsePatch(APP_PATCH)).toEqual({
      hunks: [
        {
          oldStart: 1,
          newStart: 1,
          rows: [
            { kind: ' ', newLine: 1, text: 'line 1' },
            { kind: '-', newLine: null, text: 'line 2' },
            { kind: '+', newLine: 2, text: 'line 2 changed' },
            { kind: ' ', newLine: 3, text: 'line 3' },
            { kind: ' ', newLine: 4, text: 'line 4' },
            { kind: ' ', newLine: 5, text: 'line 5' },
          ],
        },
        {
          oldStart: 11,
          newStart: 11,
          rows: [
            { kind: ' ', newLine: 11, text: 'line 11' },
            { kind: ' ', newLine: 12, text: 'line 12' },
            { kind: ' ', newLine: 13, text: 'line 13' },
            { kind: '+', newLine: 14, text: 'inserted A' },
            { kind: '+', newLine: 15, text: 'inserted B' },
            { kind: ' ', newLine: 16, text: 'line 16' },
            { kind: ' ', newLine: 17, text: 'line 17' },
            { kind: ' ', newLine: 18, text: 'line 18' },
          ],
        },
        {
          oldStart: 25,
          newStart: 27,
          rows: [
            { kind: ' ', newLine: 27, text: 'line 27' },
            { kind: ' ', newLine: 28, text: 'line 28' },
            { kind: ' ', newLine: 29, text: 'line 29' },
            { kind: '-', newLine: null, text: 'line 30' },
            { kind: '+', newLine: 30, text: 'line 30 changed' },
          ],
        },
      ],
      added: new Set([2, 14, 15, 30]),
    });
  });

  it('reads a hunk at the first line, a hunk at the last line and two adjacent hunks', () => {
    // A five-line file: the first hunk takes lines 1-2, the second 3-5, with nothing between.
    const patch = [
      '@@ -1,2 +1,2 @@',
      '-a',
      '+A',
      ' b',
      '@@ -3,3 +3,3 @@',
      ' c',
      '-d',
      '+D',
      ' e',
    ].join('\n');
    expect(parsePatch(patch)).toEqual({
      hunks: [
        {
          oldStart: 1,
          newStart: 1,
          rows: [
            { kind: '-', newLine: null, text: 'a' },
            { kind: '+', newLine: 1, text: 'A' },
            { kind: ' ', newLine: 2, text: 'b' },
          ],
        },
        {
          oldStart: 3,
          newStart: 3,
          rows: [
            { kind: ' ', newLine: 3, text: 'c' },
            { kind: '-', newLine: null, text: 'd' },
            { kind: '+', newLine: 4, text: 'D' },
            { kind: ' ', newLine: 5, text: 'e' },
          ],
        },
      ],
      added: new Set([1, 4]),
    });
  });

  it('reads a new file, a deletion that leaves no line, and the lines about a missing newline', () => {
    expect(parsePatch('@@ -0,0 +1,3 @@\n+x\n+y\n+z')).toEqual({
      hunks: [
        {
          oldStart: 0,
          newStart: 1,
          rows: [
            { kind: '+', newLine: 1, text: 'x' },
            { kind: '+', newLine: 2, text: 'y' },
            { kind: '+', newLine: 3, text: 'z' },
          ],
        },
      ],
      added: new Set([1, 2, 3]),
    });
    // -U0: the new side has no line, and the hunk names the line it comes after.
    expect(parsePatch('@@ -2,2 +1,0 @@\n-b\n-c\n')).toEqual({
      hunks: [
        {
          oldStart: 2,
          newStart: 1,
          rows: [
            { kind: '-', newLine: null, text: 'b' },
            { kind: '-', newLine: null, text: 'c' },
          ],
        },
      ],
      added: new Set(),
    });
    expect(
      parsePatch(
        '@@ -1 +1 @@\n-old\n\\ No newline at end of file\n+new\n\\ No newline at end of file\n',
      ),
    ).toEqual({
      hunks: [
        {
          oldStart: 1,
          newStart: 1,
          rows: [
            { kind: '-', newLine: null, text: 'old' },
            { kind: '+', newLine: 1, text: 'new' },
          ],
        },
      ],
      added: new Set([1]),
    });
  });

  it('reads the markers of a patch whose removed lines are not sent as removed-marker rows', () => {
    expect(parsePatch('@@ -2,3 +2,2 @@\n a\n-[7 removed lines not sent]\n b\n')).toEqual({
      hunks: [
        {
          oldStart: 2,
          newStart: 2,
          rows: [
            { kind: ' ', newLine: 2, text: 'a' },
            { kind: 'removed-marker', newLine: null, text: '[7 removed lines not sent]' },
            { kind: ' ', newLine: 3, text: 'b' },
          ],
        },
      ],
      added: new Set(),
    });
    // The singular, and a line that only looks like one.
    const rows = parsePatch(
      '@@ -1,3 +1,0 @@\n-[1 removed line not sent]\n-[1 removed line not sent!]\n-[x removed lines not sent]\n',
    )?.hunks[0]?.rows.map((row) => row.kind);
    expect(rows).toEqual(['removed-marker', '-', '-']);
  });

  it('reads CRLF lines without their carriage return, a patch with no hunk, and a patch of two pieces', () => {
    expect(parsePatch('@@ -1 +1 @@\r\n-a\r\n+b\r\n')?.hunks[0]?.rows).toEqual([
      { kind: '-', newLine: null, text: 'a' },
      { kind: '+', newLine: 1, text: 'b' },
    ]);
    // A rename with no edit has headers only.
    expect(
      parsePatch('diff --git a/x b/y\nsimilarity index 100%\nrename from x\nrename to y\n'),
    ).toEqual({ hunks: [], added: new Set() });
    // A type change: the old file is deleted and a new one added, each with its own header.
    const typeChange = [
      'diff --git a/link b/link',
      'deleted file mode 120000',
      '--- a/link',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      '-target',
      '\\ No newline at end of file',
      'diff --git a/link b/link',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/link',
      '@@ -0,0 +1,2 @@',
      '+one',
      '+two',
    ].join('\n');
    const parsed = parsePatch(typeChange);
    expect(parsed?.hunks.map((hunk) => hunk.rows.map((row) => row.kind))).toEqual([
      ['-'],
      ['+', '+'],
    ]);
    expect(parsed?.added).toEqual(new Set([1, 2]));
  });

  it('reads an empty line where a context line is due as a blank context line (diff.suppressBlankEmpty)', () => {
    // The scanner's git may write a blank context line with no space; the scanner counts it as one.
    expect(parsePatch('@@ -1,3 +1,4 @@\n a\n\n+b\n c\n')).toEqual({
      hunks: [
        {
          oldStart: 1,
          newStart: 1,
          rows: [
            { kind: ' ', newLine: 1, text: 'a' },
            { kind: ' ', newLine: 2, text: '' },
            { kind: '+', newLine: 3, text: 'b' },
            { kind: ' ', newLine: 4, text: 'c' },
          ],
        },
      ],
      added: new Set([3]),
    });
    // A patch that ends with one is not taken to end sooner; one cut short is not completed by the
    // end of the text.
    expect(parsePatch('@@ -1,2 +1,2 @@\n a\n\n')?.hunks[0]?.rows.map((row) => row.text)).toEqual([
      'a',
      '',
    ]);
    expect(parsePatch('@@ -1,3 +1,3 @@\n a\n\n')).toBeNull();
  });

  it('answers null for text that is not a unified diff', () => {
    const invalid: Record<string, string> = {
      'a hunk header that does not parse': '@@ nonsense @@\n+x\n',
      'a hunk with fewer rows than its header counts': '@@ -1,3 +1,3 @@\n a\n-b\n',
      'a row with no diff prefix': '@@ -1 +1 @@\n?x\n',
      'an empty line where only the old side has lines left': '@@ -1,2 +1,0 @@\n-a\n\n',
      'an added row past the new count': '@@ -1 +1,0 @@\n+x\n',
      'a removed row past the old count': '@@ -1,0 +1 @@\n-x\n',
      'a context row past the counts of one side': '@@ -1,1 +1,0 @@\n x\n',
      'lines numbered from 0': '@@ -1 +0,2 @@\n-a\n+b\n+c\n',
      'numbers too large to count with': '@@ -1 +99999999999999999999,1 @@\n+x\n',
      'a hunk header with a count too large': '@@ -1,9007199254740993 +1 @@\n-x\n',
      'one good hunk and one that does not parse': '@@ -1 +1 @@\n-a\n+b\n@@ -x +1 @@\n+c\n',
    };
    for (const [why, patch] of Object.entries(invalid)) expect(parsePatch(patch), why).toBeNull();
  });
});
