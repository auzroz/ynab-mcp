/**
 * Shared account field mapping for ynab_list_accounts and ynab_get_account.
 *
 * Money values are formatted with the budget's money formatter; the raw maps keep YNAB's
 * values (milliunits for payments and escrow) so existing consumers keep working.
 */

import DecimalJS from 'decimal.js';
import { z } from 'zod';
import type { Account } from 'ynab';
import { money as moneyText } from '../schemas/common.js';
import { usdFallbackFormatter, type MoneyFormatter } from '../../utils/milliunits.js';
import { sanitizeMemo } from '../../utils/sanitize.js';

const Decimal = DecimalJS.default ?? DecimalJS;

type MonthMap = { [key: string]: number } | null | undefined;

function formatMonthMap(map: MonthMap, format: (value: number) => string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [month, value] of Object.entries(map ?? {})) {
    if (typeof value === 'number') {
      out[month] = format(value);
    }
  }
  return out;
}

/** YNAB reports interest rates in milliunits of a percent: 18990 = 18.99%. */
function formatRate(value: number): string {
  return `${new Decimal(value).dividedBy(1000).toString()}%`;
}

function hasEntries(map: MonthMap): boolean {
  return map != null && Object.keys(map).length > 0;
}

/**
 * Detail fields shared by the list and get tools. The debt maps are keyed by
 * month (YYYY-MM-DD) and hold numbers only, so they need no sanitizing.
 * Raw rates are kept exactly as YNAB returns them (milliunits of a percent),
 * with a percent string beside them in debt_interest_rates_formatted. Empty maps are
 * omitted unless includeEmptyMaps is set.
 */
export function accountDetailFields(
  account: Account,
  options: { includeEmptyMaps: boolean },
  money: MoneyFormatter = usdFallbackFormatter
): AccountDetailFields {
  const fields: AccountDetailFields = {
    on_budget: account.on_budget,
    closed: account.closed,
    note: sanitizeMemo(account.note),
    last_reconciled_at: account.last_reconciled_at ?? null,
    direct_import_linked: account.direct_import_linked ?? null,
    direct_import_in_error: account.direct_import_in_error ?? null,
    transfer_payee_id: account.transfer_payee_id ?? null,
    debt_original_balance:
      account.debt_original_balance != null
        ? money(account.debt_original_balance)
        : null,
  };

  const maps: Array<[DebtMapKey, MonthMap, (value: number) => string]> = [
    ['debt_interest_rates', account.debt_interest_rates, formatRate],
    ['debt_minimum_payments', account.debt_minimum_payments, money],
    ['debt_escrow_amounts', account.debt_escrow_amounts, money],
  ];
  for (const [key, map, format] of maps) {
    if (!options.includeEmptyMaps && !hasEntries(map)) continue;
    fields[key] = map ?? {};
    fields[`${key}_formatted`] = formatMonthMap(map, format);
  }
  return fields;
}

type DebtMapKey = 'debt_interest_rates' | 'debt_minimum_payments' | 'debt_escrow_amounts';

const rawMonthMap = () => z.record(z.string(), z.number()).describe('Keyed by month (YYYY-MM-DD), raw YNAB values');
const formattedMonthMap = () => z.record(z.string(), z.string()).describe('Keyed by month (YYYY-MM-DD), formatted');
const MAP_NOTE = 'Omitted from ynab_list_accounts when empty; always present (possibly {}) in ynab_get_account';

/** The detail fields both account tools return (#45; rules in ../output-schema.ts). Nulls are reported on purpose. */
export const accountDetailFieldsShape = {
  on_budget: z.boolean(),
  closed: z.boolean(),
  note: z.string().nullable(),
  last_reconciled_at: z.string().nullable(),
  direct_import_linked: z.boolean().nullable(),
  direct_import_in_error: z.boolean().nullable(),
  transfer_payee_id: z.string().nullable(),
  debt_original_balance: moneyText().nullable(),
  debt_interest_rates: rawMonthMap().exactOptional().describe(`Milliunits of a percent (18990 = 18.99%). ${MAP_NOTE}`),
  debt_interest_rates_formatted: formattedMonthMap().exactOptional().describe(MAP_NOTE),
  debt_minimum_payments: rawMonthMap().exactOptional().describe(`Milliunits. ${MAP_NOTE}`),
  debt_minimum_payments_formatted: formattedMonthMap().exactOptional().describe(MAP_NOTE),
  debt_escrow_amounts: rawMonthMap().exactOptional().describe(`Milliunits. ${MAP_NOTE}`),
  debt_escrow_amounts_formatted: formattedMonthMap().exactOptional().describe(MAP_NOTE),
};
export const accountDetailFieldsSchema = z.object(accountDetailFieldsShape);
export type AccountDetailFields = z.output<typeof accountDetailFieldsSchema>;
