import { formatWhole } from '../../shared/numbers';

/** How many organisations a sentence names; the others are counted. */
const NAMED = 3;

/**
 * Organisations' names in a sentence, joined as the locale joins a list ("Acme, Payments, and
 * Lab"); past three, the first three and how many more, joined the same way ("Acme, Payments,
 * Lab, and 2 more").
 */
export function namesOf(names: readonly string[], locale: string): string {
  const list = new Intl.ListFormat(locale, { type: 'conjunction' });
  if (names.length <= NAMED) return list.format(names);
  const n = formatWhole(names.length - NAMED, locale);
  return list.format([...names.slice(0, NAMED), $localize`:@@aiProvider.names.more:${n}:n: more`]);
}
