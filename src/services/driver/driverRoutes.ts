import { Router } from "express";
import rateLimit from "express-rate-limit";
import { auth } from "../../middleware/auth";
import { AppRole } from "@prisma/client";
import { listDrivers, updateDriverProfile } from "./driverController";
import {
  getDriverPresenceController,
  heartbeatDriverPresenceController,
  ingestDriverLocationController,
  setDriverPresenceController,
} from "../../features/liveMap/liveMapController";
import { createRateLimitStore } from "../../config/rateLimitStore";

const router = Router();
const locationLimiter = rateLimit({
  windowMs: Number(process.env.DRIVER_LOCATION_RATE_LIMIT_WINDOW_MS || 60 * 1000),
  max: Number(process.env.DRIVER_LOCATION_RATE_LIMIT_MAX || 180),
  store: createRateLimitStore("driver-location"),
  standardHeaders: true,
  legacyHeaders: false,
  passOnStoreError: true,
});
const presenceLimiter = rateLimit({
  windowMs: Number(process.env.DRIVER_PRESENCE_RATE_LIMIT_WINDOW_MS || 60 * 1000),
  max: Number(process.env.DRIVER_PRESENCE_RATE_LIMIT_MAX || 240),
  store: createRateLimitStore("driver-presence"),
  standardHeaders: true,
  legacyHeaders: false,
  passOnStoreError: true,
});

router.get("/", auth([AppRole.manager]), listDrivers);
router.post(
  "/location",
  locationLimiter,
  auth([AppRole.driver, AppRole.manager]),
  ingestDriverLocationController,
);
router.get(
  "/presence",
  presenceLimiter,
  auth([AppRole.driver, AppRole.manager]),
  getDriverPresenceController,
);
router.put(
  "/presence",
  presenceLimiter,
  auth([AppRole.driver, AppRole.manager]),
  setDriverPresenceController,
);
router.post(
  "/presence/heartbeat",
  presenceLimiter,
  auth([AppRole.driver, AppRole.manager]),
  heartbeatDriverPresenceController,
);
router.put("/:id", auth([AppRole.manager]), updateDriverProfile);

export default router;
