import { describe, it, expect } from 'vitest';
import {
  formatCurrency,
  toMilliunits,
  toCents,
  addMilliunits,
  subtractMilliunits,
  sumMilliunits,
  percentageOfMilliunits,
} from '../../../src/utils/milliunits.js';

describe('milliunits utilities', () => {
  describe('formatCurrency', () => {
    it('formats positive amounts', () => {
      expect(formatCurrency(10000)).toBe('$10.00');
      expect(formatCurrency(10500)).toBe('$10.50');
      expect(formatCurrency(1000000)).toBe('$1000.00');
    });

    it('formats negative amounts', () => {
      expect(formatCurrency(-10000)).toBe('-$10.00');
      expect(formatCurrency(-25500)).toBe('-$25.50');
    });

    it('formats zero', () => {
      expect(formatCurrency(0)).toBe('$0.00');
    });

    it('formats small amounts', () => {
      expect(formatCurrency(1)).toBe('$0.00'); // 0.001 rounds to 0.00
      expect(formatCurrency(5)).toBe('$0.01'); // 0.005 rounds to 0.01
      expect(formatCurrency(10)).toBe('$0.01');
      expect(formatCurrency(100)).toBe('$0.10');
    });

    it('uses custom currency symbol', () => {
      expect(formatCurrency(10000, '€')).toBe('€10.00');
      expect(formatCurrency(-5000, '£')).toBe('-£5.00');
    });
  });

  describe('toMilliunits', () => {
    it('converts dollars to milliunits', () => {
      expect(toMilliunits(10)).toBe(10000);
      expect(toMilliunits(10.5)).toBe(10500);
      expect(toMilliunits(0.01)).toBe(10);
    });

    it('handles string input', () => {
      expect(toMilliunits('25.50')).toBe(25500);
      expect(toMilliunits('100')).toBe(100000);
    });

    it('handles negative amounts', () => {
      expect(toMilliunits(-25)).toBe(-25000);
      expect(toMilliunits(-0.5)).toBe(-500);
    });

    it('rounds to nearest milliunit', () => {
      expect(toMilliunits(10.0005)).toBe(10001);
      expect(toMilliunits(10.0004)).toBe(10000);
    });
  });

  describe('toCents', () => {
    it('converts milliunits to cents', () => {
      expect(toCents(10000)).toBe(1000); // $10.00 = 1000 cents
      expect(toCents(10500)).toBe(1050); // $10.50 = 1050 cents
      expect(toCents(-5000)).toBe(-500); // -$5.00 = -500 cents
    });
  });

  describe('addMilliunits', () => {
    it('adds two amounts', () => {
      expect(addMilliunits(10000, 5000)).toBe(15000);
      expect(addMilliunits(-10000, 5000)).toBe(-5000);
    });
  });

  describe('subtractMilliunits', () => {
    it('subtracts two amounts', () => {
      expect(subtractMilliunits(10000, 3000)).toBe(7000);
      expect(subtractMilliunits(5000, 10000)).toBe(-5000);
    });
  });

  describe('sumMilliunits', () => {
    it('sums an array of amounts', () => {
      expect(sumMilliunits([1000, 2000, 3000])).toBe(6000);
      expect(sumMilliunits([10000, -5000, 2500])).toBe(7500);
    });

    it('returns 0 for empty array', () => {
      expect(sumMilliunits([])).toBe(0);
    });
  });

  describe('percentageOfMilliunits', () => {
    it('calculates percentage', () => {
      expect(percentageOfMilliunits(5000, 10000)).toBe(50);
      expect(percentageOfMilliunits(2500, 10000)).toBe(25);
      expect(percentageOfMilliunits(10000, 10000)).toBe(100);
    });

    it('returns 0 when whole is 0', () => {
      expect(percentageOfMilliunits(5000, 0)).toBe(0);
    });

    it('rounds to one decimal place', () => {
      expect(percentageOfMilliunits(3333, 10000)).toBe(33.3);
    });
  });
});
