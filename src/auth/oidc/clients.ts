/**
 * The registered clients as the AS stages read them (ADR-0002 D5, D8): the
 * library's `Client.find` (public API, one adapter read), as RFC 7591
 * metadata. A confidential client's `client_secret` is its stored `s256.`
 * hash (the adapter's), which `client-auth` verifies the presented secret
 * against.
 *
 * A stored client the library's schema refuses reads as unknown, as the
 * library itself treats it at its endpoints; M4 already dropped the 0.4.x
 * clients that fail it (D12). Any other failure is thrown, for the stage to
 * answer with a generic 500.
 */

import type Provider from 'oidc-provider';
import { errors } from 'oidc-provider';
import type { ClientLookup, ClientMetadata } from '../client-auth.js';

export function libraryClients(provider: Provider): ClientLookup {
  return {
    async getClient(clientId: string): Promise<ClientMetadata | undefined> {
      try {
        const client = await provider.Client.find(clientId);
        return client ? (client.metadata() as ClientMetadata) : undefined;
      } catch (err) {
        if (err instanceof errors.InvalidClientMetadata) return undefined;
        throw err;
      }
    },
  };
}
