/**
 * The registered clients as the AS stages read them (ADR-0002 D5, D8): the
 * library's `Client.find` (public API, one adapter read), as RFC 7591
 * metadata, without the OIDC fields the library defaults on every client. A
 * confidential client's `client_secret` is its stored `s256.` hash (the
 * adapter's), which `client-auth` verifies the presented secret against.
 *
 * A stored client the library's schema refuses reads as unknown, as the
 * library itself treats it at its endpoints; M4 already dropped the 0.4.x
 * clients that fail it (D12). So does a URL-form `client_id` whose Client ID
 * Metadata Document can't be used (#46: the library's `invalid_client`, from
 * a failed fetch, a refused document, or the fetch budget), so the library
 * answers it itself, with its fixed description. Any other failure is thrown,
 * for the stage to answer with a generic 500.
 */

import type Provider from 'oidc-provider';
import { errors } from 'oidc-provider';
import type { ClientLookup, ClientMetadata } from '../client-auth.js';
import { CLIENT_ID_SCHEMA } from './adapter.js';

/**
 * OIDC fields the library fills in on every client with its own defaults.
 * `dcr-validator` never keeps them, so they say nothing about how the client
 * registered, and #55's stored-client check would flag every client for them.
 */
const LIBRARY_DEFAULTS = ['id_token_signed_response_alg', 'require_auth_time', 'subject_type'] as const;

export function libraryClients(provider: Provider): ClientLookup {
  return {
    async getClient(clientId: string): Promise<ClientMetadata | undefined> {
      // The adapter's own rule: an id it would never look up is unknown here too, without a read.
      const id = CLIENT_ID_SCHEMA.safeParse(clientId);
      if (!id.success) return undefined;
      try {
        const client = await provider.Client.find(id.data);
        if (!client) return undefined;
        const metadata: Record<string, unknown> = { ...client.metadata() };
        for (const field of LIBRARY_DEFAULTS) delete metadata[field];
        return metadata;
      } catch (err) {
        if (err instanceof errors.InvalidClientMetadata) return undefined;
        // #46: a metadata document that couldn't be fetched or used (only those throw this from find).
        if (err instanceof errors.InvalidClient) return undefined;
        throw err;
      }
    },
  };
}
