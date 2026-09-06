import { createHmac, randomBytes } from "crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import {
  getRedisClient,
  getRedisPrefix,
  withRedisTimeout,
} from "../../config/redis";

const REDIS_CONSUME_SCRIPT = `
local current = redis.call("INCR", KEYS[1])
if current == 1 then
  redis.call("PEXPIRE", KEYS[1], ARGV[1])
end
local ttl = redis.call("PTTL", KEYS[1])
if ttl < 0 then
  redis.call("PEXPIRE", KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return { current, ttl }
`;

const PROCESS_LOCAL_KEY_SECRET = randomBytes(32).toString("hex");
const DEFAULT_LOCAL_MAX_KEYS = 10_000;

export const GENERIC_RATE_LIMIT_ERROR = "Request cannot be processed";

export type RateLimitStoreResult = {
  count: number;
  resetAfterMs: number;
};

export interface RateLimitStore {
  consume(key: string, windowMs: number): Promise<RateLimitStoreResult>;
}

export type RateLimitDecision = RateLimitStoreResult & {
  allowed: boolean;
  limit: number;
  remaining: number;
  backend: "shared" | "local";
};

export interface AbuseRateLimiter {
  consume(args: {
    purpose: string;
    identity: string;
    limit: number;
    windowMs: number;
  }): Promise<RateLimitDecision>;
}

export class RateLimitUnavailableError extends Error {
  constructor() {
    super("Required rate-limit backend is unavailable");
    this.name = "RateLimitUnavailableError";
  }
}

export class RateLimitConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RateLimitConfigurationError";
  }
}

function readBoolean(value: string | undefined, fallback = false) {
  if (value == null || value.trim() === "") return fallback;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  throw new RateLimitConfigurationError("Invalid rate-limit boolean configuration");
}

export function readPositiveIntegerEnv(name: string, fallback: number) {
  const value = process.env[name];
  if (value == null || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new RateLimitConfigurationError(`${name} must be a positive integer`);
  }
  return parsed;
}

function normalizedKeySegment(value: string, fallback: string) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || fallback;
}

class RedisRateLimitStore implements RateLimitStore {
  async consume(key: string, windowMs: number): Promise<RateLimitStoreResult> {
    // Include acquisition: a reconnecting shared client must not hang authentication.
    const raw = await withRedisTimeout("rate-limit.consume", async () => {
      const redis = await getRedisClient();
      if (!redis) throw new RateLimitUnavailableError();
      return redis.eval(REDIS_CONSUME_SCRIPT, 1, key, windowMs);
    }, 1_000);
    if (!Array.isArray(raw) || raw.length < 2) {
      throw new RateLimitUnavailableError();
    }
    const count = Number(raw[0]);
    const resetAfterMs = Number(raw[1]);
    if (!Number.isSafeInteger(count) || count < 1 ||
        !Number.isSafeInteger(resetAfterMs) || resetAfterMs < 0 || resetAfterMs > windowMs) {
      throw new RateLimitUnavailableError();
    }
    return {
      count: Math.max(1, Math.trunc(count)),
      resetAfterMs: Math.max(1, Math.trunc(resetAfterMs)),
    };
  }
}

export class BoundedLocalRateLimitStore implements RateLimitStore {
  private readonly entries = new Map<string, { count: number; expiresAt: number }>();

  constructor(
    private readonly maxKeys = DEFAULT_LOCAL_MAX_KEYS,
    private readonly now: () => number = Date.now,
  ) {
    if (!Number.isSafeInteger(maxKeys) || maxKeys <= 0) {
      throw new RateLimitConfigurationError("Local rate-limit key cap must be positive");
    }
  }

  get size() {
    return this.entries.size;
  }

  private makeRoom(now: number) {
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(key);
    }
    // Never evict active counters: rotating identifiers must not reset a block.
    if (this.entries.size >= this.maxKeys) throw new RateLimitUnavailableError();
  }

  async consume(key: string, windowMs: number): Promise<RateLimitStoreResult> {
    const now = this.now();
    const existing = this.entries.get(key);
    if (!existing || existing.expiresAt <= now) {
      this.makeRoom(now);
      const expiresAt = now + windowMs;
      this.entries.set(key, { count: 1, expiresAt });
      return { count: 1, resetAfterMs: windowMs };
    }

    existing.count = Math.min(Number.MAX_SAFE_INTEGER, existing.count + 1);
    return {
      count: existing.count,
      resetAfterMs: Math.max(1, existing.expiresAt - now),
    };
  }
}

