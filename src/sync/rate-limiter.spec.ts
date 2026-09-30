import { type Clock, RateLimiter } from './rate-limiter';

function fakeClock(): Clock & { slept: number[] } {
  let now = 0;
  const slept: number[] = [];
  return {
    slept,
    now: () => now,
    sleep: (ms) => {
      slept.push(ms);
      now += ms;
      return Promise.resolve();
    },
  };
}

describe('RateLimiter', () => {
  it('lets the first second of budget through, then paces to the configured rate', async () => {
    const clock = fakeClock();
    const limiter = new RateLimiter(1_000, clock);
    expect(await limiter.acquire(1_000)).toBe(0);
    expect(await limiter.acquire(500)).toBe(500);
    expect(await limiter.acquire(1_000)).toBe(1_000);
    expect(clock.slept).toEqual([500, 1_000]);
  });

  it('never accumulates more than one second of burst while idle', async () => {
    const clock = fakeClock();
    const limiter = new RateLimiter(100, clock);
    await clock.sleep(60_000);
    expect(await limiter.acquire(100)).toBe(0);
    expect(await limiter.acquire(100)).toBe(1_000);
  });
});
