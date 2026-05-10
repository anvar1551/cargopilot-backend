import { Router } from "express";
import rateLimit from "express-rate-limit";
import { auth } from "../../middleware/auth";
import { createRateLimitStore } from "../../config/rateLimitStore";
import {
  addSupportTicketMessageController,
  addSupportTicketNoteController,
  assignSupportTicketController,
  createSupportTicketController,
  escalateSupportTicketController,
  getSupportTicketController,
  listSupportAssigneesController,
  listSupportTicketsController,
  streamSupportController,
  updateSupportTicketStatusController,
} from "./supportController";

const router = Router();

const supportLimiter = rateLimit({
  windowMs: Number(process.env.SUPPORT_RATE_LIMIT_WINDOW_MS || 60 * 1000),
  max: Number(process.env.SUPPORT_RATE_LIMIT_MAX || 240),
  store: createRateLimitStore("manager-support"),
  standardHeaders: true,
  legacyHeaders: false,
  passOnStoreError: true,
});

const supportStreamLimiter = rateLimit({
  windowMs: Number(process.env.SUPPORT_STREAM_RATE_LIMIT_WINDOW_MS || 60 * 1000),
  max: Number(process.env.SUPPORT_STREAM_RATE_LIMIT_MAX || 80),
  store: createRateLimitStore("manager-support-stream"),
  standardHeaders: true,
  legacyHeaders: false,
  passOnStoreError: true,
});

router.get("/stream", supportStreamLimiter, auth(["manager"]), streamSupportController);
router.get("/assignees", supportLimiter, auth(["manager"]), listSupportAssigneesController);
router.get("/tickets", supportLimiter, auth(["manager"]), listSupportTicketsController);
router.post("/tickets", supportLimiter, auth(["manager"]), createSupportTicketController);
router.get("/tickets/:id", supportLimiter, auth(["manager"]), getSupportTicketController);
router.patch("/tickets/:id/status", supportLimiter, auth(["manager"]), updateSupportTicketStatusController);
router.patch("/tickets/:id/assign", supportLimiter, auth(["manager"]), assignSupportTicketController);
router.post("/tickets/:id/notes", supportLimiter, auth(["manager"]), addSupportTicketNoteController);
router.post("/tickets/:id/messages", supportLimiter, auth(["manager"]), addSupportTicketMessageController);
router.post("/tickets/:id/escalate", supportLimiter, auth(["manager"]), escalateSupportTicketController);

export default router;
