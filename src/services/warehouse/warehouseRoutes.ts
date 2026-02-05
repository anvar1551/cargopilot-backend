import { Router } from "express";
import { create, list, getWarehouse, scanPackage } from "./warehouseController";
import { auth } from "../../middleware/auth";
import { AppRole } from "@prisma/client";

const router = Router();

// Manager can create warehouses
router.post("/", auth([AppRole.manager]), create);

// Manager and warehouse users can list warehouses
router.get("/", auth([AppRole.manager, AppRole.warehouse]), list);
// Warehouse-only route
router.post("/scan", auth([AppRole.warehouse, AppRole.manager]), scanPackage);

// Get specific warehouse info (manager only)
router.get("/:id", auth([AppRole.manager]), getWarehouse);

export default router;
