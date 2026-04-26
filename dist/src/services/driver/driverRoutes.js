"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const express_rate_limit_1 = __importDefault(require("express-rate-limit"));
const auth_1 = require("../../middleware/auth");
const client_1 = require("@prisma/client");
const driverController_1 = require("./driverController");
const liveMapController_1 = require("../../features/liveMap/liveMapController");
const rateLimitStore_1 = require("../../config/rateLimitStore");
const router = (0, express_1.Router)();
const locationLimiter = (0, express_rate_limit_1.default)({
    windowMs: Number(process.env.DRIVER_LOCATION_RATE_LIMIT_WINDOW_MS || 60 * 1000),
    max: Number(process.env.DRIVER_LOCATION_RATE_LIMIT_MAX || 180),
    store: (0, rateLimitStore_1.createRateLimitStore)("driver-location"),
    standardHeaders: true,
    legacyHeaders: false,
    passOnStoreError: true,
});
const presenceLimiter = (0, express_rate_limit_1.default)({
    windowMs: Number(process.env.DRIVER_PRESENCE_RATE_LIMIT_WINDOW_MS || 60 * 1000),
    max: Number(process.env.DRIVER_PRESENCE_RATE_LIMIT_MAX || 240),
    store: (0, rateLimitStore_1.createRateLimitStore)("driver-presence"),
    standardHeaders: true,
    legacyHeaders: false,
    passOnStoreError: true,
});
router.get("/", (0, auth_1.auth)([client_1.AppRole.manager]), driverController_1.listDrivers);
router.post("/location", locationLimiter, (0, auth_1.auth)([client_1.AppRole.driver, client_1.AppRole.manager]), liveMapController_1.ingestDriverLocationController);
router.get("/presence", presenceLimiter, (0, auth_1.auth)([client_1.AppRole.driver, client_1.AppRole.manager]), liveMapController_1.getDriverPresenceController);
router.put("/presence", presenceLimiter, (0, auth_1.auth)([client_1.AppRole.driver, client_1.AppRole.manager]), liveMapController_1.setDriverPresenceController);
router.post("/presence/heartbeat", presenceLimiter, (0, auth_1.auth)([client_1.AppRole.driver, client_1.AppRole.manager]), liveMapController_1.heartbeatDriverPresenceController);
router.put("/:id", (0, auth_1.auth)([client_1.AppRole.manager]), driverController_1.updateDriverProfile);
exports.default = router;
