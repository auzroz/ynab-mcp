/**
 * Mask a UUID-style identifier for output: first 4 and last 4 characters.
 * Identifiers of 12 characters or fewer are returned as is (nothing to hide
 * that the mask would not already show).
 */
export function maskId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 4)}...${id.slice(-4)}` : id;
}
