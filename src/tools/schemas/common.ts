/**
 * Field schemas shared by tool output schemas (#45; rules in ../output-schema.ts).
 *
 * Omitted keys use `.exactOptional()`, not `.optional()`: the advertised JSON
 * Schema is the same, but under `exactOptionalPropertyTypes` the handler's
 * typed return then rejects a `key: undefined` at compile time (rule 6), which
 * the JSON round trip in the tests cannot see.
 */

import { z } from 'zod';
import { YNAB_FIELD_MARKER } from '../output-schema.js';

/**
 * Mark a field the tool copies verbatim from YNAB (output-schema.ts rule 8):
 * advertised as optional and nullable, checked as declared in the tests.
 * Wrap the property's whole schema, outermost (`.describe()` and
 * `.exactOptional()` may follow; `.nullable()` may not).
 */
export function fromYnab<T extends z.ZodType>(schema: T): T {
  return schema.meta({ [YNAB_FIELD_MARKER]: true }) as T;
}

/** An amount formatted in the budget's currency, such as "$1,234.56". */
export const money = () => z.string();

/** A raw YNAB amount in milliunits (1/1000 of the currency unit). */
export const milliunits = () => z.number().int();

/** A count of items. */
export const count = () => z.number().int();

/** A YNAB server_knowledge value (the delta cursor). */
export const serverKnowledge = () => z.number().int();

/** A budget's currency format as the budget tools report it (sanitized strings). */
export const currencyFormatSchema = z.object({
  iso_code: z.string(),
  example_format: z.string(),
  decimal_digits: fromYnab(z.number().int()),
  decimal_separator: z.string(),
  symbol_first: fromYnab(z.boolean()),
  group_separator: z.string(),
  currency_symbol: z.string(),
  display_symbol: fromYnab(z.boolean()),
});

/** A budget's date format, such as {"format": "MM/DD/YYYY"}. */
export const dateFormatSchema = z.object({ format: z.string() });
