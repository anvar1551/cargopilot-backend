import { Router } from "express";
import { auth } from "../../middleware/auth";
import { getTracking } from "./trackingController";
import { AppRole } from "@prisma/client";

const router = Router();

// Anyone with rights to the order can view tracking (customer, driver, warehouse, manager)
router.get(
  "/:id",
  auth([AppRole.customer, AppRole.driver, AppRole.warehouse, AppRole.manager]),
  getTracking,
);

export default router;
