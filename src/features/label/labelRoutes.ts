import { Router } from "express";
import { auth } from "../../middleware/auth";
import { getLabelPdfUrl } from "./labelController";

const router = Router();

// GET /api/labels/orders/:id/url
router.get(
  "/orders/:id/url",
  auth(["manager", "customer", "driver", "warehouse"]),
  getLabelPdfUrl
);

export default router;
