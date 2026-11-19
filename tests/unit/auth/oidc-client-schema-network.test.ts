/** The client-schema validator makes no network request (its documented contract). */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { createClientSchemaValidator, NETWORK_METADATA_FIELDS } from '../../../src/auth/oidc/client-schema.js';

const BASE = { client_id: 'x', redirect_uris: ['https://a.example/cb'], token_endpoint_auth_method: 'none' };

describe('createClientSchemaValidator network contract', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('refuses each network-bearing field as invalid metadata', async () => {
    const validate = createClientSchemaValidator();
    expect(NETWORK_METADATA_FIELDS).toContain('sector_identifier_uri');
    expect(await validate(BASE)).toBeUndefined();
    for (const field of NETWORK_METADATA_FIELDS) {
      const reason = await validate({ ...BASE, [field]: 'https://sector.example/uris.json' });
      expect(reason).toBe(`${field} is not supported`);
      // Present-but-empty values are refused too: the library keys on `!== undefined`.
      expect(await validate({ ...BASE, [field]: null })).toBe(`${field} is not supported`);
    }
  });

  it('makes no request for metadata that includes sector_identifier_uri', async () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error('network access attempted');
    });
    vi.stubGlobal('fetch', fetchSpy);
    const validate = createClientSchemaValidator();
    const reason = await validate({ ...BASE, sector_identifier_uri: 'https://sector.example/uris.json' });
    expect(reason).toMatch(/sector_identifier_uri/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
