"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const warehouseController_1 = require("./warehouseController");
const auth_1 = require("../../middleware/auth");
const client_1 = require("@prisma/client");
const router = (0, express_1.Router)();
// Manager can create warehouses
router.post("/", (0, auth_1.auth)([client_1.AppRole.manager]), warehouseController_1.create);
// Manager and warehouse users can list warehouses
router.get("/", (0, auth_1.auth)([client_1.AppRole.manager, client_1.AppRole.warehouse]), warehouseController_1.list);
// Get specific warehouse info (manager only)
router.get("/:id", (0, auth_1.auth)([client_1.AppRole.manager]), warehouseController_1.getWarehouse);
exports.default = router;
