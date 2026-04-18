import { Router } from "express";
import { create, list, getWarehouse, update } from "./warehouseController";
import { auth } from "../../middleware/auth";
import { AppRole } from "@prisma/client";

const router = Router();

// Manager can create warehouses
router.post("/", auth([AppRole.manager]), create);

// Manager and warehouse users can list warehouses
router.get("/", auth([AppRole.manager, AppRole.warehouse]), list);

// Get specific warehouse info (manager only)
router.get("/:id", auth([AppRole.manager]), getWarehouse);
router.put("/:id", auth([AppRole.manager]), update);

export default router;
