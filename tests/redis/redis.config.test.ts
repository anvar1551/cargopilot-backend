describe("redis config", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    jest.resetModules();
    jest.clearAllMocks();
  });

  it("disables redis when REDIS_URL is missing", async () => {
    delete process.env.REDIS_URL;
    process.env.REDIS_ENABLED = "true";

    const redis = await import("../../src/config/redis");

    expect(redis.isRedisEnabled()).toBe(false);
    await expect(redis.getRedisClient()).resolves.toBeNull();
  });

  it("times out operations and records timeout stats", async () => {
    process.env.REDIS_URL = "redis://127.0.0.1:6379";
    process.env.REDIS_ENABLED = "true";

    const redis = await import("../../src/config/redis");

    await expect(
      redis.withRedisTimeout(
        "unit-test-op",
        async () => await new Promise<never>(() => undefined),
        50,
      ),
    ).rejects.toThrow("[redis] unit-test-op timed out after 50ms");

    const health = await redis.getRedisHealthSnapshot();
    expect(health.stats.operationTimeouts).toBeGreaterThanOrEqual(1);
  });

  it("tracks not-ready errors for guarded operations", async () => {
    process.env.REDIS_URL = "redis://127.0.0.1:6379";
    process.env.REDIS_ENABLED = "true";

    const redis = await import("../../src/config/redis");

    await expect(
      redis.withRedisTimeout(
        "unit-test-not-ready",
        async () => {
          throw new Error("Stream isn't writeable and enableOfflineQueue options is false");
        },
        100,
      ),
    ).rejects.toThrow("Stream isn't writeable");

    const health = await redis.getRedisHealthSnapshot();
    expect(health.stats.notReadyErrors).toBeGreaterThanOrEqual(1);
  });
});
