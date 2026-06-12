"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const mockGetRedisClient = jest.fn();
const mockWithRedisTimeout = jest.fn();
jest.mock("../../src/config/redis", () => ({
    getRedisPrefix: () => "testprefix",
    getRedisClient: mockGetRedisClient,
    withRedisTimeout: mockWithRedisTimeout,
    createRedisClient: jest.fn(() => null),
}));
const liveMapStore_1 = require("../../src/modules/live-map-core/infrastructure/liveMapStore");
describe("liveMapStore redis + replay behavior", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockWithRedisTimeout.mockImplementation(async (_op, work) => {
            return await work();
        });
    });
    it("publishes event locally and replays it from in-memory buffer", async () => {
        mockGetRedisClient.mockResolvedValue(null);
        const handler = jest.fn();
        const unsubscribe = (0, liveMapStore_1.subscribeLiveMapEvents)(handler);
        const first = {
            type: "driver_location_upsert",
            at: new Date().toISOString(),
            payload: {
                driverId: "d-1",
                warehouseId: "w-1",
                lat: 41.31,
                lng: 69.27,
                speedKmh: 20,
                headingDeg: 90,
                recordedAt: new Date().toISOString(),
                accuracyM: null,
                orderId: null,
            },
        };
        const second = {
            type: "driver_location_upsert",
            at: new Date().toISOString(),
            payload: {
                driverId: "d-2",
                warehouseId: "w-1",
                lat: 41.3,
                lng: 69.2,
                speedKmh: 15,
                headingDeg: 40,
                recordedAt: new Date().toISOString(),
                accuracyM: null,
                orderId: null,
            },
        };
        await (0, liveMapStore_1.publishLiveMapEvent)(first);
        await (0, liveMapStore_1.publishLiveMapEvent)(second);
        const firstEventId = handler.mock.calls[0]?.[0]?.id;
        expect(firstEventId).toMatch(/^\d+-\d+$/);
        const replayed = (0, liveMapStore_1.replayLiveMapEventsSince)(firstEventId);
        expect(replayed.length).toBeGreaterThanOrEqual(1);
        expect(replayed[0]?.payload?.driverId).toBe("d-2");
        unsubscribe();
    });
    it("returns unique viewport driver ids from redis geosearch", async () => {
        const call = jest.fn().mockResolvedValue(["d-1", "d-2", "d-1", ""]);
        mockGetRedisClient.mockResolvedValue({ call });
        const result = await (0, liveMapStore_1.readDriverIdsInViewport)({
            minLat: 41,
            minLng: 69,
            maxLat: 42,
            maxLng: 70,
        });
        expect(result).toEqual(["d-1", "d-2"]);
        expect(call).toHaveBeenCalled();
    });
    it("replays events from redis only for valid stream ids and valid payloads", async () => {
        const call = jest.fn().mockResolvedValue([
            ["100-1", ["type", "driver_location_upsert", "data", JSON.stringify({ type: "driver_location_upsert", at: new Date().toISOString(), payload: { driverId: "d-1", lat: 41, lng: 69, speedKmh: 10, headingDeg: 20, recordedAt: new Date().toISOString(), warehouseId: null, accuracyM: null, orderId: null } })]],
            ["100-2", ["type", "driver_location_upsert", "data", "not-json"]],
        ]);
        mockGetRedisClient.mockResolvedValue({ call });
        const rows = await (0, liveMapStore_1.replayLiveMapEventsFromRedis)({
            lastEventId: "100-0",
            limit: 20,
        });
        expect(rows).toHaveLength(1);
        expect(rows[0]?.type).toBe("driver_location_upsert");
        const invalid = await (0, liveMapStore_1.replayLiveMapEventsFromRedis)({ lastEventId: "invalid" });
        expect(invalid).toEqual([]);
    });
});
