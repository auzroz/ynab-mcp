/**
 * Rate Limiter
 * 
 * Token bucket algorithm to enforce YNAB's API rate limits.
 * YNAB allows 200 requests/hour; we default to 180 for safety margin.
 */

export class RateLimiter {
  private tokens: number;
  private lastRefill: number;
  private readonly maxTokens: number;
  private readonly refillRate: number; // tokens per millisecond
  private acquireLock: Promise<void> = Promise.resolve();

  constructor(requestsPerHour: number = 180) {
    // Validate requestsPerHour to prevent rate-limit bypass
    if (!Number.isFinite(requestsPerHour) || requestsPerHour <= 0) {
      throw new Error(`Invalid requestsPerHour: must be a positive finite number, got ${requestsPerHour}`);
    }
    this.maxTokens = requestsPerHour;
    this.tokens = requestsPerHour;
    this.lastRefill = Date.now();
    // Convert requests/hour to requests/millisecond
    this.refillRate = requestsPerHour / (60 * 60 * 1000);
  }

  /**
   * Acquire a token, waiting if necessary.
   * Call this before making any API request.
   * Uses a mutex to prevent race conditions with concurrent callers.
   */
  async acquire(): Promise<void> {
    // Chain onto the existing lock to ensure sequential execution
    const previousLock = this.acquireLock;
    let releaseLock: () => void;
    this.acquireLock = new Promise((resolve) => {
      releaseLock = resolve;
    });

    try {
      // Wait for previous acquire to complete
      await previousLock;

      this.refill();

      if (this.tokens < 1) {
        // Calculate wait time to get at least 1 token
        const waitTime = Math.ceil((1 - this.tokens) / this.refillRate);
        await this.sleep(waitTime);
        this.refill();
      }

      this.tokens -= 1;
    } finally {
      releaseLock!();
    }
  }

  /**
   * Check if a request can be made immediately.
   */
  canAcquire(): boolean {
    this.refill();
    return this.tokens >= 1;
  }

  /**
   * Get current number of available tokens.
   */
  getAvailableTokens(): number {
    this.refill();
    return Math.floor(this.tokens);
  }

  /**
   * Get estimated time until a token is available (in ms).
   */
  getWaitTime(): number {
    this.refill();
    if (this.tokens >= 1) return 0;
    return Math.ceil((1 - this.tokens) / this.refillRate);
  }

  /**
   * Get comprehensive rate limit status.
   */
  getStatus(): {
    available: number;
    limit: number;
    used: number;
    percentUsed: number;
    canMakeRequest: boolean;
    waitTimeMs: number;
    resetTimeMs: number;
  } {
    this.refill();
    const available = Math.floor(this.tokens);
    const used = this.maxTokens - available;
    const percentUsed = Math.round((used / this.maxTokens) * 100);
    // Inline wait time calculation to avoid redundant refill() call in getWaitTime()
    const waitTimeMs = this.tokens >= 1 ? 0 : Math.ceil((1 - this.tokens) / this.refillRate);
    // Time until fully refilled
    const tokensNeeded = this.maxTokens - this.tokens;
    const resetTimeMs = tokensNeeded > 0 ? Math.ceil(tokensNeeded / this.refillRate) : 0;

    return {
      available,
      limit: this.maxTokens,
      used,
      percentUsed,
      canMakeRequest: available >= 1,
      waitTimeMs,
      resetTimeMs,
    };
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    const newTokens = elapsed * this.refillRate;
    
    this.tokens = Math.min(this.maxTokens, this.tokens + newTokens);
    this.lastRefill = now;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
