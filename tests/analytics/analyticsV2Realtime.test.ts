const mockGetRedisClient = jest.fn();

jest.mock("../../src/config/redis", () => ({
  getRedisPrefix: () => "testprefix",
  getRedisClient: mockGetRedisClient,
  createRedisClient: jest.fn(() => null),
}));

jest.mock("../../src/modules/analytics-core/config/analyticsLogger", () => ({
  analyticsLogger: {
    throttledWarn: jest.fn(),
    throttledError: jest.fn(),
  },
}));

import {
  publishAnalyticsInvalidation,
  replayAnalyticsInvalidationFromRedis,
  replayAnalyticsInvalidationSince,
  subscribeAnalyticsInvalidation,
} from "../../src/modules/analytics-core/realtime/analyticsV2Realtime";

describe("analytics realtime", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("emits invalidation events to subscribers and replays from memory", async () => {
    mockGetRedisClient.mockResolvedValue(null);

    const handler = jest.fn();
    const unsubscribe = subscribeAnalyticsInvalidation(handler);

    await publishAnalyticsInvalidation("manual_refresh", { scope: "global" });

    expect(handler).toHaveBeenCalledTimes(1);

    const emitted = handler.mock.calls[0]?.[0];
    const replayed = replayAnalyticsInvalidationSince(emitted?.id);
    expect(Array.isArray(replayed)).toBe(true);

    unsubscribe();
  });

  it("replays from redis and filters invalid entries", async () => {
    const call = jest.fn().mockResolvedValue([
      [
        "200-1",
        [
          "type",
          "analytics.invalidate",
          "data",
          JSON.stringify({
            id: "200-1",
            type: "analytics.invalidate",
            at: new Date().toISOString(),
            reason: "manual_refresh",
            scope: "global",
            keys: ["summary"],
            source: "api",
          }),
        ],
      ],
      ["200-2", ["type", "analytics.invalidate", "data", "bad-json"]],
    ]);
    mockGetRedisClient.mockResolvedValue({ call });

    const rows = await replayAnalyticsInvalidationFromRedis({
      lastEventId: "200-0",
      limit: 25,
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.type).toBe("analytics.invalidate");

    const invalid = await replayAnalyticsInvalidationFromRedis({ lastEventId: "bad" });
    expect(invalid).toEqual([]);
  });
});
