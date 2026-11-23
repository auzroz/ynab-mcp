/**
 * Milliunit Utilities
 *
 * YNAB uses "milliunits" for all currency values:
 * - 1 dollar = 1000 milliunits
 * - $10.50 = 10500 milliunits
 * - -$25.00 = -25000 milliunits
 *
 * IMPORTANT: Always use Decimal.js for currency calculations
 * to avoid floating point errors.
 */

import DecimalJS from 'decimal.js';
import type { CurrencyFormat } from 'ynab';
import { sanitizeString } from './sanitize.js';

// Get the Decimal constructor
const Decimal = DecimalJS.default ?? DecimalJS;

// Configure Decimal.js for financial calculations
Decimal.set({ precision: 20, rounding: Decimal.ROUND_HALF_UP });

/**
 * Convert milliunits to a formatted currency string.
 *
 * @param milliunits - The amount in milliunits (1000 = $1.00)
 * @param currencySymbol - The currency symbol to use (default: '$')
 * @returns Formatted string like "$10.50" or "-$25.00"
 */
export function formatCurrency(milliunits: number, currencySymbol = '$'): string {
  const dollars = new Decimal(milliunits).dividedBy(1000);
  const isNegative = dollars.isNegative();
  const absolute = dollars.absoluteValue();
  const formatted = absolute.toFixed(2);

  return isNegative ? `-${currencySymbol}${formatted}` : `${currencySymbol}${formatted}`;
}

/**
 * Convert milliunits to a formatted currency string using YNAB's CurrencyFormat.
 *
 * This respects the budget's currency settings including:
 * - Currency symbol and position (symbol_first)
 * - Decimal separator (. vs ,)
 * - Group separator (, vs . vs space)
 * - Number of decimal digits
 *
 * @param milliunits - The amount in milliunits (1000 = 1 currency unit)
 * @param format - YNAB CurrencyFormat object from budget settings
 * @returns Formatted string like "$10.50", "10,50 €", etc.
 */
export function formatCurrencyWithFormat(
  milliunits: number,
  format: CurrencyFormat
): string {
  const amount = new Decimal(milliunits).dividedBy(1000);
  const isNegative = amount.isNegative();
  const absolute = amount.absoluteValue();

  // Format with the correct number of decimal digits
  const formatted = absolute.toFixed(format.decimal_digits);
  const parts = formatted.split('.');
  const intPart = parts[0] ?? '0';
  const decPart = parts[1] ?? '';

  // Add group separators to the integer part (e.g., 1000000 -> 1,000,000)
  const intWithSeparators = intPart.replace(
    /\B(?=(\d{3})+(?!\d))/g,
    format.group_separator
  );

  // Combine integer and decimal parts with the correct decimal separator
  const withSeparators = decPart
    ? `${intWithSeparators}${format.decimal_separator}${decPart}`
    : intWithSeparators;

  // Add currency symbol in the correct position
  const symbol = format.display_symbol ? format.currency_symbol : '';
  const withSymbol = format.symbol_first
    ? `${symbol}${withSeparators}`
    : `${withSeparators}${symbol}`;

  return isNegative ? `-${withSymbol}` : withSymbol;
}

/** Formats a milliunit amount for display in one budget's currency. */
export type MoneyFormatter = (milliunits: number) => string;

/** The formatter used when a budget's currency format is not known: the plain "$10.50" style. */
export const usdFallbackFormatter: MoneyFormatter = (milliunits) => formatCurrency(milliunits);

function isUsableCurrencyFormat(format: unknown): format is CurrencyFormat {
  if (typeof format !== 'object' || format === null) return false;
  const f = format as Partial<CurrencyFormat>;
  return (
    typeof f.decimal_digits === 'number' &&
    Number.isInteger(f.decimal_digits) &&
    f.decimal_digits >= 0 &&
    f.decimal_digits <= 6 &&
    typeof f.decimal_separator === 'string' &&
    typeof f.group_separator === 'string' &&
    typeof f.currency_symbol === 'string' &&
    typeof f.symbol_first === 'boolean' &&
    typeof f.display_symbol === 'boolean'
  );
}

/**
 * Build the one formatter every tool routes its human-readable amounts through.
 * Without a usable currency format (settings unreadable, null, or malformed)
 * it falls back to the plain USD style so output never fails on formatting.
 */
export function makeMoneyFormatter(format: CurrencyFormat | null | undefined): MoneyFormatter {
  if (!isUsableCurrencyFormat(format)) return usdFallbackFormatter;
  // The symbol and separators come from YNAB: sanitized like other upstream strings.
  const safe: CurrencyFormat = {
    ...format,
    currency_symbol: sanitizeString(format.currency_symbol, 10) ?? '',
    decimal_separator: sanitizeString(format.decimal_separator, 3) ?? '.',
    group_separator: sanitizeString(format.group_separator, 3) ?? '',
  };
  return (milliunits) => formatCurrencyWithFormat(milliunits, safe);
}

/**
 * Convert milliunits to a decimal dollar amount.
 *
 * @param milliunits - The amount in milliunits
 * @returns Decimal instance representing the dollar amount
 */
export function toDecimal(milliunits: number): InstanceType<typeof Decimal> {
  return new Decimal(milliunits).dividedBy(1000);
}

/**
 * Convert a dollar amount to milliunits.
 *
 * @param dollars - The dollar amount (can be string or number)
 * @returns Integer milliunits
 */
export function toMilliunits(dollars: number | string): number {
  return new Decimal(dollars).times(1000).round().toNumber();
}

/**
 * Convert milliunits to cents (useful for some integrations).
 *
 * @param milliunits - The amount in milliunits
 * @returns Integer cents
 */
export function toCents(milliunits: number): number {
  return new Decimal(milliunits).dividedBy(10).round().toNumber();
}

/**
 * Add two milliunit amounts safely.
 */
export function addMilliunits(a: number, b: number): number {
  return new Decimal(a).plus(b).toNumber();
}

/**
 * Subtract two milliunit amounts safely.
 */
export function subtractMilliunits(a: number, b: number): number {
  return new Decimal(a).minus(b).toNumber();
}

/**
 * Sum an array of milliunit amounts.
 */
export function sumMilliunits(amounts: number[]): number {
  return amounts.reduce((sum, amt) => new Decimal(sum).plus(amt).toNumber(), 0);
}

/**
 * Calculate percentage of one milliunit amount relative to another.
 *
 * @param part - The partial amount
 * @param whole - The total amount
 * @returns Percentage as a number (0-100)
 */
export function percentageOfMilliunits(part: number, whole: number): number {
  if (whole === 0) return 0;
  return new Decimal(part).dividedBy(whole).times(100).toDecimalPlaces(1).toNumber();
}

/**
 * The formatter for one resolved budget, using its cached currency format.
 * Tools call this once after resolving the budget id and format every amount
 * through the result. A client without the lookup (or one that fails) gets the
 * USD fallback.
 */
export async function moneyFormatterFor(
  client: { getCurrencyFormat?: (budgetId: string) => Promise<CurrencyFormat | undefined> },
  budgetId: string
): Promise<MoneyFormatter> {
  try {
    return makeMoneyFormatter(await client.getCurrencyFormat?.(budgetId));
  } catch {
    return usdFallbackFormatter;
  }
}
