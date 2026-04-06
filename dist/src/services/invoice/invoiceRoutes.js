"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const auth_1 = require("../../middleware/auth");
const client_1 = require("@prisma/client");
const invoiceController_1 = require("./invoiceController");
const router = (0, express_1.Router)();
router.get("/orders/:id/url", (0, auth_1.auth)([client_1.AppRole.manager, client_1.AppRole.customer]), invoiceController_1.getInvoicePdfUrl);
exports.default = router;
