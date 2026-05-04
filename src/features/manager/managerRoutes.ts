import { Router } from "express";
import rateLimit from "express-rate-limit";
import { auth } from "../../middleware/auth";
import { createRateLimitStore } from "../../config/rateLimitStore";
import { getManagerOverview, listDrivers } from "./managerController";
import {
  forceInvalidateAnalyticsV2Controller,
  getAnalyticsFinanceQueueV2Controller,
  getAnalyticsSummaryV2Controller,
  getAnalyticsTrendV2Controller,
  getAnalyticsWarningsV2Controller,
  streamAnalyticsV2Controller,
} from "./analyticsV2Controller";
import {
  getLiveMapSnapshotController,
  streamLiveMapController,
} from "../liveMap/liveMapController";
import { getManagerOpsMetricsController } from "./opsMetricsController";

const router = Router();
const analyticsLimiter = rateLimit({
  windowMs: Number(process.env.ANALYTICS_RATE_LIMIT_WINDOW_MS || 60 * 1000),
  max: Number(process.env.ANALYTICS_RATE_LIMIT_MAX || 120),
  store: createRateLimitStore("manager-analytics"),
  standardHeaders: true,
  legacyHeaders: false,
  passOnStoreError: true,
});
const liveMapSnapshotLimiter = rateLimit({
  windowMs: Number(process.env.LIVE_MAP_SNAPSHOT_RATE_LIMIT_WINDOW_MS || 60 * 1000),
  max: Number(process.env.LIVE_MAP_SNAPSHOT_RATE_LIMIT_MAX || 240),
  store: createRateLimitStore("manager-live-map-snapshot"),
  standardHeaders: true,
  legacyHeaders: false,
  passOnStoreError: true,
});
const liveMapStreamLimiter = rateLimit({
  windowMs: Number(process.env.LIVE_MAP_STREAM_RATE_LIMIT_WINDOW_MS || 60 * 1000),
  max: Number(process.env.LIVE_MAP_STREAM_RATE_LIMIT_MAX || 60),
  store: createRateLimitStore("manager-live-map-stream"),
  standardHeaders: true,
  legacyHeaders: false,
  passOnStoreError: true,
});
const analyticsStreamLimiter = rateLimit({
  windowMs: Number(process.env.ANALYTICS_V2_STREAM_RATE_LIMIT_WINDOW_MS || 60 * 1000),
  max: Number(process.env.ANALYTICS_V2_STREAM_RATE_LIMIT_MAX || 120),
  store: createRateLimitStore("manager-analytics-v2-stream"),
  standardHeaders: true,
  legacyHeaders: false,
  passOnStoreError: true,
});

router.get("/overview", auth(["manager"]), getManagerOverview);
router.get("/ops/metrics", auth(["manager"]), getManagerOpsMetricsController);
router.get(
  "/analytics/summary",
  analyticsLimiter,
  auth(["manager"]),
  getAnalyticsSummaryV2Controller,
);
router.get("/analytics/trend", analyticsLimiter, auth(["manager"]), getAnalyticsTrendV2Controller);
router.get(
  "/analytics/warnings",
  analyticsLimiter,
  auth(["manager"]),
  getAnalyticsWarningsV2Controller,
);
router.get(
  "/analytics/finance-queue",
  analyticsLimiter,
  auth(["manager"]),
  getAnalyticsFinanceQueueV2Controller,
);
router.get(
  "/analytics/stream",
  analyticsStreamLimiter,
  auth(["manager"]),
  streamAnalyticsV2Controller,
);
router.post(
  "/analytics/refresh",
  analyticsLimiter,
  auth(["manager"]),
  forceInvalidateAnalyticsV2Controller,
);
router.get("/drivers", auth(["manager", "warehouse"]), listDrivers);
router.get(
  "/live-map/snapshot",
  liveMapSnapshotLimiter,
  auth(["manager", "warehouse"]),
  getLiveMapSnapshotController,
);
router.get(
  "/live-map/stream",
  liveMapStreamLimiter,
  auth(["manager", "warehouse"]),
  streamLiveMapController,
);

export default router;
