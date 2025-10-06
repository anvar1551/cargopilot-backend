import { Router } from "express";
import { create, list } from "./warehouseController";
import { auth } from "../../middleware/auth";

const router = Router();

router.post("/", auth(["manager"]), create);
router.get("/", auth(["manager", "warehouse", "driver", "customer"]), list);

export default router;
