import { Router } from "express";
import { AppRole } from "@prisma/client";
import { auth } from "../../middleware/auth";
import {
  create,
  list,
  getOne,
  assign,
  updateStatus,
  assignBulk,
  updateStatusBulk,
} from "./orderController";

const router = Router();

router.post("/", auth([AppRole.customer, AppRole.manager]), create);
router.get(
  "/",
  auth([AppRole.manager, AppRole.customer, AppRole.driver, AppRole.warehouse]),
  list,
);
router.patch("/assign-driver-bulk", auth([AppRole.manager]), assignBulk);
router.patch("/status-bulk", auth([AppRole.manager]), updateStatusBulk);

router.get(
  "/:id",
  auth([AppRole.manager, AppRole.warehouse, AppRole.customer, AppRole.driver]),
  getOne,
);
router.patch("/:id/assign-driver", auth([AppRole.manager]), assign);
router.patch(
  "/:id/status",
  auth([AppRole.driver, AppRole.warehouse, AppRole.manager]),
  updateStatus,
);

export default router;
