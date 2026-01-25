/**
 * Date Utilities Tests
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  parseNaturalDate,
  getDateRange,
  formatDate,
  isValidIsoDate,
  daysBetween,
  getCurrentMonth,
  getPreviousMonth,
} from '../../../src/utils/dates.js';

describe('Date Utilities', () => {
  beforeEach(() => {
    // Mock date to 2026-01-23 for consistent testing
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-23T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('parseNaturalDate', () => {
    it('should pass through ISO dates', () => {
      expect(parseNaturalDate('2026-01-15')).toBe('2026-01-15');
      expect(parseNaturalDate('2025-12-31')).toBe('2025-12-31');
    });

    it('should parse "today"', () => {
      expect(parseNaturalDate('today')).toBe('2026-01-23');
      expect(parseNaturalDate('TODAY')).toBe('2026-01-23');
    });

    it('should parse "yesterday"', () => {
      expect(parseNaturalDate('yesterday')).toBe('2026-01-22');
    });

    it('should parse "this week"', () => {
      // Jan 23, 2026 is a Friday, so start of week (Sunday) is Jan 18
      expect(parseNaturalDate('this week')).toBe('2026-01-18');
    });

    it('should parse "last week"', () => {
      // Start of last week would be Jan 11
      expect(parseNaturalDate('last week')).toBe('2026-01-11');
    });

    it('should parse "this month"', () => {
      expect(parseNaturalDate('this month')).toBe('2026-01-01');
    });

    it('should parse "last month"', () => {
      expect(parseNaturalDate('last month')).toBe('2025-12-01');
    });

    it('should parse "this year"', () => {
      expect(parseNaturalDate('this year')).toBe('2026-01-01');
    });

    it('should parse "last year"', () => {
      expect(parseNaturalDate('last year')).toBe('2025-01-01');
    });

    it('should parse "past N days"', () => {
      expect(parseNaturalDate('past 7 days')).toBe('2026-01-16');
      expect(parseNaturalDate('past 30 days')).toBe('2025-12-24');
      expect(parseNaturalDate('last 1 day')).toBe('2026-01-22');
    });

    it('should parse "past N weeks"', () => {
      expect(parseNaturalDate('past 2 weeks')).toBe('2026-01-09');
      expect(parseNaturalDate('last 4 weeks')).toBe('2025-12-26');
    });

    it('should parse "past N months"', () => {
      // With day set to 1 first to prevent month overflow
      expect(parseNaturalDate('past 3 months')).toBe('2025-10-01');
      expect(parseNaturalDate('last 6 months')).toBe('2025-07-01');
    });

    // Month subtraction now sets day to 1 first to prevent overflow issues
    // (e.g., Mar 31 - 1 month = Feb 31 = Mar 3 would be wrong without the fix)
    it('should handle month subtraction without overflow', () => {
      // With day set to 1 first: Jan 1 - 1 month = Dec 1
      expect(parseNaturalDate('past 1 month')).toBe('2025-12-01');
    });

    it('should handle month subtraction from end of month dates', () => {
      // Test with Jan 31 to verify no overflow
      vi.setSystemTime(new Date('2026-01-31T12:00:00Z'));
      // With day set to 1 first: Jan 1 - 1 month = Dec 1 (not Feb 31 = Mar 3)
      expect(parseNaturalDate('past 1 month')).toBe('2025-12-01');
      // Restore to Jan 23 for other tests
      vi.setSystemTime(new Date('2026-01-23T12:00:00Z'));
    });

    it('should parse "past N years"', () => {
      expect(parseNaturalDate('past 1 years')).toBe('2025-01-23');
      expect(parseNaturalDate('last 2 years')).toBe('2024-01-23');
    });

    it('should throw for unrecognized input', () => {
      expect(() => parseNaturalDate('unknown')).toThrow('Unrecognized date format');
      expect(() => parseNaturalDate('next week')).toThrow('Unrecognized date format');
    });

    it('should throw for invalid ISO dates', () => {
      // Invalid month
      expect(() => parseNaturalDate('2024-99-15')).toThrow('Unrecognized date format');
      // Invalid day for month
      expect(() => parseNaturalDate('2024-02-30')).toThrow('Unrecognized date format');
      // Invalid day
      expect(() => parseNaturalDate('2024-01-32')).toThrow('Unrecognized date format');
    });

    it('should be case insensitive', () => {
      expect(parseNaturalDate('TODAY')).toBe('2026-01-23');
      expect(parseNaturalDate('This Month')).toBe('2026-01-01');
      expect(parseNaturalDate('PAST 7 DAYS')).toBe('2026-01-16');
    });
  });

  describe('getDateRange', () => {
    it('should return start and end dates', () => {
      const range = getDateRange('past 7 days');
      expect(range.start).toBe('2026-01-16');
      expect(range.end).toBe('2026-01-23');
    });

    it('should work with this month', () => {
      const range = getDateRange('this month');
      expect(range.start).toBe('2026-01-01');
      expect(range.end).toBe('2026-01-23');
    });
  });

  describe('formatDate', () => {
    it('should format dates correctly', () => {
      // Use explicit year/month/day to avoid timezone issues
      expect(formatDate(new Date(2026, 0, 23))).toBe('2026-01-23');
      expect(formatDate(new Date(2026, 11, 5))).toBe('2026-12-05');
    });

    it('should pad single digit months and days', () => {
      expect(formatDate(new Date(2026, 0, 5))).toBe('2026-01-05');
      expect(formatDate(new Date(2026, 8, 1))).toBe('2026-09-01');
    });
  });

  describe('isValidIsoDate', () => {
    it('should return true for valid dates', () => {
      expect(isValidIsoDate('2026-01-23')).toBe(true);
      expect(isValidIsoDate('2025-12-31')).toBe(true);
    });

    it('should return false for invalid formats', () => {
      expect(isValidIsoDate('01-23-2026')).toBe(false);
      expect(isValidIsoDate('2026/01/23')).toBe(false);
      expect(isValidIsoDate('January 23, 2026')).toBe(false);
    });

    it('should return false for invalid dates', () => {
      expect(isValidIsoDate('2026-13-01')).toBe(false);
      expect(isValidIsoDate('2026-02-30')).toBe(false);
    });
  });

  describe('daysBetween', () => {
    it('should calculate days between dates', () => {
      expect(daysBetween('2026-01-01', '2026-01-31')).toBe(30);
      expect(daysBetween('2026-01-01', '2026-01-02')).toBe(1);
    });

    it('should handle reverse order', () => {
      expect(daysBetween('2026-01-31', '2026-01-01')).toBe(30);
    });

    it('should handle same day', () => {
      expect(daysBetween('2026-01-15', '2026-01-15')).toBe(0);
    });

    it('should handle DST transitions correctly', () => {
      // March 8, 2026 is DST start (spring forward) in US
      expect(daysBetween('2026-03-07', '2026-03-09')).toBe(2);
      // November 1, 2026 is DST end (fall back) in US
      expect(daysBetween('2026-10-31', '2026-11-02')).toBe(2);
    });

    it('should handle year boundaries', () => {
      expect(daysBetween('2025-12-31', '2026-01-01')).toBe(1);
      expect(daysBetween('2025-12-25', '2026-01-05')).toBe(11);
    });
  });

  describe('getCurrentMonth', () => {
    it('should return first day of current month', () => {
      expect(getCurrentMonth()).toBe('2026-01-01');
    });
  });

  describe('getPreviousMonth', () => {
    it('should return first day of previous month', () => {
      expect(getPreviousMonth()).toBe('2025-12-01');
    });
  });
});
