/**
 * Date Utilities
 *
 * Provides natural language date parsing and date range helpers.
 *
 * IMPORTANT: Time zone behavior varies by function:
 *
 * - parseNaturalDate(), formatDate(), getDateRange(): Use LOCAL time.
 *   These are designed for user-facing input/output where local dates make sense.
 *
 * - getCurrentMonth(), getPreviousMonth(): Use UTC time.
 *   These are designed for YNAB API calls where UTC consistency is needed.
 *
 * - daysBetween(): Uses UTC to avoid DST edge cases.
 *
 * - isValidIsoDate(), getMonthStart(): Pure string operations, no timezone concerns.
 *
 * This split is intentional: user input (e.g., "yesterday") should respect local time,
 * while API-facing functions use UTC for consistency across time zones.
 */

/**
 * Parse natural language date expressions into YYYY-MM-DD format.
 *
 * Uses LOCAL time for all calculations. This is appropriate for user-facing
 * input where "today" and "yesterday" should reflect the user's local date.
 *
 * Supported expressions:
 * - "today", "yesterday"
 * - "this week", "last week" - Returns start of week (Sunday)
 * - "this month", "last month" - Returns first of month
 * - "this year", "last year" - Returns January 1st of the year
 * - "past N days", "last N days" - N days ago from today
 * - "past N weeks", "last N weeks" - N*7 days ago from today
 * - "past N months", "last N months" - First of the month, N months ago
 * - "past N years", "last N years" - Same day, N years ago
 * - ISO dates (YYYY-MM-DD) - Validated and passed through
 *
 * Note: "last year" returns January 1st of previous year (calendar year start),
 * while "last 1 year" returns the same day one year ago (relative date).
 * This matches common usage: "last year's transactions" vs "past year of data".
 *
 * @param input - Natural language date string or ISO date
 * @returns ISO date string (YYYY-MM-DD)
 */
export function parseNaturalDate(input: string): string {
  const normalized = input.toLowerCase().trim();
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // ISO date format - validate and pass through
  if (/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    // Validate the date is actually valid (not 2024-99-99 or 2024-02-30)
    const parts = normalized.split('-');
    const year = parseInt(parts[0] ?? '0', 10);
    const month = parseInt(parts[1] ?? '0', 10);
    const day = parseInt(parts[2] ?? '0', 10);

    if (month >= 1 && month <= 12) {
      const daysInMonth = new Date(year, month, 0).getDate();
      if (day >= 1 && day <= daysInMonth) {
        return normalized;
      }
    }
    // Invalid date values - fall through to throw error
  }

  // Today / Yesterday
  if (normalized === 'today') {
    return formatDate(today);
  }

  if (normalized === 'yesterday') {
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    return formatDate(yesterday);
  }

  // This week (start of current week - Sunday)
  if (normalized === 'this week') {
    const startOfWeek = new Date(today);
    startOfWeek.setDate(today.getDate() - today.getDay());
    return formatDate(startOfWeek);
  }

  // Last week (start of previous week)
  if (normalized === 'last week') {
    const startOfLastWeek = new Date(today);
    startOfLastWeek.setDate(today.getDate() - today.getDay() - 7);
    return formatDate(startOfLastWeek);
  }

  // This month (first of current month)
  if (normalized === 'this month') {
    const startOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);
    return formatDate(startOfMonth);
  }

  // Last month (first of previous month)
  if (normalized === 'last month') {
    const startOfLastMonth = new Date(today.getFullYear(), today.getMonth() - 1, 1);
    return formatDate(startOfLastMonth);
  }

  // This year (January 1st of current year)
  if (normalized === 'this year') {
    const startOfYear = new Date(today.getFullYear(), 0, 1);
    return formatDate(startOfYear);
  }

  // Last year (January 1st of previous year)
  if (normalized === 'last year') {
    const startOfLastYear = new Date(today.getFullYear() - 1, 0, 1);
    return formatDate(startOfLastYear);
  }

  // Past N days (e.g., "past 7 days", "past 30 days", "last 7 days")
  const pastDaysMatch = normalized.match(/^(?:past|last)\s+(\d+)\s+days?$/);
  if (pastDaysMatch) {
    const days = parseInt(pastDaysMatch[1] ?? '0', 10);
    const pastDate = new Date(today);
    pastDate.setDate(today.getDate() - days);
    return formatDate(pastDate);
  }

  // Past N weeks (e.g., "past 2 weeks", "last 4 weeks")
  const pastWeeksMatch = normalized.match(/^(?:past|last)\s+(\d+)\s+weeks?$/);
  if (pastWeeksMatch) {
    const weeks = parseInt(pastWeeksMatch[1] ?? '0', 10);
    const pastDate = new Date(today);
    pastDate.setDate(today.getDate() - weeks * 7);
    return formatDate(pastDate);
  }

  // Past N months (e.g., "past 3 months", "last 6 months")
  // Set day to 1 first to avoid month overflow (e.g., Mar 31 - 1 month = Feb 31 = Mar 3)
  const pastMonthsMatch = normalized.match(/^(?:past|last)\s+(\d+)\s+months?$/);
  if (pastMonthsMatch) {
    const months = parseInt(pastMonthsMatch[1] ?? '0', 10);
    const pastDate = new Date(today);
    pastDate.setDate(1);
    pastDate.setMonth(today.getMonth() - months);
    return formatDate(pastDate);
  }

  // Past N years (e.g., "past 2 years", "last year")
  const pastYearsMatch = normalized.match(/^(?:past|last)\s+(\d+)\s+years?$/);
  if (pastYearsMatch) {
    const years = parseInt(pastYearsMatch[1] ?? '0', 10);
    const pastDate = new Date(today);
    const originalMonth = today.getMonth();
    pastDate.setFullYear(today.getFullYear() - years);

    // Handle leap year edge case: if month rolled over, set to last day of previous month
    if (pastDate.getMonth() !== originalMonth) {
      pastDate.setDate(0); // Sets to last day of previous month
    }

    return formatDate(pastDate);
  }

  // Unrecognized format - throw error with helpful message
  throw new Error(
    `Unrecognized date format: "${input}". Use ISO format (YYYY-MM-DD) or natural language like "past 7 days", "this month", "last week".`
  );
}

