"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const auth_1 = require("../../middleware/auth");
const labelController_1 = require("./labelController");
const router = (0, express_1.Router)();
// GET /api/labels/orders/:id/url
router.get("/orders/:id/url", (0, auth_1.auth)(["manager", "customer", "driver", "warehouse"]), labelController_1.getLabelPdfUrl);
exports.default = router;
