import { Router } from "express";
import { auth } from "../../middleware/auth";
import { AppRole } from "@prisma/client";
import { getInvoicePdfUrl } from "./invoiceController";

const router = Router();
router.get(
  "/orders/:id/url",
  auth([AppRole.manager, AppRole.customer]),
  getInvoicePdfUrl,
);
export default router;
