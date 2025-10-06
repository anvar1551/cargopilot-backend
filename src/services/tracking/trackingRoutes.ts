import { Router } from "express";
import { auth } from "../../middleware/auth";
import { getOrderTracking } from "./trackingController";

const router = Router();

router.get(
  "/:orderId",
  auth(["manager", "warehouse", "customer", "driver"]),
  getOrderTracking
);

export default router;
