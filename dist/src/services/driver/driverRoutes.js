"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const auth_1 = require("../../middleware/auth");
const client_1 = require("@prisma/client");
const driverController_1 = require("./driverController");
const router = (0, express_1.Router)();
router.get("/", (0, auth_1.auth)([client_1.AppRole.manager]), driverController_1.listDrivers);
exports.default = router;
