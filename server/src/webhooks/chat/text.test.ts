import { describe, expect, it } from 'vitest';
import { localDate, slackText, teamsText, utcTime } from './text';

const Z = '​';

describe('slackText (6G R13)', () => {
  it('escapes the three characters Slack requires, so a mention never pings', () => {
    expect(slackText('<!channel> & <@U123>')).toBe('&lt;!channel&gt; &amp; &lt;@U123&gt;');
  });

  it('neutralises markup characters without dropping them', () => {
    expect(slackText('*Payments* _v2_ ~x~ `y`')).toBe(
      `${Z}*${Z}Payments${Z}*${Z} ${Z}_${Z}v2${Z}_${Z} ${Z}~${Z}x${Z}~${Z} ${Z}\`${Z}y${Z}\`${Z}`,
    );
  });

  it('makes one line and clips to the given length', () => {
    expect(slackText('a\nb\tc')).toBe('a b c');
    expect([...slackText('x'.repeat(200), 50)]).toHaveLength(50);
    expect(slackText('x'.repeat(200), 50).endsWith('…')).toBe(true);
  });
});

describe('teamsText (6G R13)', () => {
  it('neutralises Adaptive Card markdown: emphasis, links and a leading list marker', () => {
    expect(teamsText('[click](https://evil.example)')).toBe(
      `${Z}[${Z}click${Z}]${Z}(https://evil.example)`,
    );
    expect(teamsText('**bold**')).toBe(`${Z}*${Z}${Z}*${Z}bold${Z}*${Z}${Z}*${Z}`);
    expect(teamsText('- not a list')).toBe(`${Z}- not a list`);
    expect(teamsText('1. not a list')).toBe(`${Z}1. not a list`);
    expect(teamsText('# not a heading')).toBe(`${Z}# not a heading`);
  });

  it('keeps HTML as text (Teams ignores it) and makes one line', () => {
    expect(teamsText('<b>x</b>\ny')).toBe('<b>x</b> y');
  });
});

describe('times', () => {
  it('writes a UTC time to the minute', () => {
    expect(utcTime('2026-10-19T07:05:09.123Z')).toBe('2026-10-19 07:05 UTC');
  });

  it('writes a local date in the zone', () => {
    expect(localDate('2026-10-18T23:30:00Z', 'Asia/Tokyo')).toBe('2026-10-19');
    expect(localDate('2026-10-18T23:30:00Z', 'UTC')).toBe('2026-10-18');
  });
});
