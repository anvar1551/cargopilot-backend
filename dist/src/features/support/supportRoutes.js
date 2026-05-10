"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const express_rate_limit_1 = __importDefault(require("express-rate-limit"));
const auth_1 = require("../../middleware/auth");
const rateLimitStore_1 = require("../../config/rateLimitStore");
const supportController_1 = require("./supportController");
const router = (0, express_1.Router)();
const supportLimiter = (0, express_rate_limit_1.default)({
    windowMs: Number(process.env.SUPPORT_RATE_LIMIT_WINDOW_MS || 60 * 1000),
    max: Number(process.env.SUPPORT_RATE_LIMIT_MAX || 240),
    store: (0, rateLimitStore_1.createRateLimitStore)("manager-support"),
    standardHeaders: true,
    legacyHeaders: false,
    passOnStoreError: true,
});
const supportStreamLimiter = (0, express_rate_limit_1.default)({
    windowMs: Number(process.env.SUPPORT_STREAM_RATE_LIMIT_WINDOW_MS || 60 * 1000),
    max: Number(process.env.SUPPORT_STREAM_RATE_LIMIT_MAX || 80),
    store: (0, rateLimitStore_1.createRateLimitStore)("manager-support-stream"),
    standardHeaders: true,
    legacyHeaders: false,
    passOnStoreError: true,
});
router.get("/stream", supportStreamLimiter, (0, auth_1.auth)(["manager"]), supportController_1.streamSupportController);
router.get("/assignees", supportLimiter, (0, auth_1.auth)(["manager"]), supportController_1.listSupportAssigneesController);
router.get("/tickets", supportLimiter, (0, auth_1.auth)(["manager"]), supportController_1.listSupportTicketsController);
router.post("/tickets", supportLimiter, (0, auth_1.auth)(["manager"]), supportController_1.createSupportTicketController);
router.get("/tickets/:id", supportLimiter, (0, auth_1.auth)(["manager"]), supportController_1.getSupportTicketController);
router.patch("/tickets/:id/status", supportLimiter, (0, auth_1.auth)(["manager"]), supportController_1.updateSupportTicketStatusController);
router.patch("/tickets/:id/assign", supportLimiter, (0, auth_1.auth)(["manager"]), supportController_1.assignSupportTicketController);
router.post("/tickets/:id/notes", supportLimiter, (0, auth_1.auth)(["manager"]), supportController_1.addSupportTicketNoteController);
router.post("/tickets/:id/messages", supportLimiter, (0, auth_1.auth)(["manager"]), supportController_1.addSupportTicketMessageController);
router.post("/tickets/:id/escalate", supportLimiter, (0, auth_1.auth)(["manager"]), supportController_1.escalateSupportTicketController);
exports.default = router;
