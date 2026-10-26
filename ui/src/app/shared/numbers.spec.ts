import { formatMoney, formatWhole, parseMoney, parseWhole } from './numbers';

describe('parseWhole', () => {
  it('reads whole numbers written with spaces, grouped commas or underscores', () => {
    for (const t of ['2000000', '2 000 000', '2,000,000', '2_000_000', ' 2\u202f000\u202f000 ']) {
      expect(parseWhole(t, 0, 1_000_000_000)).toBe(2_000_000);
    }
    // A no-break space, as some locales group with it.
    expect(parseWhole('2\u00a0000', 0, 1_000_000_000)).toBe(2_000);
  });

  it('refuses what is not a whole number within the bounds', () => {
    for (const t of ['', '2,00,000', '1.5', '-1', '12e3', '1000000001']) {
      expect(parseWhole(t, 0, 1_000_000_000)).toBeNull();
    }
    expect(parseWhole('0', 1, 25)).toBeNull();
  });

  it('takes both bounds', () => {
    expect(parseWhole('1', 1, 25)).toBe(1);
    expect(parseWhole('25', 1, 25)).toBe(25);
    expect(parseWhole('26', 1, 25)).toBeNull();
  });
});

describe('parseMoney', () => {
  it('reads money with a decimal point and grouped thousands, never a decimal comma', () => {
    expect(parseMoney('1.25', 10_000)).toBe(1.25);
    expect(parseMoney('1,000.50', 1_000_000)).toBe(1000.5);
    for (const t of ['1,25', '1.234', '', 'US$ 2', '10000.01']) {
      expect(parseMoney(t, 10_000)).toBeNull();
    }
  });

  it('takes whole amounts, spaces and the maximum itself', () => {
    expect(parseMoney('20', 10_000)).toBe(20);
    expect(parseMoney(' 10 000 ', 10_000)).toBe(10_000);
    expect(parseMoney('0.5', 10_000)).toBe(0.5);
  });
});

describe('formatWhole and formatMoney', () => {
  it('groups as the locale writes numbers', () => {
    expect(formatWhole(2_000_000, 'en-US')).toBe('2,000,000');
    expect(formatMoney(1.5, 'en-US')).toBe('1.50');
  });

  it('write what the parsers read back', () => {
    expect(parseWhole(formatWhole(1_000_000_000, 'en-US'), 0, 1_000_000_000)).toBe(1_000_000_000);
    expect(parseMoney(formatMoney(1234.5, 'en-US'), 1_000_000)).toBe(1234.5);
  });
});
