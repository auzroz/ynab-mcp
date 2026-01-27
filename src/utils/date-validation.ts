/**
 * Date Validation Utilities
 *
 * Shared validation functions for scheduled transaction dates.
 */

/**
 * Validates that a date string is in the future and within 5 years.
 * Used for scheduled transaction date validation.
 *
 * @param dateStr - Date in YYYY-MM-DD format
 * @returns Object with valid boolean and optional error message
 */
export function validateScheduledDate(dateStr: string): { valid: boolean; error?: string } {
  const [year, month, day] = dateStr.split('-').map(Number);
  if (
    year === undefined || month === undefined || day === undefined ||
    Number.isNaN(year) || Number.isNaN(month) || Number.isNaN(day)
  ) {
    return { valid: false, error: 'Invalid date format' };
  }

  const date = new Date(Date.UTC(year, month - 1, day));

  // Verify the date components match (catches invalid dates like Feb 30)
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return { valid: false, error: 'Invalid date' };
  }

  const now = new Date();
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

  if (date <= today) {
    return { valid: false, error: 'Date must be in the future' };
  }

  const maxDate = new Date(today);
  maxDate.setUTCFullYear(maxDate.getUTCFullYear() + 5);

  if (date > maxDate) {
    return { valid: false, error: 'Date must be within 5 years from today' };
  }

  return { valid: true };
}
