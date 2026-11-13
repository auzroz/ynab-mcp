/**
 * The part of the oidc-provider configuration that decides whether a client's
 * metadata is valid (ADR-0002 D2), and a validator built from it.
 *
 * M4 converts every registered 0.4.x client into a library client record and
 * validates it here (D12), so a converted client is one the running provider
 * accepts. #47-2's provider configuration must therefore spread
 * {@link CLIENT_SCHEMA_CONFIGURATION} (and may add to it only settings that
 * don't change the client schema); its test checks that a client this
 * validator accepts is found by the provider.
 *
 * D8's `application_type` rule is in ./application-type.ts.
 */

import { generateKeyPairSync } from 'node:crypto';
import Provider, { errors } from 'oidc-provider';
import type { Configuration, ClientMetadata } from 'oidc-provider';
import type { ClientSchemaValidator } from '../../storage/types.js';

/** D2: `client_secret_post` and public clients, as today. */
export const CLIENT_AUTH_METHODS = ['client_secret_post', 'none'] as const;

/**
 * The client-schema settings of D2: client authentication, defaults for what a
 * registration omits, the `code` response type, refresh tokens for clients
 * allowed them, and the feature flags that change which metadata is
 * recognized (registration and revocation on; RP-initiated logout, PAR,
 * introspection, userinfo and dev interactions off). An ID token is never
 * signed (D7), but the schema still defaults its algorithm, so the default
 * names the ephemeral key's (ES256).
 */
export const CLIENT_SCHEMA_CONFIGURATION = {
  clientAuthMethods: [...CLIENT_AUTH_METHODS],
  clientDefaults: {
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'client_secret_post',
    id_token_signed_response_alg: 'ES256',
  },
  responseTypes: ['code'],
  issueRefreshToken: async (_ctx: unknown, client: { grantTypeAllowed(type: string): boolean }) =>
    client.grantTypeAllowed('refresh_token'),
  features: {
    devInteractions: { enabled: false },
    registration: { enabled: true },
    revocation: { enabled: true },
    userinfo: { enabled: false },
    introspection: { enabled: false },
    pushedAuthorizationRequests: { enabled: false },
    rpInitiatedLogout: { enabled: false },
    claimsParameter: { enabled: false },
    deviceFlow: { enabled: false },
    clientCredentials: { enabled: false },
  },
} satisfies Configuration;

/** An ephemeral ES256 signing key: the library requires one, and no ID token is ever signed (D2, D7). */
export function ephemeralSigningKeys(): NonNullable<Configuration['jwks']> {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return { keys: [{ ...privateKey.export({ format: 'jwk' }), alg: 'ES256', use: 'sig' }] } as NonNullable<
    Configuration['jwks']
  >;
}

/** A storage adapter for the validator's provider, which must never persist anything. */
function noStorage(): never {
  throw new Error('The client-schema provider has no storage');
}

/**
 * A validator over the library's own client schema with
 * {@link CLIENT_SCHEMA_CONFIGURATION}. It builds one provider (a few
 * milliseconds; no network, no storage) and reuses it. A failure's reason is
 * the library's fixed description (it names the field, never a value).
 */
export function createClientSchemaValidator(): ClientSchemaValidator {
  const provider = new Provider('https://client-schema.invalid', {
    ...CLIENT_SCHEMA_CONFIGURATION,
    adapter: noStorage,
    jwks: ephemeralSigningKeys(),
  });
  return async (metadata) => {
    try {
      await provider.Client.validate(metadata as ClientMetadata);
      return undefined;
    } catch (err) {
      if (err instanceof errors.InvalidClientMetadata || err instanceof errors.InvalidRedirectUri) {
        return err.error_description ?? err.error;
      }
      return 'invalid client metadata';
    }
  };
}
