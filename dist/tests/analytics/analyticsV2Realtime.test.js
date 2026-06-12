"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
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
const analyticsV2Realtime_1 = require("../../src/modules/analytics-core/realtime/analyticsV2Realtime");
describe("analytics realtime", () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });
    it("emits invalidation events to subscribers and replays from memory", async () => {
        mockGetRedisClient.mockResolvedValue(null);
        const handler = jest.fn();
        const unsubscribe = (0, analyticsV2Realtime_1.subscribeAnalyticsInvalidation)(handler);
        await (0, analyticsV2Realtime_1.publishAnalyticsInvalidation)("manual_refresh", { scope: "global" });
        expect(handler).toHaveBeenCalledTimes(1);
        const emitted = handler.mock.calls[0]?.[0];
        const replayed = (0, analyticsV2Realtime_1.replayAnalyticsInvalidationSince)(emitted?.id);
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
        const rows = await (0, analyticsV2Realtime_1.replayAnalyticsInvalidationFromRedis)({
            lastEventId: "200-0",
            limit: 25,
        });
        expect(rows).toHaveLength(1);
        expect(rows[0]?.type).toBe("analytics.invalidate");
        const invalid = await (0, analyticsV2Realtime_1.replayAnalyticsInvalidationFromRedis)({ lastEventId: "bad" });
        expect(invalid).toEqual([]);
    });
});
