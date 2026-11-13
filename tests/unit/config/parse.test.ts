import { describe, it, expect } from 'vitest';
import { ConfigProblems, parseBoundedInteger } from '../../../src/config/parse.js';

describe('parseBoundedInteger', () => {
  it('returns the default for an unset or empty value, without range checking it', () => {
    expect(parseBoundedInteger(undefined, 5, 'X', 10, 20)).toBe(5);
    expect(parseBoundedInteger('', 5, 'X', 10, 20)).toBe(5);
  });
  it('accepts the bounds and refuses just outside them, naming the variable and range', () => {
    expect(parseBoundedInteger('10', 15, 'X', 10, 20)).toBe(10);
    expect(parseBoundedInteger('20', 15, 'X', 10, 20)).toBe(20);
    expect(() => parseBoundedInteger('9', 15, 'X', 10, 20)).toThrow(/X.*between 10 and 20/);
    expect(() => parseBoundedInteger('21', 15, 'X', 10, 20)).toThrow(/X.*between 10 and 20/);
  });
  it('keeps the strict integer rules', () => {
    expect(() => parseBoundedInteger('10ms', 15, 'X', 10, 20)).toThrow(/Invalid integer value for X/);
    expect(() => parseBoundedInteger('-12', 15, 'X', 10, 20)).toThrow(/Invalid integer value for X/);
    expect(() => parseBoundedInteger('1.5', 15, 'X', 1, 20)).toThrow(/Invalid integer value for X/);
  });
});

describe('ConfigProblems', () => {
  it('does not throw with no problems', () => {
    expect(() => new ConfigProblems().throwIfAny()).not.toThrow();
  });
  it('capture returns the parse result, or the fallback and a recorded problem', () => {
    const p = new ConfigProblems();
    expect(p.capture('A', () => 7, 0)).toBe(7);
    expect(p.count).toBe(0);
    expect(p.capture('B', () => { throw new Error('bad B'); }, 3)).toBe(3);
    expect(p.failed('B')).toBe(true);
    expect(p.failed('A')).toBe(false);
    expect(() => p.throwIfAny()).toThrow('Invalid configuration (1 problem):\n  - bad B');
  });
  it('lists every problem in order, pluralised', () => {
    const p = new ConfigProblems();
    p.add('A', 'one');
    p.add('B', 'two');
    expect(() => p.throwIfAny()).toThrow('Invalid configuration (2 problems):\n  - one\n  - two');
  });
});
