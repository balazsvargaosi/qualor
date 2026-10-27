/**
 * Numbers people type into the settings, and the numbers the settings show. A field is text
 * (`inputmode` numeric or decimal), so nothing changes on the mouse wheel and a pasted
 * "2,000,000" reads as two million. The parsers take digits grouped by spaces, underscores or
 * commas in threes; a decimal comma never passes for a point, so "1,25" is refused, not 125.
 */

/** Separators a person may group digits with: spaces (no-break ones too) and underscores. */
const SEPARATORS = /[\s_\u00a0\u202f]/g;
/** Digits grouped in threes with commas ("2,000,000"). */
const GROUPED_WHOLE = /^\d{1,3}(,\d{3})+$/;
const WHOLE = /^\d{1,10}$/;
const MONEY = /^\d{1,7}(\.\d{1,2})?$/;
const GROUPED_MONEY = /^\d{1,3}(,\d{3})+(\.\d{1,2})?$/;

/** A whole number from `min` to `max`, from text as people write it; null when it is not one. */
export function parseWhole(text: string, min: number, max: number): number | null {
  let digits = text.replace(SEPARATORS, '');
  if (GROUPED_WHOLE.test(digits)) digits = digits.replaceAll(',', '');
  if (!WHOLE.test(digits)) return null;
  const n = Number(digits);
  return n >= min && n <= max ? n : null;
}

/**
 * An amount of money from 0 to `max` with at most two decimals after a point, from text as
 * people write it; null when it is not one.
 */
export function parseMoney(text: string, max: number): number | null {
  const amount = text.replace(SEPARATORS, '');
  if (!MONEY.test(amount) && !GROUPED_MONEY.test(amount)) return null;
  const n = Number(amount.replaceAll(',', ''));
  // Grouped thousands may run on past the largest number, and an unbounded `max` takes Infinity.
  return Number.isFinite(n) && n <= max ? n : null;
}

/** A whole number as the locale writes it, grouped ("2,000,000" in English). */
export function formatWhole(n: number, locale: string): string {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(n);
}

/** An amount of money as the locale writes it, with two decimals and no currency ("1.50"). */
export function formatMoney(n: number, locale: string): string {
  return new Intl.NumberFormat(locale, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n);
}

/**
 * A stored amount as the money field writes it, with every decimal it has past two ("1.255",
 * "1.50"): nothing a server holds is rounded away on screen.
 */
export function formatAmount(n: number, locale: string): string {
  return new Intl.NumberFormat(locale, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 20,
  }).format(n);
}
