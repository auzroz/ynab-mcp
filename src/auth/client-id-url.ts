/**
 * Which `client_id`s are Client ID Metadata Document URLs (#46), with no
 * dependencies, so the adapter (src/auth/oidc/adapter.ts) and the AS stages
 * can ask without importing the fetch (src/auth/client-id-metadata.ts, which
 * re-exports this).
 */

/**
 * Whether a `client_id` is URL-form, the kind the library resolves from a
 * metadata document: `https://` and a URL. Registered clients' ids are UUIDs
 * (0.4.x) or the library's nanoids, never URLs.
 *
 * #64a: such a client counts as registered on 0.5.0 or later (lead
 * decision), so it must send `resource`. It has no `client_id_issued_at` to
 * tell by; its stored anchor row (adapter.ts) carries
 * {@link METADATA_DOCUMENT_ANCHOR_FIELD}.
 */
export function isMetadataDocumentClientId(clientId: unknown): boolean {
  return typeof clientId === 'string' && /^https:\/\//i.test(clientId) && URL.canParse(clientId);
}

/** The marker field of a metadata-document client's anchor row (adapter.ts). */
export const METADATA_DOCUMENT_ANCHOR_FIELD = 'client_id_metadata_document';
