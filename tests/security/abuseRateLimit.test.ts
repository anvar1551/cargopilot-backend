import Fastify from "fastify";
import { getRedisClient } from "../../src/config/redis";
import {
  BoundedLocalRateLimitStore, createAbuseRateLimiter, createAbuseRateLimitPreHandler,
  RateLimitConfigurationError, RateLimitUnavailableError,
} from "../../src/shared/http/abuseRateLimit";
import { loadAppEnv, parseTrustedProxy } from "../../src/config/env";

jest.mock("../../src/config/redis", () => ({
  ...jest.requireActual("../../src/config/redis"),
  getRedisClient: jest.fn(),
}));

const secret = "synthetic-test-key-material-32-characters";
const policy = { purpose: "auth-login", identity: "principal:alice@example.test", limit: 2, windowMs: 1000 };
const unavailable = { consume: jest.fn(async () => { throw new Error("private backend detail"); }) };

describe("Phase 0A abuse limiter (unit/mocked storage only)", () => {
  const originalEnv = { ...process.env };
  beforeEach(() => {
    process.env = { NODE_ENV: "test" };
    jest.mocked(getRedisClient).mockResolvedValue(null);
  });
  afterEach(() => { process.env = { ...originalEnv }; jest.useRealTimers(); });

  it("shares counters across instances, limits concurrent bursts and expires windows", async () => {
    let now = 0;
    const sharedStore = new BoundedLocalRateLimitStore(20, () => now);
    const opts = { environment: "production", keySecret: secret, sharedStore };
    const one = createAbuseRateLimiter(opts);
    const two = createAbuseRateLimiter(opts);
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => (i % 2 ? one : two).consume(policy)));
    expect(results.filter((r) => r.allowed)).toHaveLength(2);
    expect(results.every((r) => r.backend === "shared")).toBe(true);
    now = 1001;
    expect((await two.consume(policy)).allowed).toBe(true);
  });

  it("separates identities, purposes, environments and prefixes without raw identifiers", async () => {
    const consume = jest.fn(async () => ({ count: 1, resetAfterMs: 1000 }));
    const one = createAbuseRateLimiter({ environment: "production", keySecret: secret, sharedStore: { consume } });
    await one.consume(policy);
    await one.consume({ ...policy, identity: "session:private-refresh-token" });
    await one.consume({ ...policy, purpose: "auth-refresh" });
    await createAbuseRateLimiter({ environment: "staging", keySecret: secret, sharedStore: { consume } }).consume(policy);
    await createAbuseRateLimiter({ environment: "production", keySecret: secret, keyPrefix: "other", sharedStore: { consume } }).consume(policy);
    const keys = consume.mock.calls.map((call: any) => call[0]);
    expect(new Set(keys).size).toBe(5);
    expect(keys.join(" ")).not.toMatch(/alice|example|private-refresh-token/);
    expect(keys[0]).toMatch(/:production:auth-login:[a-f0-9]{64}$/);
  });

  it("fails closed without shared storage, even with an injected local store", async () => {
    const localStore = { consume: jest.fn() };
    const limiter = createAbuseRateLimiter({ environment: "production", keySecret: secret, sharedStore: unavailable, localStore });
    await expect(limiter.consume(policy)).rejects.toBeInstanceOf(RateLimitUnavailableError);
    expect(localStore.consume).not.toHaveBeenCalled();
    await expect(createAbuseRateLimiter({ sharedStore: unavailable }).consume(policy)).rejects.toBeInstanceOf(RateLimitUnavailableError);
  });

  it.each(["production", "staging", "prod", "production-typo"])("rejects local fallback in %s", (environment) => {
    expect(() => createAbuseRateLimiter({ environment, keySecret: secret, localFallbackEnabled: true }))
      .toThrow(RateLimitConfigurationError);
    expect(() => createAbuseRateLimiter({ environment })).toThrow(RateLimitConfigurationError);
  });

  it("requires explicit fallback and bounds it without evicting active counters", async () => {
    let now = 0;
    const localStore = new BoundedLocalRateLimitStore(2, () => now);
    const limiter = createAbuseRateLimiter({ sharedStore: unavailable, localStore, localFallbackEnabled: true });
    expect((await limiter.consume(policy)).backend).toBe("local");
    await limiter.consume(policy);
    await limiter.consume({ ...policy, identity: "other" });
    await expect(limiter.consume({ ...policy, identity: "overflow" })).rejects.toBeInstanceOf(RateLimitUnavailableError);
    expect(localStore.size).toBe(2);
    expect((await limiter.consume(policy)).allowed).toBe(false);
    now = 1001;
    expect((await limiter.consume({ ...policy, identity: "overflow" })).allowed).toBe(true);
    expect(localStore.size).toBe(1);
  });

  it("cannot enable fallback when NODE_ENV is absent", () => {
    delete process.env.NODE_ENV;
    expect(() => createAbuseRateLimiter({ keySecret: secret, localFallbackEnabled: true })).toThrow(RateLimitConfigurationError);
  });

  it("uses one Redis EVAL with TTL and validates backend responses", async () => {
    const evaluate = jest.fn().mockResolvedValue([1, 1000]);
    jest.mocked(getRedisClient).mockResolvedValue({ eval: evaluate } as any);
    const limiter = createAbuseRateLimiter({ environment: "production", keySecret: secret });
    expect((await limiter.consume(policy)).allowed).toBe(true);
    expect(evaluate).toHaveBeenCalledWith(expect.stringContaining('redis.call("INCR"'), 1, expect.any(String), 1000);
    expect(evaluate.mock.calls[0][0]).toContain('redis.call("PEXPIRE"');
    for (const raw of [null, [], [0, 1000], [-1, 1000], [1, -1], [1, 1001], [1.5, 1000]]) {
      evaluate.mockResolvedValueOnce(raw);
      await expect(limiter.consume(policy)).rejects.toBeInstanceOf(RateLimitUnavailableError);
    }
  });

  it.each(["connect", "eval"])("bounds a stalled Redis %s call", async (stage) => {
    jest.useFakeTimers();
    const pending = new Promise<never>(() => undefined);
    jest.mocked(getRedisClient).mockImplementation(stage === "connect" ? () => pending : async () => ({ eval: () => pending }) as any);
    const limiter = createAbuseRateLimiter({ environment: "production", keySecret: secret });
    const assertion = expect(limiter.consume(policy)).rejects.toBeInstanceOf(RateLimitUnavailableError);
    await jest.advanceTimersByTimeAsync(1001);
    await assertion;
  });

  it("returns generic 429/503 before handler effects, with no principal counters", async () => {
    const store = new BoundedLocalRateLimitStore();
    const app = Fastify();
    const effect = jest.fn();
    app.get("/test", { onRequest: createAbuseRateLimitPreHandler({
      ...policy, limiter: createAbuseRateLimiter({ sharedStore: store }), identities: () => [policy.identity],
    }) }, async () => { effect(); return { ok: true }; });
    try {
      expect((await app.inject("/test")).statusCode).toBe(200);
      expect((await app.inject("/test")).statusCode).toBe(200);
      const blocked = await app.inject("/test");
      expect(blocked.statusCode).toBe(429);
      expect(blocked.json()).toEqual({ error: "Request cannot be processed" });
      expect(blocked.headers["retry-after"]).toBeDefined();
      expect(blocked.headers["x-ratelimit-remaining"]).toBeUndefined();
      expect(effect).toHaveBeenCalledTimes(2);
    } finally { await app.close(); }
  });

  it("fails closed if key extraction fails or returns no identities", async () => {
    for (const identities of [() => [], () => { throw new Error("private detail"); }]) {
      const app = Fastify();
      const effect = jest.fn();
      app.get("/", { onRequest: createAbuseRateLimitPreHandler({ ...policy, identities }) }, async () => effect());
      try {
        const result = await app.inject("/");
        expect(result.statusCode).toBe(503);
        expect(result.json()).toEqual({ error: "Request cannot be processed" });
        expect(effect).not.toHaveBeenCalled();
      } finally { await app.close(); }
    }
  });
});

