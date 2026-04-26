"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const client_1 = require("@prisma/client");
const express_rate_limit_1 = __importDefault(require("express-rate-limit"));
const auth_1 = require("../../middleware/auth");
const rateLimitStore_1 = require("../../config/rateLimitStore");
const controller_1 = require("./controller");
const router = (0, express_1.Router)();
const exportLimiter = (0, express_rate_limit_1.default)({
    windowMs: Number(process.env.EXPORT_RATE_LIMIT_WINDOW_MS || 10 * 60 * 1000),
    max: Number(process.env.EXPORT_RATE_LIMIT_MAX || 20),
    store: (0, rateLimitStore_1.createRateLimitStore)("orders-export"),
    standardHeaders: true,
    legacyHeaders: false,
    passOnStoreError: true,
});
router.post("/", (0, auth_1.auth)([client_1.AppRole.customer, client_1.AppRole.manager]), controller_1.create);
router.get("/import/template.csv", (0, auth_1.auth)([client_1.AppRole.manager, client_1.AppRole.customer]), controller_1.downloadImportTemplate);
router.post("/import/preview", (0, auth_1.auth)([client_1.AppRole.manager, client_1.AppRole.customer]), controller_1.previewImport);
router.post("/import/confirm", (0, auth_1.auth)([client_1.AppRole.manager, client_1.AppRole.customer]), controller_1.confirmImport);
router.get("/", (0, auth_1.auth)([client_1.AppRole.manager, client_1.AppRole.customer, client_1.AppRole.driver, client_1.AppRole.warehouse]), controller_1.list);
router.get("/export.csv", exportLimiter, (0, auth_1.auth)([client_1.AppRole.manager]), controller_1.exportCsv);
router.get("/driver-workloads", (0, auth_1.auth)([client_1.AppRole.manager, client_1.AppRole.warehouse]), controller_1.listDriverWorkload);
router.post("/assign-driver-bulk", (0, auth_1.auth)([client_1.AppRole.manager, client_1.AppRole.warehouse]), controller_1.assignDriversBulk);
router.post("/tasks/assign-bulk", (0, auth_1.auth)([client_1.AppRole.manager, client_1.AppRole.warehouse]), controller_1.assignTasksBulk);
router.post("/status-bulk", (0, auth_1.auth)([client_1.AppRole.manager, client_1.AppRole.warehouse]), controller_1.updateStatusBulk);
router.post("/driver-status", (0, auth_1.auth)([client_1.AppRole.driver]), controller_1.updateDriverStatus);
router.post("/:id/proofs", (0, auth_1.auth)([client_1.AppRole.driver]), controller_1.uploadDeliveryProofFiles, controller_1.submitOrderProof);
router.get("/:id/proofs", (0, auth_1.auth)([client_1.AppRole.manager, client_1.AppRole.warehouse, client_1.AppRole.customer, client_1.AppRole.driver]), controller_1.getOrderProofLinks);
router.post("/:id/delivery-proof", (0, auth_1.auth)([client_1.AppRole.driver]), controller_1.uploadDeliveryProofFiles, controller_1.submitDeliveryProof);
router.post("/cash/collect-bulk", (0, auth_1.auth)([client_1.AppRole.manager, client_1.AppRole.warehouse, client_1.AppRole.driver]), controller_1.collectCashBulk);
router.post("/cash/handoff-bulk", (0, auth_1.auth)([client_1.AppRole.manager, client_1.AppRole.warehouse]), controller_1.handoffCashBulk);
router.post("/cash/settle-bulk", (0, auth_1.auth)([client_1.AppRole.manager]), controller_1.settleCashBulk);
router.get("/cash/queue", (0, auth_1.auth)([client_1.AppRole.manager, client_1.AppRole.warehouse]), controller_1.listCashQueue);
router.get("/cash/queue-summary", (0, auth_1.auth)([client_1.AppRole.manager, client_1.AppRole.warehouse]), controller_1.getCashQueueSummary);
router.post("/:id/cash/collect", (0, auth_1.auth)([client_1.AppRole.manager, client_1.AppRole.warehouse, client_1.AppRole.driver]), controller_1.collectCash);
router.post("/:id/cash/handoff", (0, auth_1.auth)([client_1.AppRole.manager, client_1.AppRole.warehouse, client_1.AppRole.driver]), controller_1.handoffCash);
router.post("/:id/cash/settle", (0, auth_1.auth)([client_1.AppRole.manager]), controller_1.settleCash);
router.get("/:id", (0, auth_1.auth)([client_1.AppRole.manager, client_1.AppRole.warehouse, client_1.AppRole.customer, client_1.AppRole.driver]), controller_1.getOne);
exports.default = router;
