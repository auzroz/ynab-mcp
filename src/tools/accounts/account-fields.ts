/**
 * Shared account field mapping for ynab_list_accounts and ynab_get_account.
 *
 * Money values are formatted with formatCurrency; the raw maps keep YNAB's
 * values (milliunits for payments and escrow) so existing consumers keep working.
 */

import DecimalJS from 'decimal.js';
import type { Account } from 'ynab';
import { formatCurrency } from '../../utils/milliunits.js';
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
  options: { includeEmptyMaps: boolean }
): Record<string, unknown> {
  const fields: Record<string, unknown> = {
    on_budget: account.on_budget,
    closed: account.closed,
    note: sanitizeMemo(account.note),
    last_reconciled_at: account.last_reconciled_at ?? null,
    direct_import_linked: account.direct_import_linked ?? false,
    direct_import_in_error: account.direct_import_in_error ?? false,
    transfer_payee_id: account.transfer_payee_id ?? null,
    debt_original_balance:
      account.debt_original_balance != null
        ? formatCurrency(account.debt_original_balance)
        : null,
  };

  const maps: Array<[string, MonthMap, (value: number) => string]> = [
    ['debt_interest_rates', account.debt_interest_rates, formatRate],
    ['debt_minimum_payments', account.debt_minimum_payments, formatCurrency],
    ['debt_escrow_amounts', account.debt_escrow_amounts, formatCurrency],
  ];
  for (const [key, map, format] of maps) {
    if (!options.includeEmptyMaps && !hasEntries(map)) continue;
    fields[key] = map ?? {};
    fields[`${key}_formatted`] = formatMonthMap(map, format);
  }
  return fields;
}
