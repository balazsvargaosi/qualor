import { REDACTED, type OmissionReason } from '@qualor/shared';
import { Masker } from './masker';
import type { SnapshotReader } from './snapshot-reader';

/*
 * The files of a snapshot as the model may see them: the server's secret redaction (llm.md §5.2)
 * applied to a file as a whole. What decides whether a line is secret can lie far from it, in a
 * private key's BEGIN line or in the key block next to it, so the lines of a file are never masked
 * one slice at a time: a slice of the middle of a key is not recognised as one. The review tools
 * read, and search, the masked lines only.
 *
 * Masking is work whose time depends on the text, up to minutes for a hostile one, and what a
 * model asks for is untrusted. So it is done by a Masker (masker.ts), off the thread that serves
 * requests, with a time for each file: a file that takes too long is not shown. And how often a
 * file is masked is bounded three ways. A file is masked once for all the calls of a review that
 * ask for it, also when they ask together (a masking in progress is shared). The masked text of the
 * files of a review is kept up to MASKED_CACHE_BYTES. And a review has a budget of bytes of text
 * to mask, which every masking spends, a file masked again included, beside the Masker's budget
 * of time.
 */

/**
 * The most masked text one review keeps, all its files together: the bytes of the text in UTF-8
 * and four bytes for each of its lines (see `MaskedText`).
 */
export const MASKED_CACHE_BYTES = 64 * 1024 * 1024;

/**
 * What is left of a review's budget for masking, in UTF-8 bytes of file text before it is masked.
 * The caller owns it and shares it between the calls of one review: a masking spends it.
 */
export interface MaskBudget {
  maskedBytes: number;
}

/**
 * How many lines a text has, counted as git does and without making them: a final newline ends the
 * last line, it does not start another, so `a\n` is one line and an empty text has none.
 */
export function lineCountOf(text: string): number {
  let lines = 0;
  for (let at = text.indexOf('\n'); at !== -1; at = text.indexOf('\n', at + 1)) lines += 1;
  return text.length > 0 && !text.endsWith('\n') ? lines + 1 : lines;
}

/**
 * The lines of a masked file: the text, and where each of its lines starts. A line is cut from the
 * text when it is asked for, so a file costs its text and four bytes a line, not an array of
 * strings. The lines are those of the file as the snapshot stores it: the text a masking returns
 * can end in a line more (a private key with no END line is masked to the end of the text, the
 * empty line after the final newline included), and that line is not kept.
 */
export class MaskedText {
  /** The lines the file has. */
  readonly lineCount: number;
  /** The characters of the text kept. */
  readonly length: number;
  /** The bytes the text and its index of lines take (UTF-8, and four for each line). */
  readonly bytes: number;

  private constructor(
    private readonly text: string,
    /** Where each line starts, and one more: where the line after the last would. */
    private readonly starts: Uint32Array,
    lineCount: number,
  ) {
    this.lineCount = lineCount;
    this.length = text.length;
    this.bytes = Buffer.byteLength(text, 'utf8') + 4 * lineCount;
  }

  /** The first `lines` lines of `text`, a file's masked text. */
  static of(text: string, lines: number): MaskedText {
    const starts = new Uint32Array(lines + 1);
    let at = 0;
    let found = 0;
    while (found < lines) {
      starts[found] = at;
      found += 1;
      const end = text.indexOf('\n', at);
      if (end === -1) {
        at = text.length + 1;
        break;
      }
      at = end + 1;
    }
    starts[found] = at;
    // The end of the last line, its line end not counted: the text past it is not kept.
    return new MaskedText(
      text.slice(0, Math.max(0, Math.min(text.length, at - 1))),
      starts.subarray(0, found + 1),
      found,
    );
  }

  /** The line `index` (from 0), with a carriage return it ends in; the empty line past the end. */
  line(index: number): string {
    if (index < 0 || index >= this.lineCount) return '';
    return this.text.slice(this.starts[index], (this.starts[index + 1] ?? 0) - 1);
  }

  /** The length of the line `index`, in characters. */
  lineLength(index: number): number {
    if (index < 0 || index >= this.lineCount) return 0;
    return (this.starts[index + 1] ?? 0) - 1 - (this.starts[index] ?? 0);
  }
}

/** A file of the snapshot: its masked text, why it has none, or no such file. */
export type MaskedFile =
  | {
      kind: 'text';
      /** As many lines as the file has, each masked as part of the whole text. */
      text: MaskedText;
      /**
       * The replacements made in the file, for the call that first masked it: 0 for every later
       * call, whether the masked text was kept or masked again.
       */
      redactions: number;
    }
  | { kind: 'omitted'; reason: OmissionReason }
  | { kind: 'absent' }
  /** The file would take the review past its budget for masking: it is not masked or shown. */
  | { kind: 'budget' }
  /** The file took too long to mask (see `Masker`): it is not shown, and not tried again. */
  | { kind: 'timeout' };

