"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const express_rate_limit_1 = __importDefault(require("express-rate-limit"));
const auth_1 = require("../../middleware/auth");
const rateLimitStore_1 = require("../../config/rateLimitStore");
const managerController_1 = require("./managerController");
const analyticsV2Controller_1 = require("./analyticsV2Controller");
const liveMapController_1 = require("../liveMap/liveMapController");
const opsMetricsController_1 = require("./opsMetricsController");
const router = (0, express_1.Router)();
const analyticsLimiter = (0, express_rate_limit_1.default)({
    windowMs: Number(process.env.ANALYTICS_RATE_LIMIT_WINDOW_MS || 60 * 1000),
    max: Number(process.env.ANALYTICS_RATE_LIMIT_MAX || 120),
    store: (0, rateLimitStore_1.createRateLimitStore)("manager-analytics"),
    standardHeaders: true,
    legacyHeaders: false,
    passOnStoreError: true,
});
const liveMapSnapshotLimiter = (0, express_rate_limit_1.default)({
    windowMs: Number(process.env.LIVE_MAP_SNAPSHOT_RATE_LIMIT_WINDOW_MS || 60 * 1000),
    max: Number(process.env.LIVE_MAP_SNAPSHOT_RATE_LIMIT_MAX || 240),
    store: (0, rateLimitStore_1.createRateLimitStore)("manager-live-map-snapshot"),
    standardHeaders: true,
    legacyHeaders: false,
    passOnStoreError: true,
});
const liveMapStreamLimiter = (0, express_rate_limit_1.default)({
    windowMs: Number(process.env.LIVE_MAP_STREAM_RATE_LIMIT_WINDOW_MS || 60 * 1000),
    max: Number(process.env.LIVE_MAP_STREAM_RATE_LIMIT_MAX || 60),
    store: (0, rateLimitStore_1.createRateLimitStore)("manager-live-map-stream"),
    standardHeaders: true,
    legacyHeaders: false,
    passOnStoreError: true,
});
const analyticsStreamLimiter = (0, express_rate_limit_1.default)({
    windowMs: Number(process.env.ANALYTICS_V2_STREAM_RATE_LIMIT_WINDOW_MS || 60 * 1000),
    max: Number(process.env.ANALYTICS_V2_STREAM_RATE_LIMIT_MAX || 120),
    store: (0, rateLimitStore_1.createRateLimitStore)("manager-analytics-v2-stream"),
    standardHeaders: true,
    legacyHeaders: false,
    passOnStoreError: true,
});
router.get("/overview", (0, auth_1.auth)(["manager"]), managerController_1.getManagerOverview);
router.get("/ops/metrics", (0, auth_1.auth)(["manager"]), opsMetricsController_1.getManagerOpsMetricsController);
router.get("/analytics/summary", analyticsLimiter, (0, auth_1.auth)(["manager"]), analyticsV2Controller_1.getAnalyticsSummaryV2Controller);
router.get("/analytics/trend", analyticsLimiter, (0, auth_1.auth)(["manager"]), analyticsV2Controller_1.getAnalyticsTrendV2Controller);
router.get("/analytics/warnings", analyticsLimiter, (0, auth_1.auth)(["manager"]), analyticsV2Controller_1.getAnalyticsWarningsV2Controller);
router.get("/analytics/finance-queue", analyticsLimiter, (0, auth_1.auth)(["manager"]), analyticsV2Controller_1.getAnalyticsFinanceQueueV2Controller);
router.get("/analytics/stream", analyticsStreamLimiter, (0, auth_1.auth)(["manager"]), analyticsV2Controller_1.streamAnalyticsV2Controller);
router.post("/analytics/refresh", analyticsLimiter, (0, auth_1.auth)(["manager"]), analyticsV2Controller_1.forceInvalidateAnalyticsV2Controller);
router.get("/drivers", (0, auth_1.auth)(["manager", "warehouse"]), managerController_1.listDrivers);
router.get("/live-map/snapshot", liveMapSnapshotLimiter, (0, auth_1.auth)(["manager", "warehouse"]), liveMapController_1.getLiveMapSnapshotController);
router.get("/live-map/stream", liveMapStreamLimiter, (0, auth_1.auth)(["manager", "warehouse"]), liveMapController_1.streamLiveMapController);
exports.default = router;
