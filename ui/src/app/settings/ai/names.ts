import { formatWhole } from '../../shared/numbers';

/** How many organisations a sentence names; the others are counted. */
const NAMED = 3;

/**
 * Organisations' names in a sentence, joined as the locale joins a list ("Acme, Payments, and
 * Lab"); past three, the first three and how many more, joined the same way ("Acme, Payments,
 * Lab, and 2 more"). `unnamed` are more organisations the page cannot name (their list could not
 * be read): counted with the others, or alone ("3 organizations").
 */
export function namesOf(names: readonly string[], locale: string, unnamed = 0): string {
  const n = (count: number) => formatWhole(count, locale);
  if (names.length === 0 && unnamed > 0) {
    return unnamed === 1
      ? $localize`:@@aiProvider.names.countOne:1 organization`
      : $localize`:@@aiProvider.names.count:${n(unnamed)}:n: organizations`;
  }
  const list = new Intl.ListFormat(locale, { type: 'conjunction' });
  const shown = names.slice(0, NAMED);
  const more = names.length - shown.length + unnamed;
  if (more === 0) return list.format(shown);
  return list.format([...shown, $localize`:@@aiProvider.names.more:${n(more)}:n: more`]);
}
