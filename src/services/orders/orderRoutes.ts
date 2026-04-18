import { Router } from "express";
import { AppRole } from "@prisma/client";
import rateLimit from "express-rate-limit";
import { auth } from "../../middleware/auth";
import { createRateLimitStore } from "../../config/rateLimitStore";
import {
  create,
  confirmImport,
  downloadImportTemplate,
  exportCsv,
  list,
  previewImport,
  getOne,
  collectCash,
  collectCashBulk,
  getCashQueueSummary,
  handoffCash,
  handoffCashBulk,
  listCashQueue,
  settleCash,
  settleCashBulk,
  assignDriversBulk,
  assignTasksBulk,
  updateDriverStatus,
  updateStatusBulk,
  listDriverWorkload,
} from "./controller";

const router = Router();
const exportLimiter = rateLimit({
  windowMs: Number(process.env.EXPORT_RATE_LIMIT_WINDOW_MS || 10 * 60 * 1000),
  max: Number(process.env.EXPORT_RATE_LIMIT_MAX || 20),
  store: createRateLimitStore("orders-export"),
  standardHeaders: true,
  legacyHeaders: false,
  passOnStoreError: true,
});

router.post("/", auth([AppRole.customer, AppRole.manager]), create);
router.get("/import/template.csv", auth([AppRole.manager, AppRole.customer]), downloadImportTemplate);
router.post("/import/preview", auth([AppRole.manager, AppRole.customer]), previewImport);
router.post("/import/confirm", auth([AppRole.manager, AppRole.customer]), confirmImport);
router.get(
  "/",
  auth([AppRole.manager, AppRole.customer, AppRole.driver, AppRole.warehouse]),
  list,
);
router.get("/export.csv", exportLimiter, auth([AppRole.manager]), exportCsv);
router.get(
  "/driver-workloads",
  auth([AppRole.manager, AppRole.warehouse]),
  listDriverWorkload,
);
router.post(
  "/assign-driver-bulk",
  auth([AppRole.manager, AppRole.warehouse]),
  assignDriversBulk,
);
router.post(
  "/tasks/assign-bulk",
  auth([AppRole.manager, AppRole.warehouse]),
  assignTasksBulk,
);
router.post(
  "/status-bulk",
  auth([AppRole.manager, AppRole.warehouse]),
  updateStatusBulk,
);
router.post("/driver-status", auth([AppRole.driver]), updateDriverStatus);
router.post(
  "/cash/collect-bulk",
  auth([AppRole.manager, AppRole.warehouse, AppRole.driver]),
  collectCashBulk,
);
router.post(
  "/cash/handoff-bulk",
  auth([AppRole.manager, AppRole.warehouse]),
  handoffCashBulk,
);
router.post(
  "/cash/settle-bulk",
  auth([AppRole.manager]),
  settleCashBulk,
);
router.get(
  "/cash/queue",
  auth([AppRole.manager, AppRole.warehouse]),
  listCashQueue,
);
router.get(
  "/cash/queue-summary",
  auth([AppRole.manager, AppRole.warehouse]),
  getCashQueueSummary,
);
router.post(
  "/:id/cash/collect",
  auth([AppRole.manager, AppRole.warehouse, AppRole.driver]),
  collectCash,
);
router.post(
  "/:id/cash/handoff",
  auth([AppRole.manager, AppRole.warehouse, AppRole.driver]),
  handoffCash,
);
router.post(
  "/:id/cash/settle",
  auth([AppRole.manager]),
  settleCash,
);
router.get(
  "/:id",
  auth([AppRole.manager, AppRole.warehouse, AppRole.customer, AppRole.driver]),
  getOne,
);

export default router;