/**
 * Get a date range object for common periods.
 * Uses LOCAL time (via parseNaturalDate).
 */
export function getDateRange(period: string): { start: string; end: string } {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const endDate = formatDate(today);

  const startDate = parseNaturalDate(period);

  return { start: startDate, end: endDate };
}

/**
 * Get the first day of a month in YYYY-MM-DD format.
 */
export function getMonthStart(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, '0')}-01`;
}

/**
 * Get the current month in YYYY-MM-DD format (first day).
 * Uses UTC to ensure consistency with daysBetween() and other date functions.
 */
export function getCurrentMonth(): string {
  const today = new Date();
  return getMonthStart(today.getUTCFullYear(), today.getUTCMonth() + 1);
}

/**
 * Get the previous month in YYYY-MM-DD format (first day).
 * Uses UTC to ensure consistency with daysBetween() and other date functions.
 */
export function getPreviousMonth(): string {
  const today = new Date();
  const year = today.getUTCFullYear();
  const month = today.getUTCMonth();
  // Handle January -> December of previous year
  const prevYear = month === 0 ? year - 1 : year;
  const prevMonth = month === 0 ? 12 : month;
  return getMonthStart(prevYear, prevMonth);
}

/**
 * Format a Date object as YYYY-MM-DD.
 * Uses the Date object's LOCAL time components (getFullYear, getMonth, getDate).
 */
export function formatDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Check if a string is a valid ISO date (YYYY-MM-DD).
 */
export function isValidIsoDate(input: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input)) {
    return false;
  }

  // Parse the components
  const parts = input.split('-');
  const year = parseInt(parts[0] ?? '0', 10);
  const month = parseInt(parts[1] ?? '0', 10);
  const day = parseInt(parts[2] ?? '0', 10);

  // Check month range
  if (month < 1 || month > 12) {
    return false;
  }

  // Check day range for the specific month
  const daysInMonth = new Date(year, month, 0).getDate();
  if (day < 1 || day > daysInMonth) {
    return false;
  }

  return true;
}

/**
 * Get the number of days between two dates.
 * Uses UTC midnight to avoid timezone/DST off-by-one errors.
 */
export function daysBetween(start: string, end: string): number {
  // Parse to UTC midnight to avoid timezone issues
  const startDate = new Date(start + 'T00:00:00Z');
  const endDate = new Date(end + 'T00:00:00Z');
  const diffTime = Math.abs(endDate.getTime() - startDate.getTime());
  return Math.round(diffTime / (1000 * 60 * 60 * 24));
}
