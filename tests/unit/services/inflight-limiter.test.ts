/**
 * The in-flight caps and a request's lifetime (src/services/inflight-limiter.ts,
 * ADR-0001 D5, D6).
 */

import { describe, it, expect, vi } from 'vitest';
import { InflightLimiter, RequestLifetime, type InflightSlot } from '../../../src/services/inflight-limiter.js';

const slot = (s: InflightSlot | string): InflightSlot => {
  if (typeof s === 'string') throw new Error(`refused: ${s}`);
  return s;
};

describe('InflightLimiter', () => {
  it('caps each user, leaving other users alone', () => {
    const limiter = new InflightLimiter({ perUser: 2, perClient: 2, total: 10 });
    slot(limiter.acquire('alice', undefined));
    slot(limiter.acquire('alice', undefined));
    expect(limiter.acquire('alice', undefined)).toBe('per-user');
    slot(limiter.acquire('bob', undefined));
    expect(limiter.inflight('alice')).toBe(2);
    expect(limiter.inflight()).toBe(3);
  });

  it('caps each (client, user) below the user, so one client cannot take all of a user\'s slots', () => {
    const limiter = new InflightLimiter({ perUser: 3, perClient: 2, total: 10 });
    slot(limiter.acquire('alice', 'client-a'));
    slot(limiter.acquire('alice', 'client-a'));
    expect(limiter.acquire('alice', 'client-a')).toBe('per-client');
    // The same client for another user, and another client for this user, still get through.
    slot(limiter.acquire('bob', 'client-a'));
    slot(limiter.acquire('alice', 'client-b'));
    // Now the user is at its own cap, whichever client asks.
    expect(limiter.acquire('alice', 'client-c')).toBe('per-user');
  });

  it('keys clients and users without ambiguity', () => {
    const limiter = new InflightLimiter({ perUser: 5, perClient: 1, total: 10 });
    slot(limiter.acquire('b', 'a:'));
    // ["a:", "b"] and ["a", ":b"] are different pairs.
    slot(limiter.acquire(':b', 'a'));
  });

  it('caps the whole process, whoever asks', () => {
    const limiter = new InflightLimiter({ perUser: 8, perClient: 4, total: 2 });
    slot(limiter.acquire('a', undefined));
    slot(limiter.acquire('b', 'c1'));
    expect(limiter.acquire('c', undefined)).toBe('total');
  });

  it('frees a slot once, however many times it is released', () => {
    const limiter = new InflightLimiter({ perUser: 1, perClient: 1, total: 1 });
    const s = slot(limiter.acquire('a', 'c'));
    s.release();
    s.release();
    expect(limiter.inflight()).toBe(0);
    expect(limiter.inflight('a')).toBe(0);
    const again = slot(limiter.acquire('a', 'c'));
    // The double release did not open a second slot.
    expect(limiter.acquire('b', 'c')).toBe('total');
    again.release();
  });
});

describe('RequestLifetime (D5)', () => {
  it('releases its holds when the response closes, if no work is pending, in reverse order', () => {
    const order: string[] = [];
    const life = new RequestLifetime(Date.now() + 1000);
    expect(life.hold(() => order.push('slot'))).toBe(true);
    expect(life.hold(() => order.push('lease'))).toBe(true);
    expect(order).toEqual([]);
    life.close();
    life.close();
    expect(order).toEqual(['lease', 'slot']);
    expect(life.isReleased).toBe(true);
  });

  it('keeps its holds past the close until started work settles', async () => {
    const release = vi.fn();
    const life = new RequestLifetime(Date.now() + 1000);
    life.hold(release);
    let finish!: (v: string) => void;
    const work = life.run(() => new Promise<string>((resolve) => (finish = resolve)));
    expect(work).toBeDefined();
    life.close();
    expect(release).not.toHaveBeenCalled();
    expect(life.pendingWork).toBe(1);
    finish('done');
    await expect(work).resolves.toBe('done');
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('a failing or throwing piece of work settles too, and its rejection reaches the caller', async () => {
    const release = vi.fn();
    const life = new RequestLifetime(Date.now() + 1000);
    life.hold(release);
    const failed = life.run(() => Promise.reject(new Error('ynab down')));
    const threw = life.run(() => {
      throw new Error('sync throw');
    });
    life.close();
    await expect(failed).rejects.toThrow('ynab down');
    await expect(threw).rejects.toThrow('sync throw');
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('starts nothing and keeps nothing once the response has closed', () => {
    const life = new RequestLifetime(Date.now() + 1000);
    life.close();
    const work = vi.fn(async () => 'x');
    expect(life.run(work)).toBeUndefined();
    expect(work).not.toHaveBeenCalled();
    const late = vi.fn();
    expect(life.hold(late)).toBe(false);
    expect(late).toHaveBeenCalledTimes(1);
  });

  it('a close while work is pending refuses new work but waits for the old', async () => {
    const release = vi.fn();
    const life = new RequestLifetime(Date.now() + 1000);
    life.hold(release);
    let finish!: () => void;
    const first = life.run(() => new Promise<void>((resolve) => (finish = resolve)));
    life.close();
    expect(life.run(async () => undefined)).toBeUndefined();
    finish();
    await first;
    expect(release).toHaveBeenCalledTimes(1);
  });
});
