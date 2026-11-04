/**
 * Drop null-valued keys from a flat object.
 *
 * ynab SDK 5.0 returns `null` for nullable API fields that SDK 4.5 left
 * `undefined`, and JSON.stringify drops `undefined` but writes `null`. Wrap the
 * raw SDK fields a tool passes straight into its output (and only those) so the
 * response keeps the 0.4.x shape. Fields a tool deliberately reports as null
 * (for example through `?? null`) must stay outside the wrapper.
 *
 * Shallow on purpose: nested objects are the caller's to wrap.
 */
export type OmitNull<T extends object> = { [K in keyof T]?: Exclude<T[K], null> };

export function omitNull<T extends object>(obj: T): OmitNull<T> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== null) out[key] = value;
  }
  return out as OmitNull<T>;
}
