/**
 * A section's draft after new values came in: `now`, with each field that still holds what it held
 * in `from` replaced by the one in `to`. A field edited meanwhile keeps its edit, unsaved. `from`
 * is what a save sent (`to` its answer), or the values the draft last took (`to` the new ones).
 * Fields compare by identity, so an edited list is a new list.
 */
export function keepEdits<T extends object>(now: T, from: T, to: T): T {
  const merged = { ...now };
  for (const key of Object.keys(now) as (keyof T)[]) {
    if (now[key] === from[key]) merged[key] = to[key];
  }
  return merged;
}
