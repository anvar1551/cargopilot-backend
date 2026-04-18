import { Router } from "express";
import rateLimit from "express-rate-limit";
import { auth } from "../../middleware/auth";
import { createRateLimitStore } from "../../config/rateLimitStore";
import { getAnalyticsSummary, getManagerOverview, listDrivers } from "./managerController";

const router = Router();
const analyticsLimiter = rateLimit({
  windowMs: Number(process.env.ANALYTICS_RATE_LIMIT_WINDOW_MS || 60 * 1000),
  max: Number(process.env.ANALYTICS_RATE_LIMIT_MAX || 120),
  store: createRateLimitStore("manager-analytics"),
  standardHeaders: true,
  legacyHeaders: false,
  passOnStoreError: true,
});

router.get("/overview", auth(["manager"]), getManagerOverview);
router.get("/analytics/summary", analyticsLimiter, auth(["manager"]), getAnalyticsSummary);
router.get("/drivers", auth(["manager", "warehouse"]), listDrivers);

export default router;
