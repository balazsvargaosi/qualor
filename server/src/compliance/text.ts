/** At most `max` code points of `text` (null stays null), as `char_length` counts them. */
export function cut(text: string | null, max: number): string | null {
  if (text === null) return null;
  const points = [...text];
  return points.length <= max ? text : points.slice(0, max).join('');
}
