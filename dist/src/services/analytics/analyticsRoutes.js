"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const analyticsController_1 = require("./analyticsController");
const auth_1 = require("../../middleware/auth");
const router = (0, express_1.Router)();
// Manager-only route
router.get("/overview", (0, auth_1.auth)(["manager"]), analyticsController_1.getManagerOverview);
exports.default = router;
