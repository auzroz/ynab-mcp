/**
 * Field schemas shared by tool output schemas (#45; rules in ../output-schema.ts).
 *
 * Omitted keys use `.exactOptional()`, not `.optional()`: the advertised JSON
 * Schema is the same, but under `exactOptionalPropertyTypes` the handler's
 * typed return then rejects a `key: undefined` at compile time (rule 6), which
 * the JSON round trip in the tests cannot see.
 */

import { z } from 'zod';

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
  decimal_digits: z.number().int(),
  decimal_separator: z.string(),
  symbol_first: z.boolean(),
  group_separator: z.string(),
  currency_symbol: z.string(),
  display_symbol: z.boolean(),
});

/** A budget's date format, such as {"format": "MM/DD/YYYY"}. */
export const dateFormatSchema = z.object({ format: z.string() });
