/**
 * Cache Service Tests
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Cache } from '../../../src/services/cache.js';

describe('Cache', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('get/set', () => {
    it('should store and retrieve values', () => {
      const cache = new Cache();
      cache.set('key', { data: 'test' });
      expect(cache.get('key')).toEqual({ data: 'test' });
    });

    it('should return undefined for missing keys', () => {
      const cache = new Cache();
      expect(cache.get('nonexistent')).toBeUndefined();
    });

    it('should return undefined for expired keys', () => {
      const cache = new Cache(1000); // 1 second TTL
      cache.set('key', 'value');

      // Advance time past TTL
      vi.advanceTimersByTime(2000);

      expect(cache.get('key')).toBeUndefined();
    });

    it('should allow custom TTL per item', () => {
      const cache = new Cache(10000); // 10 second default
      cache.set('short', 'value', 1000); // 1 second TTL
      cache.set('long', 'value', 5000); // 5 second TTL

      vi.advanceTimersByTime(2000);

      expect(cache.get('short')).toBeUndefined();
      expect(cache.get('long')).toBe('value');
    });
  });

  describe('delete', () => {
    it('should delete specific keys', () => {
      const cache = new Cache();
      cache.set('key1', 'value1');
      cache.set('key2', 'value2');

      const deleted = cache.delete('key1');

      expect(deleted).toBe(true);
      expect(cache.get('key1')).toBeUndefined();
      expect(cache.get('key2')).toBe('value2');
    });

    it('should return false for missing keys', () => {
      const cache = new Cache();
      expect(cache.delete('nonexistent')).toBe(false);
    });
  });

  describe('deleteByPrefix', () => {
    it('should delete all keys with matching prefix', () => {
      const cache = new Cache();
      cache.set('budget:123:accounts', 'data1');
      cache.set('budget:123:categories', 'data2');
      cache.set('budget:456:accounts', 'data3');
      cache.set('other', 'data4');

      const count = cache.deleteByPrefix('budget:123');

      expect(count).toBe(2);
      expect(cache.get('budget:123:accounts')).toBeUndefined();
      expect(cache.get('budget:123:categories')).toBeUndefined();
      expect(cache.get('budget:456:accounts')).toBe('data3');
      expect(cache.get('other')).toBe('data4');
    });
  });

  describe('clear', () => {
    it('should remove all entries', () => {
      const cache = new Cache();
      cache.set('key1', 'value1');
      cache.set('key2', 'value2');

      cache.clear();

      expect(cache.size()).toBe(0);
      expect(cache.get('key1')).toBeUndefined();
    });
  });

  describe('size', () => {
    it('should return number of entries', () => {
      const cache = new Cache();
      expect(cache.size()).toBe(0);

      cache.set('key1', 'value1');
      expect(cache.size()).toBe(1);

      cache.set('key2', 'value2');
      expect(cache.size()).toBe(2);
    });
  });

  describe('prune', () => {
    it('should remove expired entries', () => {
      const cache = new Cache();
      cache.set('short', 'value', 1000);
      cache.set('long', 'value', 10000);

      vi.advanceTimersByTime(2000);

      const pruned = cache.prune();

      expect(pruned).toBe(1);
      expect(cache.size()).toBe(1);
    });

    it('should return 0 when no expired entries', () => {
      const cache = new Cache();
      cache.set('key', 'value', 10000);

      const pruned = cache.prune();

      expect(pruned).toBe(0);
    });
  });
});
