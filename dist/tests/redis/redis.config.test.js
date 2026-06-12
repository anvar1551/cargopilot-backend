"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
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
        const redis = await Promise.resolve().then(() => __importStar(require("../../src/config/redis")));
        expect(redis.isRedisEnabled()).toBe(false);
        await expect(redis.getRedisClient()).resolves.toBeNull();
    });
    it("times out operations and records timeout stats", async () => {
        process.env.REDIS_URL = "redis://127.0.0.1:6379";
        process.env.REDIS_ENABLED = "true";
        const redis = await Promise.resolve().then(() => __importStar(require("../../src/config/redis")));
        await expect(redis.withRedisTimeout("unit-test-op", async () => await new Promise(() => undefined), 50)).rejects.toThrow("[redis] unit-test-op timed out after 50ms");
        const health = await redis.getRedisHealthSnapshot();
        expect(health.stats.operationTimeouts).toBeGreaterThanOrEqual(1);
    });
    it("tracks not-ready errors for guarded operations", async () => {
        process.env.REDIS_URL = "redis://127.0.0.1:6379";
        process.env.REDIS_ENABLED = "true";
        const redis = await Promise.resolve().then(() => __importStar(require("../../src/config/redis")));
        await expect(redis.withRedisTimeout("unit-test-not-ready", async () => {
            throw new Error("Stream isn't writeable and enableOfflineQueue options is false");
        }, 100)).rejects.toThrow("Stream isn't writeable");
        const health = await redis.getRedisHealthSnapshot();
        expect(health.stats.notReadyErrors).toBeGreaterThanOrEqual(1);
    });
});