export interface MaskedFilesOptions {
  /** The most masked text kept, in bytes (MASKED_CACHE_BYTES). */
  maxBytes?: number;
  /**
   * The masker of the review, which its caller closes. Without one the files get a masker of
   * their own, with its defaults, which stops its worker when it is idle (or at `close`).
   */
  masker?: Masker;
}

/**
 * The masked files of one review, kept so that a file is masked once however many calls read it.
 * What is kept is bounded: once a masked file would take the total past `maxBytes` it is not kept,
 * and is masked again (and charged again) each time it is asked for.
 */
export class MaskedFiles {
  private readonly kept = new Map<string, MaskedText>();
  private keptBytes = 0;
  /** Files being read and masked now: a second request for one waits for the first. */
  private readonly loading = new Map<string, Promise<MaskedFile>>();
  /** Files whose replacements were handed out once already. */
  private readonly counted = new Set<string>();
  /** Files that took too long to mask: asking again would take that time again. */
  private readonly timedOut = new Set<string>();
  private readonly maxBytes: number;
  private readonly masker: Masker;
  private readonly ownsMasker: boolean;
  /** How many times a text has been masked. */
  maskings = 0;

  constructor(
    /** The snapshot these files are of: a cache serves one reader. */
    readonly reader: SnapshotReader,
    options: MaskedFilesOptions = {},
  ) {
    this.maxBytes = options.maxBytes ?? MASKED_CACHE_BYTES;
    this.ownsMasker = options.masker === undefined;
    this.masker = options.masker ?? new Masker();
  }

  /** Bytes of the masked text kept (see `MaskedText`). */
  get bytes(): number {
    return this.keptBytes;
  }

  /** Files whose masked text is kept. */
  get files(): number {
    return this.kept.size;
  }

  /**
   * The masked text of a file if it is kept, with nothing masked and nothing charged; null when it
   * is not (never asked for, or too large to keep). For a caller that has just had a file masked and
   * holds on to its text only for as long as these files do.
   */
  keptText(path: string): MaskedText | null {
    return this.kept.get(path) ?? null;
  }

  /** Stops the masker these files made for themselves; one they were given is its owner's. */
  async close(): Promise<void> {
    if (this.ownsMasker) await this.masker.close();
  }

  /**
   * The file, masked. A file that is kept or being masked costs nothing; one that is masked now
   * is charged to `budget` (when there is one) before it is, and is `budget` when it does not fit.
   * A file that took too long is `timeout`, now and for every request after. Once the review has
   * spent the time it may spend masking, every file with text is `budget`, the ones kept and the
   * ones that took too long among them: which of them were asked for before, and what they held,
   * is not for the answer to tell. A failure to read or to mask the file is not kept: the next
   * request tries again.
   */
  async file(path: string, budget?: MaskBudget): Promise<MaskedFile> {
    const kept = this.kept.get(path);
    if (kept !== undefined) {
      return this.masker.exhausted
        ? { kind: 'budget' }
        : { kind: 'text', text: kept, redactions: 0 };
    }
    if (this.timedOut.has(path)) return { kind: this.masker.exhausted ? 'budget' : 'timeout' };
    const pending = this.loading.get(path);
    if (pending !== undefined) {
      const file = await pending;
      return file.kind === 'text' ? { ...file, redactions: 0 } : file;
    }
    const started = this.load(path, budget);
    this.loading.set(path, started);
    try {
      return await started;
    } finally {
      this.loading.delete(path);
    }
  }

  private async load(path: string, budget: MaskBudget | undefined): Promise<MaskedFile> {
    const file = await this.reader.file(path);
    if (file.kind !== 'text') return file;
    const bytes = Buffer.byteLength(file.text, 'utf8');
    if (budget !== undefined) {
      if (bytes > budget.maskedBytes) return { kind: 'budget' };
      budget.maskedBytes -= bytes;
    }
    let result;
    try {
      result = await this.masker.mask(file.text);
    } catch (error) {
      if (budget !== undefined) budget.maskedBytes += bytes;
      throw error;
    }
    if (result.kind === 'budget') {
      // Nothing was masked: the bytes are not spent.
      if (budget !== undefined) budget.maskedBytes += bytes;
      return { kind: 'budget' };
    }
    if (result.kind === 'timeout') {
      this.timedOut.add(path);
      return { kind: 'timeout' };
    }
    this.maskings += 1;
    const text = MaskedText.of(result.text, lineCountOf(file.text));
    // The line a masking adds after the final newline is not the file's, and what was replaced in it
    // is not reported.
    const dropped = result.text.slice(text.length).split(REDACTED).length - 1;
    if (this.keptBytes + text.bytes <= this.maxBytes) {
      this.kept.set(path, text);
      this.keptBytes += text.bytes;
    }
    const redactions = this.counted.has(path) ? 0 : Math.max(0, result.count - dropped);
    this.counted.add(path);
    return { kind: 'text', text, redactions };
  }
}
