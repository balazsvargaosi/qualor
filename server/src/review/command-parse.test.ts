import { describe, expect, it } from 'vitest';
import { parseCommand } from './command-parse';

describe('parseCommand', () => {
  it('qualor review, QUALOR REVIEW and "  qualor review please" are commands', () => {
    expect(parseCommand('qualor review')).toBe('review');
    expect(parseCommand('QUALOR REVIEW')).toBe('review');
    expect(parseCommand('  qualor review please')).toBe('review');
  });

  it('knows review, fix and stop, in any case', () => {
    expect(parseCommand('qualor fix')).toBe('fix');
    expect(parseCommand('Qualor Fix')).toBe('fix');
    expect(parseCommand('qualor stop')).toBe('stop');
    expect(parseCommand('QuAlOr sToP')).toBe('stop');
    expect(parseCommand('qualor fix this one, thanks')).toBe('fix');
  });

  it('qualor reviewer is not a command', () => {
    // The control: the same words, ended after the command word.
    expect(parseCommand('qualor review')).toBe('review');
    expect(parseCommand('qualor reviewer')).toBeNull();
    expect(parseCommand('qualor reviewed')).toBeNull();
    expect(parseCommand('qualor fixes')).toBeNull();
    expect(parseCommand('qualor stopped')).toBeNull();
    // Only the end or white space may follow the command word.
    expect(parseCommand('qualor review.')).toBeNull();
    expect(parseCommand('qualor review, please')).toBeNull();
    expect(parseCommand('qualor stop!')).toBeNull();
    expect(parseCommand('qualor review:')).toBeNull();
  });

  it('wants the two words first, apart, in that order', () => {
    // The control: both words, in order, first in the note.
    expect(parseCommand('qualor review')).toBe('review');
    expect(parseCommand('@qualor review')).toBeNull();
    expect(parseCommand('please qualor review')).toBeNull();
    expect(parseCommand('qualor please review')).toBeNull();
    expect(parseCommand('review qualor')).toBeNull();
    expect(parseCommand('qualorreview')).toBeNull();
    expect(parseCommand('qualor-review')).toBeNull();
    expect(parseCommand('qualor/review')).toBeNull();
    expect(parseCommand('> qualor review')).toBeNull();
    expect(parseCommand('**qualor review**')).toBeNull();
    expect(parseCommand('`qualor review`')).toBeNull();
    expect(parseCommand('qualor')).toBeNull();
    expect(parseCommand('qualor ')).toBeNull();
    expect(parseCommand('review')).toBeNull();
    expect(parseCommand('')).toBeNull();
    expect(parseCommand('   ')).toBeNull();
    // Only the three command words are commands.
    expect(parseCommand('qualor help')).toBeNull();
  });

  it('skips leading white space and takes any white space between the words', () => {
    expect(parseCommand('   qualor review')).toBe('review');
    expect(parseCommand('\t qualor\treview')).toBe('review');
    expect(parseCommand('qualor      stop')).toBe('stop');
    expect(parseCommand('qualor review   ')).toBe('review');
  });

  it('counts the first line only', () => {
    // The control: the command on the first line, with more below it.
    expect(parseCommand('qualor review\nand more below')).toBe('review');
    expect(parseCommand('qualor review\r\nand more below')).toBe('review');
    expect(parseCommand('qualor review\rand more below')).toBe('review');
    expect(parseCommand('qualor fix\n\nqualor stop')).toBe('fix');
    // A line break before `qualor`, or between the words, is no command.
    expect(parseCommand('\nqualor review')).toBeNull();
    expect(parseCommand('\r\nqualor review')).toBeNull();
    expect(parseCommand('\n\n  qualor review')).toBeNull();
    expect(parseCommand('\rqualor review')).toBeNull();
    expect(parseCommand('qualor\rreview')).toBeNull();
    expect(parseCommand('Thanks for the review.\nqualor review')).toBeNull();
    expect(parseCommand('qualor\nreview')).toBeNull();
    expect(parseCommand('qualor\r\nreview')).toBeNull();
    expect(parseCommand('qualor \nreview')).toBeNull();
  });

  it('reads a very long first line in one pass', () => {
    // A note may hold a million characters; a quadratic match would not finish.
    const long = 'x'.repeat(200_000);
    const spaces = ' '.repeat(200_000);
    expect(parseCommand(`qualor stop ${long}`)).toBe('stop');
    expect(parseCommand(`${spaces}qualor stop`)).toBe('stop');
    expect(parseCommand(`qualor${spaces}stop`)).toBe('stop');
    expect(parseCommand(`${spaces}${long}`)).toBeNull();
    expect(parseCommand(`qualor${spaces}${long}`)).toBeNull();
    expect(parseCommand(long)).toBeNull();
  });
});