describe("trusted proxy configuration", () => {
  it("defaults to socket IP and rejects trust-all/invalid configuration", () => {
    expect(loadAppEnv({}).TRUST_PROXY).toBe(false);
    for (const value of ["true", "yes", "on", "0.0.0.0/0", "::/0", "garbage", "999999999999999999999"]) {
      expect(() => parseTrustedProxy(value)).toThrow();
    }
    expect(parseTrustedProxy("1")).toBe(1);
    expect(parseTrustedProxy("127.0.0.1,10.0.0.0/8")).toEqual(["127.0.0.1", "10.0.0.0/8"]);
  });

  it.each([
    [false, "192.0.2.10", "192.0.2.10"],
    [parseTrustedProxy("10.0.0.1"), "192.0.2.10", "192.0.2.10"],
    [parseTrustedProxy("10.0.0.1"), "10.0.0.1", "198.51.100.8"],
  ])("resolves only the configured proxy chain", async (trustProxy, remoteAddress, expected) => {
    const app = Fastify({ trustProxy: trustProxy as any });
    app.get("/", async (req) => ({ ip: req.ip }));
    try {
      const result = await app.inject({ url: "/", remoteAddress: remoteAddress as string,
        headers: { "x-forwarded-for": "203.0.113.99, 198.51.100.8", "x-real-ip": "203.0.113.22" } });
      expect(result.json().ip).toBe(expected);
    } finally { await app.close(); }
  });
});
