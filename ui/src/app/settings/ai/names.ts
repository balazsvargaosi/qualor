import { formatWhole } from '../../shared/numbers';

/** How many organisations a sentence names; the others are counted. */
const NAMED = 3;

/**
 * Organisations' names in a sentence, as the locale lists them ("Acme, Payments, and Lab"); past
 * three, the first three and how many more ("Acme, Payments, Lab and 2 more").
 */
export function namesOf(names: readonly string[], locale: string): string {
  if (names.length <= NAMED) {
    return new Intl.ListFormat(locale, { type: 'conjunction' }).format(names);
  }
  const shown = new Intl.ListFormat(locale, { type: 'unit' }).format(names.slice(0, NAMED));
  const n = formatWhole(names.length - NAMED, locale);
  const more = $localize`:@@aiProvider.pause.more:and ${n}:n: more`;
  return `${shown} ${more}`;
}
