import { Router } from "express";
import { assign, create, getOne, list, updateStatus } from "./orderController";
import { auth } from "../../middleware/auth";

const router = Router();

router.post("/", auth(["customer"]), create); // Customers create orders
router.get("/", auth(["manager", "customer", "driver"]), list);
router.get(
  "/:id",
  auth(["manager", "warehouse", "customer", "driver"]),
  getOne
);

router.patch("/:id/assign-driver", auth(["manager"]), assign);
router.patch("/:id/status", auth(["driver", "warehouse"]), updateStatus);

export default router;
