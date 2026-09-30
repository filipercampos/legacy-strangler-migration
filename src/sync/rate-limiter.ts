import { setTimeout as sleep } from 'node:timers/promises';

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

const systemClock: Clock = { now: () => Date.now(), sleep: (ms) => sleep(ms) };

/**
 * Token bucket in rows per second. The backfill reads from the production legacy primary,
 * so it is throttled to a budget agreed with the DBAs instead of "as fast as possible".
 */
export class RateLimiter {
  private tokens: number;
  private last: number;

  constructor(
    private readonly rowsPerSecond: number,
    private readonly clock: Clock = systemClock,
  ) {
    this.tokens = rowsPerSecond;
    this.last = clock.now();
  }

  /** Waits until `rows` tokens are available, then consumes them. Returns the wait in ms. */
  async acquire(rows: number): Promise<number> {
    this.refill();
    this.tokens -= rows;
    if (this.tokens >= 0) return 0;
    const wait = Math.ceil((-this.tokens / this.rowsPerSecond) * 1_000);
    await this.clock.sleep(wait);
    this.refill();
    return wait;
  }

  private refill(): void {
    const now = this.clock.now();
    const elapsed = (now - this.last) / 1_000;
    this.last = now;
    this.tokens = Math.min(this.rowsPerSecond, this.tokens + elapsed * this.rowsPerSecond);
  }
}
