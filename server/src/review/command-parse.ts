import { REPLY_COMMANDS, type ReplyCommand } from '../db/schema';

/*
 * What a person asks of Qualor in a note of a merge request: `qualor review`, `qualor fix` or
 * `qualor stop`. `parseCommand` reads the note's body and nothing else, in a module of its own, so
 * that the detection of the notes that give a command (reply-detect.ts), which has no database,
 * does not load what decides a command (commands.ts).
 */

/**
 * `qualor` and a command word, in any case, as the first two words of a line, and the command word
 * ended by the end of the line or by white space. Anchored and without nested repetition, so a
 * long line is matched in one pass.
 */
const COMMAND = new RegExp(`^\\s*qualor\\s+(${REPLY_COMMANDS.join('|')})(?:\\s|$)`, 'i');

/**
 * The command a note's body gives, or null. Only the first line counts: `qualor` and a command
 * word, apart by white space, must be its first two words (white space may come before them), and
 * the command word must end the line or be followed by white space. So `qualor reviewer`,
 * `qualor review.`, `@qualor review` and `please qualor review` are no commands, and nor is a body
 * that starts with a line break.
 */
export function parseCommand(body: string): ReplyCommand | null {
  const lineEnd = body.search(/[\r\n]/);
  const firstLine = lineEnd === -1 ? body : body.slice(0, lineEnd);
  const word = COMMAND.exec(firstLine)?.[1]?.toLowerCase();
  return REPLY_COMMANDS.find((command) => command === word) ?? null;
}
