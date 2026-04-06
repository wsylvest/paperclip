import type { Request, Response, NextFunction } from "express";

interface RateLimitBucket {
  tokens: number;
  lastRefill: number;
}

export function rateLimitMiddleware(options: {
  requestsPerMinute?: number;
  enabled?: boolean;
} = {}) {
  const { requestsPerMinute = 300, enabled = false } = options;
  const buckets = new Map<string, RateLimitBucket>();
  const refillRate = requestsPerMinute / 60; // tokens per second

  return (req: Request, res: Response, next: NextFunction) => {
    if (!enabled) return next();

    const key = req.ip ?? "unknown";
    const now = Date.now() / 1000;
    let bucket = buckets.get(key);

    if (!bucket) {
      bucket = { tokens: requestsPerMinute, lastRefill: now };
      buckets.set(key, bucket);
    }

    // Refill tokens
    const elapsed = now - bucket.lastRefill;
    bucket.tokens = Math.min(requestsPerMinute, bucket.tokens + elapsed * refillRate);
    bucket.lastRefill = now;

    if (bucket.tokens < 1) {
      const retryAfter = Math.ceil((1 - bucket.tokens) / refillRate);
      res.setHeader("Retry-After", String(retryAfter));
      res.status(429).json({ error: "Too many requests", retryAfter });
      return;
    }

    bucket.tokens -= 1;
    next();
  };
}
