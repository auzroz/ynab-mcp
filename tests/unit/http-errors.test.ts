/**
 * HTTP app-level error handler: logs a sanitized line, responds generically.
 */

import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';

vi.mock('../../src/server.js', () => ({
  createServerForUser: () => {
    throw new Error('boom internal detail');
  },
}));

import { createHttpApp } from '../../src/http.js';
import type { HttpConfig } from '../../src/config/environment.js';

const config = {
  port: 0,
  trustProxy: 0,
  enableDnsRebindingProtection: false,
  fallbackAccessToken: 'env-token',
  readOnly: true,
  cacheTtlMs: 300000,
  rateLimitPerHour: 180,
  authMode: 'header',
  allowWrite: true,
  accessTokenTtlSec: 3600,
  authCodeTtlSec: 600,
  storageDriver: 'memory',
} as unknown as HttpConfig;

describe('HTTP error handler', () => {
  it('logs once to stderr and returns a generic -32603 body on route failure', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const app = await createHttpApp(config);
    spy.mockClear();
    const res = await request(app)
      .post('/mcp')
      .send({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 't', version: '0' },
        },
      });
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe(-32603);
    expect(JSON.stringify(res.body)).not.toContain('boom');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toBe('[HttpError]');
    spy.mockRestore();
  });
});
