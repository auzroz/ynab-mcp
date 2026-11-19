/**
 * A byte budget shared by one user's caches (#58).
 *
 * Entry-count bounds don't bound memory: one user's snapshots of a large budget
 * can be megabytes each. A ByteBudget caps the serialized size (UTF-8 bytes of
 * the JSON text, measured when an entry is stored) of everything the user's
 * Cache and DeltaCache hold together. When a store pushes the total past the
 * cap, the least recently used entries across both are evicted until it fits;
 * a single entry bigger than the whole cap is not kept at all.
 *
 * Recency is a counter (tick) the budget hands out, so Cache and DeltaCache
 * agree on an order without sharing a clock.
 */

/** Default cap per user: 8 MiB. */
export const DEFAULT_USER_CACHE_BYTES = 8 * 1024 * 1024;

/** A store the budget can evict from, least recently used first. */
export interface ByteBudgetMember {
  /** Tick of the member's least recently used entry; undefined when it holds none. */
  budgetOldestTick(): number | undefined;
  /** Remove that entry (the member reports the freed bytes through sub()). */
  budgetEvictOldest(): void;
}

/** Serialized size of a value as stored: UTF-8 bytes of its JSON text. */
export function serializedBytes(value: unknown): number {
  // undefined and functions have no JSON text; a cache never holds those on purpose.
  return Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8');
}

export class ByteBudget {
  private bytes = 0;
  private ticks = 0;
  private readonly members: ByteBudgetMember[] = [];

  constructor(readonly maxBytes: number = DEFAULT_USER_CACHE_BYTES) {
    if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
      throw new Error(`Invalid cache byte budget: ${maxBytes}. Must be a positive finite number.`);
    }
  }

  register(member: ByteBudgetMember): void {
    this.members.push(member);
  }

  /** A fresh recency stamp: larger means more recently used. */
  tick(): number {
    return ++this.ticks;
  }

  /** Bytes held across the members. */
  get used(): number {
    return this.bytes;
  }

  add(bytes: number): void {
    this.bytes += bytes;
  }

  sub(bytes: number): void {
    this.bytes = Math.max(0, this.bytes - bytes);
  }

  /** Whether one entry of this size can be kept at all. */
  fits(bytes: number): boolean {
    return bytes <= this.maxBytes;
  }

  /** Evict least recently used entries, across all members, until the total fits. Returns how many. */
  enforce(): number {
    let evicted = 0;
    while (this.bytes > this.maxBytes) {
      let oldest: ByteBudgetMember | undefined;
      let oldestTick = Infinity;
      for (const member of this.members) {
        const tick = member.budgetOldestTick();
        if (tick !== undefined && tick < oldestTick) {
          oldest = member;
          oldestTick = tick;
        }
      }
      if (oldest === undefined) break;
      oldest.budgetEvictOldest();
      evicted++;
    }
    return evicted;
  }
}
