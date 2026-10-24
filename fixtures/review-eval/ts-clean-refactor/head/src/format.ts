/** Formats an amount in cents as euros with two decimals: 1999 becomes "19.99". */
export function formatCents(cents: number): string {
  return (cents / 100).toFixed(2);
}
