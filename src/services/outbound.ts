/**
 * Outbound HTTP to YNAB with a deadline on every call (#58).
 *
 * Every call to YNAB (the SDK's, through its `fetchApi` hook, and the OAuth
 * token and user calls) goes through outboundFetch. It
 * - aborts after OUTBOUND_TIMEOUT_MS, and never later than the request's own
 *   deadline when one applies (a call that would start past it is not sent), so
 *   a stalled YNAB response cannot hold a request's in-flight slot past the
 *   request ceiling (ADR-0001 D5, D6);
 * - reads the whole body inside that deadline, so a slow-drip response is cut
 *   off too; the caller gets a complete Response;
 * - reports to the user's circuit breaker, when given one.
 *
 * A timeout is thrown as OutboundTimeoutError, whose message is fixed (nothing
 * from the upstream). For a write the outcome is unknown, the error says so, and
 * nothing here ever retries.
 */

import { CircuitOpenError, OutboundTimeoutError } from '../utils/errors.js';
import type { CircuitAttempt, CircuitBreaker } from './circuit-breaker.js';

/** Deadline for one outbound call (#58). */
export const OUTBOUND_TIMEOUT_MS = 10_000;

export interface OutboundOptions {
  /** Defaults to OUTBOUND_TIMEOUT_MS. */
  timeoutMs?: number | undefined;
  /** The request's absolute deadline (epoch ms): no call outlives it, none starts after it. */
  deadline?: number | undefined;
  breaker?: CircuitBreaker | undefined;
  /** Called when the call was refused before being sent (breaker open, deadline passed). */
  onNotSent?: (() => void) | undefined;
  now?: (() => number) | undefined;
  /** Looked up at call time when absent, so a stubbed global fetch is honoured. */
  fetch?: typeof fetch | undefined;
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

export async function outboundFetch(
  input: string | URL,
  init: RequestInit = {},
  opts: OutboundOptions = {}
): Promise<Response> {
  const timeoutMs = opts.timeoutMs ?? OUTBOUND_TIMEOUT_MS;
  const now = (opts.now ?? Date.now)();
  const method = (init.method ?? 'GET').toUpperCase();
  const outcomeUnknown = !SAFE_METHODS.has(method);

  const remaining = opts.deadline === undefined ? Infinity : opts.deadline - now;
  if (remaining <= 0) {
    opts.onNotSent?.();
    throw new OutboundTimeoutError(false);
  }
  let attempt: CircuitAttempt | undefined;
  try {
    attempt = opts.breaker?.admit();
  } catch (error) {
    if (error instanceof CircuitOpenError) opts.onNotSent?.();
    throw error;
  }

  // Cut short by the request's deadline: that says nothing about YNAB's health.
  const shortened = remaining < timeoutMs;
  const timeout = AbortSignal.timeout(Math.max(1, Math.min(timeoutMs, remaining)));
  const signal = init.signal ? AbortSignal.any([timeout, init.signal]) : timeout;
  try {
    const response = await (opts.fetch ?? fetch)(input, { ...init, signal });
    // Inside the deadline too: a body that drips in is aborted like a stalled response.
    const body = await response.arrayBuffer();
    if (response.status >= 500) attempt?.failure();
    else attempt?.success();
    const headers = new Headers(response.headers);
    // The body is already decoded and complete.
    headers.delete('content-encoding');
    headers.delete('content-length');
    return new Response(body.byteLength > 0 && !NULL_BODY_STATUSES.has(response.status) ? body : null, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  } catch (error) {
    if (timeout.aborted) {
      if (shortened) attempt?.cancel();
      else attempt?.failure();
      throw new OutboundTimeoutError(outcomeUnknown);
    }
    attempt?.cancel();
    throw error;
  }
}
