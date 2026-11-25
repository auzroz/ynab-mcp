/**
 * LOG_LEVEL (src/utils/log.ts): one parse for both modes, and the gate on
 * debug and info lines. Warnings and errors are never gated.
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { loadConfig, loadHttpConfig } from '../../../src/config/environment.js';
import {
  DEFAULT_LOG_LEVEL,
  LOG_LEVELS,
  getLogLevel,
  logDebug,
  logInfo,
  parseLogLevel,
  setLogLevel,
  type LogLevel,
} from '../../../src/utils/log.js';
import { shutdownWithDeadline } from '../../../src/entry.js';

let errorSpy: ReturnType<typeof vi.spyOn>;
const logged = (): string => errorSpy.mock.calls.flat().map(String).join('\n');

beforeEach(() => {
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  setLogLevel(DEFAULT_LOG_LEVEL);
  vi.restoreAllMocks();
});

/** What a mode makes of LOG_LEVEL: the level, or 'refused'. */
type Outcome = LogLevel | 'refused';

function stdioOutcome(raw: string | undefined): Outcome {
  const saved = { token: process.env['YNAB_ACCESS_TOKEN'], level: process.env['LOG_LEVEL'] };
  process.env['YNAB_ACCESS_TOKEN'] = 'dummy-token';
  if (raw === undefined) delete process.env['LOG_LEVEL'];
  else process.env['LOG_LEVEL'] = raw;
  try {
    return loadConfig().logLevel;
  } catch {
    return 'refused';
  } finally {
    for (const [key, value] of [['YNAB_ACCESS_TOKEN', saved.token], ['LOG_LEVEL', saved.level]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function httpOutcome(raw: string | undefined): Outcome {
  try {
    return loadHttpConfig({ AUTH_MODE: 'header', ...(raw === undefined ? {} : { LOG_LEVEL: raw }) }).logLevel;
  } catch {
    return 'refused';
  }
}

function parsedOutcome(raw: string | undefined): Outcome {
  try {
    return parseLogLevel(raw);
  } catch {
    return 'refused';
  }
}

describe('LOG_LEVEL is parsed the same in stdio and HTTP mode', () => {
  const cases: Array<[string | undefined, Outcome]> = [
    [undefined, 'info'],
    ['', 'info'],
    ['debug', 'debug'],
    ['DEBUG', 'debug'],
    ['Info', 'info'],
    ['WARN', 'warn'],
    ['error', 'error'],
    ['trace', 'refused'],
    ['verbose', 'refused'],
    [' info', 'refused'],
  ];
  it.each(cases)('%j: %s in both modes', (raw, expected) => {
    expect(stdioOutcome(raw)).toBe(expected);
    expect(httpOutcome(raw)).toBe(expected);
    expect(parsedOutcome(raw)).toBe(expected);
  });

  it('refuses a bad value without repeating it', () => {
    expect(() => parseLogLevel('sekrit-value')).toThrow(/Invalid value for LOG_LEVEL/);
    expect(() => parseLogLevel('sekrit-value')).not.toThrow(/sekrit/);
  });
});

describe('the level gate', () => {
  it('defaults to info', () => {
    expect(getLogLevel()).toBe('info');
  });

  it.each(LOG_LEVELS)('at %s: debug lines only at debug, info lines at debug and info', (level) => {
    setLogLevel(level);
    logDebug('a debug line');
    logInfo('an info line');
    expect(logged().includes('a debug line')).toBe(level === 'debug');
    expect(logged().includes('an info line')).toBe(level === 'debug' || level === 'info');
  });

  it('writes to stderr only: stdout is the stdio JSON-RPC channel', () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const log = vi.spyOn(console, 'log');
    setLogLevel('debug');
    logDebug('d');
    logInfo('i');
    expect(stdout).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledTimes(2);
  });
});

describe('errors are shown at every level', () => {
  it.each(LOG_LEVELS)('at %s, a failed shutdown is logged; the opening line only at debug and info', async (level) => {
    setLogLevel(level);
    const exit = vi.fn();
    await shutdownWithDeadline({ close: async () => { throw new Error('boom'); }, exit });
    expect(exit).toHaveBeenCalledExactlyOnceWith(0);
    expect(logged()).toContain('Error during shutdown: boom');
    expect(logged().includes('Shutting down YNAB MCP Server')).toBe(level === 'debug' || level === 'info');
  });
});
