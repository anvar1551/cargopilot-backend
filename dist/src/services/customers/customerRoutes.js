"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const auth_1 = require("../../middleware/auth");
const customerEntityController_1 = require("./customerEntityController");
const client_1 = require("@prisma/client");
const router = (0, express_1.Router)();
router.get("/", (0, auth_1.auth)([client_1.AppRole.manager, client_1.AppRole.customer]), customerEntityController_1.list);
router.get("/:id", (0, auth_1.auth)([client_1.AppRole.manager, client_1.AppRole.customer]), customerEntityController_1.getOne);
router.post("/", (0, auth_1.auth)([client_1.AppRole.manager]), customerEntityController_1.create); // keep create manager-only
exports.default = router;