export function createAbuseRateLimiter(options: {
  environment?: string;
  keySecret?: string;
  keyPrefix?: string;
  sharedStore?: RateLimitStore;
  localStore?: RateLimitStore;
  localFallbackEnabled?: boolean;
  localMaxKeys?: number;
} = {}): AbuseRateLimiter {
  const environment = normalizedKeySegment(
    options.environment ?? process.env.NODE_ENV ?? "unspecified",
    "unspecified",
  );
  const developmentOrTest = environment === "development" || environment === "test";
  const configuredSecret = options.keySecret ?? process.env.RATE_LIMIT_KEY_SECRET;
  if (!developmentOrTest && (!configuredSecret || configuredSecret.trim().length < 32)) {
    throw new RateLimitConfigurationError(
      "RATE_LIMIT_KEY_SECRET must contain at least 32 non-padding characters outside development/test",
    );
  }
  const keySecret = configuredSecret || PROCESS_LOCAL_KEY_SECRET;
  const localFallbackEnabled =
    options.localFallbackEnabled ??
    readBoolean(process.env.RATE_LIMIT_LOCAL_FALLBACK_ENABLED, false);
  if (!developmentOrTest && localFallbackEnabled) {
    throw new RateLimitConfigurationError(
      "Local rate-limit fallback is only permitted in development/test",
    );
  }

  const localMaxKeys =
    options.localMaxKeys ??
    readPositiveIntegerEnv("RATE_LIMIT_LOCAL_MAX_KEYS", DEFAULT_LOCAL_MAX_KEYS);
  const sharedStore = options.sharedStore ?? new RedisRateLimitStore();
  const localStore =
    options.localStore ?? new BoundedLocalRateLimitStore(localMaxKeys);
  const keyPrefix =
    options.keyPrefix?.trim() ||
    process.env.REDIS_RATE_LIMIT_PREFIX?.trim() ||
    `${getRedisPrefix()}:rate-limit`;

  async function consumeStore(
    store: RateLimitStore,
    backend: "shared" | "local",
    key: string,
    limit: number,
    windowMs: number,
  ): Promise<RateLimitDecision> {
    const result = await store.consume(key, windowMs);
    return {
      ...result,
      allowed: result.count <= limit,
      limit,
      remaining: Math.max(0, limit - result.count),
      backend,
    };
  }

  return {
    async consume(args) {
      const purpose = normalizedKeySegment(args.purpose, "unknown");
      const { limit, windowMs } = args;
      if (!Number.isSafeInteger(limit) || limit <= 0 ||
          !Number.isSafeInteger(windowMs) || windowMs <= 0 || !args.identity) {
        throw new RateLimitConfigurationError("Invalid rate-limit policy");
      }
      const digest = createHmac("sha256", keySecret)
        .update(`v1\0${environment}\0${purpose}\0${args.identity}`)
        .digest("hex");
      const key = `${keyPrefix}:${environment}:${purpose}:${digest}`;

      try {
        return await consumeStore(sharedStore, "shared", key, limit, windowMs);
      } catch (error) {
        if (developmentOrTest && localFallbackEnabled) {
          return consumeStore(localStore, "local", key, limit, windowMs);
        }
        if (error instanceof RateLimitConfigurationError) throw error;
        throw new RateLimitUnavailableError();
      }
    },
  };
}

export function createAbuseRateLimitPreHandler(options: {
  purpose: string;
  limit: number;
  windowMs: number;
  identities: (request: FastifyRequest) => string[];
  limiter?: AbuseRateLimiter;
}) {
  const limiter = options.limiter ?? createAbuseRateLimiter();

  return async (request: FastifyRequest, reply: FastifyReply) => {
    reply.header("Cache-Control", "no-store");
    try {
      const identities = Array.from(
        new Set(options.identities(request).map((value) => String(value || "").trim()).filter(Boolean)),
      );
      if (identities.length === 0) throw new RateLimitConfigurationError("Missing limiter identity");
      for (const identity of identities) {
        const decision = await limiter.consume({
          purpose: options.purpose,
          identity,
          limit: options.limit,
          windowMs: options.windowMs,
        });
        // Do not expose principal counters as an account-activity side channel.
        if (!decision.allowed) {
          reply.header("Retry-After", Math.max(1, Math.ceil(decision.resetAfterMs / 1_000)));
          reply.header("Cache-Control", "no-store");
          return reply.code(429).send({ error: GENERIC_RATE_LIMIT_ERROR });
        }
      }
    } catch {
      reply.header("Cache-Control", "no-store");
      return reply.code(503).send({ error: GENERIC_RATE_LIMIT_ERROR });
    }
  };
}
