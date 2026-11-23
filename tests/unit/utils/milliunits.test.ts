import { describe, it, expect, vi } from 'vitest';
import {
  formatCurrency,
  formatCurrencyWithFormat,
  makeMoneyFormatter,
  moneyFormatterFor,
  usdFallbackFormatter,
  toMilliunits,
  toCents,
  addMilliunits,
  subtractMilliunits,
  sumMilliunits,
  percentageOfMilliunits,
} from '../../../src/utils/milliunits.js';
import type { CurrencyFormat } from 'ynab';

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

  describe('formatCurrencyWithFormat', () => {
    const usdFormat: CurrencyFormat = {
      iso_code: 'USD',
      example_format: '123,456.78',
      decimal_digits: 2,
      decimal_separator: '.',
      symbol_first: true,
      group_separator: ',',
      currency_symbol: '$',
      display_symbol: true,
    };

    const eurFormat: CurrencyFormat = {
      iso_code: 'EUR',
      example_format: '123.456,78',
      decimal_digits: 2,
      decimal_separator: ',',
      symbol_first: false,
      group_separator: '.',
      currency_symbol: '€',
      display_symbol: true,
    };

    const jpyFormat: CurrencyFormat = {
      iso_code: 'JPY',
      example_format: '123,456',
      decimal_digits: 0,
      decimal_separator: '.',
      symbol_first: true,
      group_separator: ',',
      currency_symbol: '¥',
      display_symbol: true,
    };

    const noSymbolFormat: CurrencyFormat = {
      iso_code: 'USD',
      example_format: '123,456.78',
      decimal_digits: 2,
      decimal_separator: '.',
      symbol_first: true,
      group_separator: ',',
      currency_symbol: '$',
      display_symbol: false,
    };

    it('formats USD correctly', () => {
      expect(formatCurrencyWithFormat(10000, usdFormat)).toBe('$10.00');
      expect(formatCurrencyWithFormat(1234567890, usdFormat)).toBe('$1,234,567.89');
      expect(formatCurrencyWithFormat(-25500, usdFormat)).toBe('-$25.50');
    });

    it('formats EUR correctly with symbol after and comma decimal', () => {
      expect(formatCurrencyWithFormat(10000, eurFormat)).toBe('10,00€');
      expect(formatCurrencyWithFormat(1234567890, eurFormat)).toBe('1.234.567,89€');
      expect(formatCurrencyWithFormat(-25500, eurFormat)).toBe('-25,50€');
    });

    it('formats JPY correctly with no decimal digits', () => {
      expect(formatCurrencyWithFormat(10000, jpyFormat)).toBe('¥10');
      expect(formatCurrencyWithFormat(1234567000, jpyFormat)).toBe('¥1,234,567');
      expect(formatCurrencyWithFormat(-25000, jpyFormat)).toBe('-¥25');
    });

    it('hides symbol when display_symbol is false', () => {
      expect(formatCurrencyWithFormat(10000, noSymbolFormat)).toBe('10.00');
      expect(formatCurrencyWithFormat(-5000, noSymbolFormat)).toBe('-5.00');
    });

    it('formats zero correctly', () => {
      expect(formatCurrencyWithFormat(0, usdFormat)).toBe('$0.00');
      expect(formatCurrencyWithFormat(0, eurFormat)).toBe('0,00€');
      expect(formatCurrencyWithFormat(0, jpyFormat)).toBe('¥0');
    });

    it('handles large numbers with group separators', () => {
      expect(formatCurrencyWithFormat(1000000000000, usdFormat)).toBe('$1,000,000,000.00');
      expect(formatCurrencyWithFormat(1000000000000, eurFormat)).toBe('1.000.000.000,00€');
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

  describe('makeMoneyFormatter (#49)', () => {
    const base: CurrencyFormat = {
      iso_code: 'USD',
      example_format: '123,456.78',
      decimal_digits: 2,
      decimal_separator: '.',
      symbol_first: true,
      group_separator: ',',
      currency_symbol: '$',
      display_symbol: true,
    };
    const eur: CurrencyFormat = { ...base, iso_code: 'EUR', decimal_separator: ',', group_separator: '.', symbol_first: false, currency_symbol: '€' };
    const jpy: CurrencyFormat = { ...base, iso_code: 'JPY', decimal_digits: 0, currency_symbol: '¥' };
    const bhd: CurrencyFormat = { ...base, iso_code: 'BHD', decimal_digits: 3, currency_symbol: 'BD' };

    it('formats USD with group separators', () => {
      const money = makeMoneyFormatter(base);
      expect(money(3000000)).toBe('$3,000.00');
      expect(money(-25500)).toBe('-$25.50');
      expect(money(0)).toBe('$0.00');
    });

    it('puts the symbol after the amount with comma decimals (EUR)', () => {
      const money = makeMoneyFormatter(eur);
      expect(money(1234567890)).toBe('1.234.567,89€');
      expect(money(-25500)).toBe('-25,50€');
    });

    it('uses zero decimal places (JPY)', () => {
      const money = makeMoneyFormatter(jpy);
      expect(money(1234567000)).toBe('¥1,234,567');
      expect(money(-25000)).toBe('-¥25');
      expect(money(0)).toBe('¥0');
    });

    it('uses three decimal places (BHD)', () => {
      const money = makeMoneyFormatter(bhd);
      expect(money(1234567)).toBe('BD1,234.567');
      expect(money(-500)).toBe('-BD0.500');
      expect(money(1)).toBe('BD0.001');
    });

    it('omits the symbol when display_symbol is false, keeping the sign', () => {
      const money = makeMoneyFormatter({ ...eur, display_symbol: false });
      expect(money(10000)).toBe('10,00');
      expect(money(-1234500)).toBe('-1.234,50');
    });

    it('sanitizes the symbol and separators it takes from YNAB', () => {
      const money = makeMoneyFormatter({ ...base, currency_symbol: '<b>\u0000$', group_separator: ',\u0007' });
      expect(money(1234000)).not.toMatch(/[\u0000-\u001f]/);
      expect(money(1234000)).toContain('1,234.00');
    });

    it('keeps a space group separator (French, Swedish, Czech: no trimming)', () => {
      const money = makeMoneyFormatter({ ...eur, group_separator: ' ' });
      expect(money(1234560)).toBe('1 234,56€');
    });

    it('keeps a no-break space (U+00A0) and a narrow no-break space (U+202F) group separator', () => {
      expect(makeMoneyFormatter({ ...eur, group_separator: '\u00A0' })(1234560)).toBe('1\u00A0234,56€');
      expect(makeMoneyFormatter({ ...eur, group_separator: '\u202F' })(1234560)).toBe('1\u202F234,56€');
    });

    it('keeps a non-ASCII symbol, and a space inside it', () => {
      const pln = { ...eur, currency_symbol: ' zł', group_separator: '\u00A0' };
      expect(makeMoneyFormatter(pln)(1234560)).toBe('1\u00A0234,56 zł');
      expect(makeMoneyFormatter({ ...base, currency_symbol: '₹' })(1234560)).toBe('₹1,234.56');
    });

    it('keeps the sign outside the symbol when the symbol comes first', () => {
      expect(makeMoneyFormatter(base)(-1000)).toBe('-$1.00');
    });

    it('rounds half up to the places of the format', () => {
      expect(makeMoneyFormatter(jpy)(1500)).toBe('¥2');
      expect(makeMoneyFormatter(base)(1005)).toBe('$1.01');
    });

    it.each([undefined, null, {}, { ...base, decimal_digits: -1 }, { ...base, decimal_digits: 1.5 }, { ...base, currency_symbol: 5 }])(
      'falls back to the USD style for an unusable format %#',
      (bad) => {
        const money = makeMoneyFormatter(bad as never);
        expect(money).toBe(usdFallbackFormatter);
        expect(money(1234500)).toBe('$1234.50');
        expect(money(-25500)).toBe('-$25.50');
      }
    );
  });

  describe('moneyFormatterFor (#49)', () => {
    const eur: CurrencyFormat = {
      iso_code: 'EUR',
      example_format: '123.456,78',
      decimal_digits: 2,
      decimal_separator: ',',
      symbol_first: false,
      group_separator: '.',
      currency_symbol: '€',
      display_symbol: true,
    };

    it('uses the format the client returns for the budget', async () => {
      const getCurrencyFormat = vi.fn(async () => eur);
      const money = await moneyFormatterFor({ getCurrencyFormat }, 'budget-uuid');
      expect(getCurrencyFormat).toHaveBeenCalledWith('budget-uuid');
      expect(money(1500000)).toBe('1.500,00€');
    });

    it('falls back to USD when the format is unreadable', async () => {
      const money = await moneyFormatterFor({ getCurrencyFormat: async () => undefined }, 'b');
      expect(money(1500000)).toBe('$1500.00');
    });

    it('falls back to USD when the lookup throws or the client has none', async () => {
      const throwing = await moneyFormatterFor(
        { getCurrencyFormat: async () => { throw new Error('boom'); } },
        'b'
      );
      expect(throwing(10000)).toBe('$10.00');
      const missing = await moneyFormatterFor({}, 'b');
      expect(missing(10000)).toBe('$10.00');
    });
  });
});
