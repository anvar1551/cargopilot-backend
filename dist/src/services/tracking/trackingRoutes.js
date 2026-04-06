"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const auth_1 = require("../../middleware/auth");
const trackingController_1 = require("./trackingController");
const client_1 = require("@prisma/client");
const router = (0, express_1.Router)();
// Anyone with rights to the order can view tracking (customer, driver, warehouse, manager)
router.get("/:id", (0, auth_1.auth)([client_1.AppRole.customer, client_1.AppRole.driver, client_1.AppRole.warehouse, client_1.AppRole.manager]), trackingController_1.getTracking);
exports.default = router;
