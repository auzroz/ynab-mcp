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
