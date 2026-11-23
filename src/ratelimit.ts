interface Bucket {
  tokens: number;
  updatedAt: number;
}

/** Per-key token bucket: `perMinute` burst capacity, refilled continuously at `perMinute`/60s. */
export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly capacity: number;
  private readonly refillPerMs: number;
  private readonly now: () => number;

  constructor(perMinute: number, now: () => number = Date.now) {
    this.capacity = perMinute;
    this.refillPerMs = perMinute / 60_000;
    this.now = now;
  }

  tryConsume(key: string): boolean {
    const t = this.now();
    const bucket = this.buckets.get(key) ?? { tokens: this.capacity, updatedAt: t };
    bucket.tokens = Math.min(this.capacity, bucket.tokens + (t - bucket.updatedAt) * this.refillPerMs);
    bucket.updatedAt = t;
    const allowed = bucket.tokens >= 1;
    if (allowed) bucket.tokens -= 1;
    this.buckets.set(key, bucket);
    return allowed;
  }
}
