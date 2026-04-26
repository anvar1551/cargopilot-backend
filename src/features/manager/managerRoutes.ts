import { Router } from "express";
import rateLimit from "express-rate-limit";
import { auth } from "../../middleware/auth";
import { createRateLimitStore } from "../../config/rateLimitStore";
import { getAnalyticsSummary, getManagerOverview, listDrivers } from "./managerController";
import {
  getLiveMapSnapshotController,
  streamLiveMapController,
} from "../liveMap/liveMapController";

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

router.get("/overview", auth(["manager"]), getManagerOverview);
router.get("/analytics/summary", analyticsLimiter, auth(["manager"]), getAnalyticsSummary);
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
