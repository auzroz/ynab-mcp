import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadHttpConfig } from '../../../src/config/environment.js';

const KEYS = [
  'PUBLIC_URL', 'MCP_RESOURCE_URL', 'ALLOWED_HOSTS', 'ALLOWED_ORIGINS', 'ENABLE_DNS_REBINDING_PROTECTION',
  'MCP_MAX_SESSIONS', 'MCP_MAX_SESSIONS_PER_USER', 'MCP_SESSION_IDLE_TIMEOUT_MS', 'PORT',
  'YNAB_OAUTH_CLIENT_ID', 'YNAB_OAUTH_CLIENT_SECRET', 'ENCRYPTION_KEY',
  // Also read by loadHttpConfig (directly or through loadConfig); cleared so an
  // ambient value can't make a test that expects success throw.
  'TRUST_PROXY', 'YNAB_OAUTH_ALLOW_WRITE', 'MCP_ACCESS_TOKEN_TTL_SEC', 'MCP_AUTH_CODE_TTL_SEC',
  'STORAGE_DRIVER', 'SQLITE_PATH', 'DATABASE_URL',
  'YNAB_ACCESS_TOKEN', 'YNAB_BUDGET_ID', 'YNAB_READ_ONLY', 'CACHE_TTL_MS', 'RATE_LIMIT_PER_HOUR', 'LOG_LEVEL',
];

