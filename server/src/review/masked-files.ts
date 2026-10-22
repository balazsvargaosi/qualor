import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import { redactLongText, type OmissionReason } from '@qualor/shared';
import { linesOf, type SnapshotReader } from './snapshot-reader';

/*
 * The files of a snapshot as the model may see them: the server's secret redaction (llm.md §5.2)
 * applied to a file as a whole. What decides whether a line is secret can lie far from it, in a
 * private key's BEGIN line or in the key block next to it, so the lines of a file are never masked
 * one slice at a time: a slice of the middle of a key is not recognised as one. The review tools
 * read, and search, the masked lines only.
 */

/** The most masked text one review keeps, all its files together, in UTF-8 bytes. */
export const MASKED_CACHE_BYTES = 64 * 1024 * 1024;

/** A file of the snapshot: its masked lines, why it has none, or no such file. */
export type MaskedFile =
  | {
      kind: 'text';
      /** As many lines as the file has (`linesOf`), each masked as part of the whole text. */
      lines: readonly string[];
      /**
       * The replacements made in the file, for the call that first masked it: 0 for every later
       * call, whether the masked lines were kept or masked again.
       */
      redactions: number;
    }
  | { kind: 'omitted'; reason: OmissionReason }
  | { kind: 'absent' };

/**
 * The masked files of one review, kept so that a file is masked once however many calls read it.
 * Masking takes about 0.7 s for a file of 1 MiB, and a review reads a few files many times. The
 * lines kept are bounded: once a masked file would take the total past `maxBytes` it is not kept,
 * and is masked again each time it is asked for.
 */
export class MaskedFiles {
  private readonly kept = new Map<string, readonly string[]>();
  private keptBytes = 0;
  /** Files being read and masked now: a second request for one waits for the first. */
  private readonly loading = new Map<string, Promise<MaskedFile>>();
  /** Files whose replacements were handed out once already. */
  private readonly counted = new Set<string>();
  /** How many times a text has been masked. */
  maskings = 0;

  constructor(
    /** The snapshot these files are of: a cache serves one reader. */
    readonly reader: SnapshotReader,
    private readonly maxBytes: number = MASKED_CACHE_BYTES,
  ) {}

  /** UTF-8 bytes of the masked text kept. */
  get bytes(): number {
    return this.keptBytes;
  }

  /** Files whose masked lines are kept. */
  get files(): number {
    return this.kept.size;
  }

  async file(path: string): Promise<MaskedFile> {
    const kept = this.kept.get(path);
    if (kept !== undefined) return { kind: 'text', lines: kept, redactions: 0 };
    const pending = this.loading.get(path);
    if (pending !== undefined) {
      const file = await pending;
      return file.kind === 'text' ? { ...file, redactions: 0 } : file;
    }
    const started = this.load(path);
    this.loading.set(path, started);
    try {
      return await started;
    } finally {
      this.loading.delete(path);
    }
  }

  private async load(path: string): Promise<MaskedFile> {
    const file = await this.reader.file(path);
    if (file.kind !== 'text') return file;
    // The masking does not yield: let the work that waits (requests, the queue) go first.
    await yieldToEventLoop();
    const masked = redactLongText(file.text);
    this.maskings += 1;
    const bytes = Buffer.byteLength(masked.text, 'utf8');
    const lines = linesOf(masked.text);
    if (this.keptBytes + bytes <= this.maxBytes) {
      this.kept.set(path, lines);
      this.keptBytes += bytes;
    }
    const redactions = this.counted.has(path) ? 0 : masked.count;
    this.counted.add(path);
    return { kind: 'text', lines, redactions };
  }
}
