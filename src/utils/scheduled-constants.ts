/**
 * Scheduled Transaction Constants
 *
 * Shared constants for scheduled transaction tools.
 */

/**
 * YNAB scheduled transaction frequencies.
 * These match the ScheduledTransactionFrequency enum from the YNAB SDK.
 */
export const frequencies = [
  'never',
  'daily',
  'weekly',
  'everyOtherWeek',
  'twiceAMonth',
  'every4Weeks',
  'monthly',
  'everyOtherMonth',
  'every3Months',
  'every4Months',
  'twiceAYear',
  'yearly',
  'everyOtherYear',
] as const;

export type ScheduledFrequency = (typeof frequencies)[number];

/**
 * YNAB transaction flag colors.
 * These match the TransactionFlagColor enum from the YNAB SDK.
 */
export const flagColors = ['red', 'orange', 'yellow', 'green', 'blue', 'purple'] as const;

export type FlagColor = (typeof flagColors)[number];