describe('loadHttpConfig', () => {
  let saved: NodeJS.ProcessEnv;
  beforeEach(() => {
    saved = { ...process.env };
    for (const k of KEYS) delete process.env[k];
  });
  afterEach(() => {
    process.env = saved;
  });

  describe('resource URL', () => {
    it('is undefined with no PUBLIC_URL', () => {
      expect(loadHttpConfig().resourceUrl).toBeUndefined();
    });
    it('defaults to PUBLIC_URL + /mcp (trailing slash trimmed)', () => {
      process.env['PUBLIC_URL'] = 'https://mcp.example.com/';
      expect(loadHttpConfig().resourceUrl).toBe('https://mcp.example.com/mcp');
    });
    it('can be overridden', () => {
      process.env['PUBLIC_URL'] = 'https://mcp.example.com';
      process.env['MCP_RESOURCE_URL'] = 'https://api.example.com/ynab';
      expect(loadHttpConfig().resourceUrl).toBe('https://api.example.com/ynab');
    });
    it.each(['http://localhost:3000/mcp', 'http://127.0.0.1:3000/mcp', 'http://[::1]:3000/mcp'])(
      'allows http for loopback (%s)', (u) => {
        process.env['MCP_RESOURCE_URL'] = u;
        expect(loadHttpConfig().resourceUrl).toBe(u);
      });
    it('rejects http for non-loopback hosts', () => {
      process.env['MCP_RESOURCE_URL'] = 'http://mcp.example.com/mcp';
      expect(() => loadHttpConfig()).toThrow(/MCP_RESOURCE_URL.*https/);
    });
    it('rejects non-http schemes, relative URLs and fragments', () => {
      for (const bad of ['ftp://mcp.example.com/mcp', '/mcp', 'not a url', 'https://mcp.example.com/mcp#frag', 'https://mcp.example.com/mcp#']) {
        process.env['MCP_RESOURCE_URL'] = bad;
        expect(() => loadHttpConfig(), bad).toThrow(/MCP_RESOURCE_URL/);
      }
    });
    it('does not echo credentials from a rejected URL', () => {
      const secret = 'dummy-secret';
      for (const bad of [`http://user:${secret}@mcp.example.com/mcp`, `https://user:${secret}@[bad/mcp`]) {
        process.env['MCP_RESOURCE_URL'] = bad;
        let message = '';
        try {
          loadHttpConfig();
        } catch (e) {
          message = (e as Error).message;
        }
        expect(message, bad).toMatch(/MCP_RESOURCE_URL/);
        expect(message, bad).not.toContain(secret);
      }
    });
    it('applies the same rules to PUBLIC_URL', () => {
      process.env['PUBLIC_URL'] = 'http://mcp.example.com';
      expect(() => loadHttpConfig()).toThrow(/PUBLIC_URL/);
      process.env['PUBLIC_URL'] = 'http://localhost:3000';
      expect(loadHttpConfig().resourceUrl).toBe('http://localhost:3000/mcp');
    });
  });

  describe('OAuth issuer (PUBLIC_URL)', () => {
    function enableOAuth(): void {
      process.env['YNAB_OAUTH_CLIENT_ID'] = 'cid';
      process.env['YNAB_OAUTH_CLIENT_SECRET'] = 'sec';
      process.env['ENCRYPTION_KEY'] = 'k'.repeat(44);
    }
    it('rejects http://[::1] in OAuth mode with a clear message (the SDK accepts no such issuer)', () => {
      enableOAuth();
      process.env['PUBLIC_URL'] = 'http://[::1]:3000';
      expect(() => loadHttpConfig()).toThrow(/PUBLIC_URL.*localhost or 127\.0\.0\.1.*\[::1\]/);
    });
    it.each(['http://localhost:3000', 'http://127.0.0.1:3000', 'https://[::1]:3000'])(
      'accepts %s in OAuth mode', (u) => {
        enableOAuth();
        process.env['PUBLIC_URL'] = u;
        expect(loadHttpConfig().authMode).toBe('oauth');
      });
    it('still accepts http://[::1] in header mode', () => {
      process.env['PUBLIC_URL'] = 'http://[::1]:3000';
      const c = loadHttpConfig();
      expect(c.authMode).toBe('header');
      expect(c.resourceUrl).toBe('http://[::1]:3000/mcp');
    });
  });

  describe('DNS rebinding protection', () => {
    it('is on by default, with localhost variants when PUBLIC_URL is unset', () => {
      process.env['PORT'] = '4000';
      const c = loadHttpConfig();
      expect(c.enableDnsRebindingProtection).toBe(true);
      expect(c.allowedHosts).toEqual(expect.arrayContaining([
        'localhost', 'localhost:4000', '127.0.0.1', '127.0.0.1:4000', '[::1]', '[::1]:4000',
      ]));
      expect(c.allowedOrigins).toBeUndefined();
    });
    it('derives host and origin from a public PUBLIC_URL without localhost variants', () => {
      process.env['PUBLIC_URL'] = 'https://mcp.example.com';
      const c = loadHttpConfig();
      expect(c.allowedHosts).toEqual(['mcp.example.com']);
      expect(c.allowedOrigins).toEqual(['https://mcp.example.com']);
    });
    it('keeps a non-default port in the derived host', () => {
      process.env['PUBLIC_URL'] = 'https://mcp.example.com:8443';
      expect(loadHttpConfig().allowedHosts).toEqual(['mcp.example.com:8443']);
    });
    it('adds localhost variants for a loopback PUBLIC_URL', () => {
      process.env['PUBLIC_URL'] = 'http://localhost:3000';
      const c = loadHttpConfig();
      expect(c.allowedHosts).toContain('localhost:3000');
      expect(c.allowedHosts).toContain('127.0.0.1');
      expect(c.allowedOrigins).toEqual(['http://localhost:3000']);
    });
    it('explicit ALLOWED_HOSTS / ALLOWED_ORIGINS fully replace derived defaults', () => {
      process.env['PUBLIC_URL'] = 'https://mcp.example.com';
      process.env['ALLOWED_HOSTS'] = 'a.example.com, b.example.com';
      process.env['ALLOWED_ORIGINS'] = 'https://a.example.com';
      const c = loadHttpConfig();
      expect(c.allowedHosts).toEqual(['a.example.com', 'b.example.com']);
      expect(c.allowedOrigins).toEqual(['https://a.example.com']);
    });
    it('can be disabled explicitly, and typos are rejected', () => {
      process.env['ENABLE_DNS_REBINDING_PROTECTION'] = 'false';
      expect(loadHttpConfig().enableDnsRebindingProtection).toBe(false);
      process.env['ENABLE_DNS_REBINDING_PROTECTION'] = 'flase';
      expect(() => loadHttpConfig()).toThrow(/ENABLE_DNS_REBINDING_PROTECTION/);
    });
  });

  describe('session caps', () => {
    it('has defaults', () => {
      const c = loadHttpConfig();
      expect(c.maxSessions).toBe(100);
      expect(c.maxSessionsPerUser).toBe(10);
      expect(c.sessionIdleTimeoutMs).toBe(30 * 60 * 1000);
    });
    it('parses valid values', () => {
      process.env['MCP_MAX_SESSIONS'] = '5';
      process.env['MCP_MAX_SESSIONS_PER_USER'] = '2';
      process.env['MCP_SESSION_IDLE_TIMEOUT_MS'] = '60000';
      const c = loadHttpConfig();
      expect(c.maxSessions).toBe(5);
      expect(c.maxSessionsPerUser).toBe(2);
      expect(c.sessionIdleTimeoutMs).toBe(60000);
    });
    it('rejects integers too large to be exact', () => {
      for (const v of ['9'.repeat(309), String(Number.MAX_SAFE_INTEGER + 2)]) {
        process.env['MCP_MAX_SESSIONS'] = v;
        expect(() => loadHttpConfig(), v.slice(0, 20)).toThrow(/MCP_MAX_SESSIONS/);
      }
    });
    it('rejects a per-user cap above the global cap', () => {
      process.env['MCP_MAX_SESSIONS'] = '5';
      process.env['MCP_MAX_SESSIONS_PER_USER'] = '6';
      expect(() => loadHttpConfig()).toThrow(/MCP_MAX_SESSIONS_PER_USER.*MCP_MAX_SESSIONS/);
      process.env['MCP_MAX_SESSIONS_PER_USER'] = '5';
      expect(loadHttpConfig().maxSessionsPerUser).toBe(5);
    });
    it('lowers the default per-user cap to a smaller global cap', () => {
      process.env['MCP_MAX_SESSIONS'] = '3';
      expect(loadHttpConfig().maxSessionsPerUser).toBe(3);
    });
    it.each(['10ms', '-1', '1.5', 'abc', '0'])('rejects %s', (v) => {
      process.env['MCP_MAX_SESSIONS'] = v;
      expect(() => loadHttpConfig()).toThrow(/MCP_MAX_SESSIONS/);
      delete process.env['MCP_MAX_SESSIONS'];
      process.env['MCP_MAX_SESSIONS_PER_USER'] = v;
      expect(() => loadHttpConfig()).toThrow(/MCP_MAX_SESSIONS_PER_USER/);
      delete process.env['MCP_MAX_SESSIONS_PER_USER'];
      process.env['MCP_SESSION_IDLE_TIMEOUT_MS'] = v;
      expect(() => loadHttpConfig()).toThrow(/MCP_SESSION_IDLE_TIMEOUT_MS/);
    });
  });
});
