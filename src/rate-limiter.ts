/**
 * Client-side request rate limiter so a large fan-out SELF-PACES under a provider's
 * RPM/RPS limits instead of 429-storming it. `maxConcurrency` only caps how many
 * workers run at once; it does NOT cap the request RATE (each worker makes several
 * requests in its tool loop). This limiter does, via a sliding window over the last
 * 60s and 1s.
 *
 * It is shared PER BASE URL across the whole process (module-level registry), so every
 * worker - and every retry - draws from one budget. 0 = unlimited (off).
 */
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export class RateLimiter {
  private minute: number[] = [];
  private second: number[] = [];

  constructor(
    private readonly rpm: number,
    private readonly rps: number,
  ) {}

  get enabled(): boolean {
    return this.rpm > 0 || this.rps > 0;
  }

  /** Block until a request slot is free under both the per-minute and per-second caps. */
  async acquire(): Promise<void> {
    if (!this.enabled) return;
    for (;;) {
      const now = Date.now();
      if (this.rpm > 0) this.minute = this.minute.filter((t) => now - t < 60_000);
      if (this.rps > 0) this.second = this.second.filter((t) => now - t < 1_000);

      const okMin = this.rpm <= 0 || this.minute.length < this.rpm;
      const okSec = this.rps <= 0 || this.second.length < this.rps;

      // The check-and-record below runs synchronously (no await between), so concurrent
      // callers cannot both pass the same slot - JS single-threading makes it atomic.
      if (okMin && okSec) {
        if (this.rpm > 0) this.minute.push(now);
        if (this.rps > 0) this.second.push(now);
        return;
      }

      const waits: number[] = [];
      if (!okSec && this.second.length) waits.push(1_000 - (now - (this.second[0] ?? now)));
      if (!okMin && this.minute.length) waits.push(60_000 - (now - (this.minute[0] ?? now)));
      await sleep(Math.max(25, waits.length ? Math.min(...waits) : 25));
    }
  }
}

const registry = new Map<string, RateLimiter>();

/** Get (or create) the shared limiter for a base URL. First config wins per process. */
export function getRateLimiter(key: string, rpm: number, rps: number): RateLimiter {
  let lim = registry.get(key);
  if (!lim) {
    lim = new RateLimiter(rpm, rps);
    registry.set(key, lim);
  }
  return lim;
}
