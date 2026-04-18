"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const compression_1 = __importDefault(require("compression"));
const helmet_1 = __importDefault(require("helmet"));
const morgan_1 = __importDefault(require("morgan"));
const express_rate_limit_1 = __importDefault(require("express-rate-limit"));
const auth_1 = require("./middleware/auth");
const rateLimitStore_1 = require("./config/rateLimitStore");
const redis_1 = require("./config/redis");
const prismaClient_1 = __importDefault(require("./config/prismaClient"));
const userRoutes_1 = __importDefault(require("./services/users/userRoutes"));
const orderRoutes_1 = __importDefault(require("./services/orders/orderRoutes"));
const trackingRoutes_1 = __importDefault(require("./services/tracking/trackingRoutes"));
const warehouseRoutes_1 = __importDefault(require("./services/warehouse/warehouseRoutes"));
const driverRoutes_1 = __importDefault(require("./services/driver/driverRoutes"));
const invoiceRoutes_1 = __importDefault(require("./services/invoice/invoiceRoutes"));
const webhookRoutes_1 = __importDefault(require("./services/stripe/webhookRoutes"));
const managerRoutes_1 = __importDefault(require("./features/manager/managerRoutes"));
const labelRoutes_1 = __importDefault(require("./features/label/labelRoutes"));
const addressRoutes_1 = __importDefault(require("./services/addresses/addressRoutes"));
const customerRoutes_1 = __importDefault(require("./services/customers/customerRoutes"));
const pricingRoutes_1 = __importDefault(require("./services/pricing/pricingRoutes"));
const app = (0, express_1.default)();
app.set("trust proxy", process.env.TRUST_PROXY === "false" ? false : 1);
void (0, redis_1.getRedisClient)();
// Stripe webhook must come before JSON body parsing middleware.
app.use("/api/webhooks", webhookRoutes_1.default);
const allowedOrigins = new Set([
    process.env.CLIENT_URL,
    ...(process.env.CORS_ORIGINS || "")
        .split(",")
        .map((value) => value.trim()),
    ...(process.env.ADDITIONAL_ALLOWED_ORIGINS || "")
        .split(",")
        .map((value) => value.trim()),
].filter((value) => Boolean(value)));
app.use((0, cors_1.default)({
    origin: (origin, callback) => {
        if (!origin)
            return callback(null, true);
        if (allowedOrigins.size === 0)
            return callback(null, true);
        if (allowedOrigins.has(origin))
            return callback(null, true);
        return callback(new Error("Origin not allowed by CORS"));
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
}));
app.use((0, helmet_1.default)({
    crossOriginResourcePolicy: false,
}));
app.use((0, compression_1.default)({ threshold: 1024 }));
app.use(express_1.default.json({ limit: process.env.JSON_BODY_LIMIT || "5mb" }));
app.use((0, morgan_1.default)("dev", {
    skip: (req) => req.path === "/api/health",
}));
const globalLimiter = (0, express_rate_limit_1.default)({
    windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS || 15 * 60 * 1000),
    max: Number(process.env.RATE_LIMIT_MAX || 1200),
    store: (0, rateLimitStore_1.createRateLimitStore)("global"),
    standardHeaders: true,
    legacyHeaders: false,
    passOnStoreError: true,
});
const authLimiter = (0, express_rate_limit_1.default)({
    windowMs: Number(process.env.AUTH_RATE_LIMIT_WINDOW_MS || 15 * 60 * 1000),
    max: Number(process.env.AUTH_RATE_LIMIT_MAX || 120),
    store: (0, rateLimitStore_1.createRateLimitStore)("auth"),
    standardHeaders: true,
    legacyHeaders: false,
    passOnStoreError: true,
});
app.use(globalLimiter);
app.get("/api/health", async (_req, res) => {
    try {
        await prismaClient_1.default.$queryRaw `SELECT 1`;
        res.json({ status: "ok" });
    }
    catch (err) {
        res.status(500).json({ status: "error", error: err?.message });
    }
});
app.use("/api/auth", authLimiter, userRoutes_1.default);
app.get("/api/protected", (0, auth_1.auth)(["manager", "customer"]), (req, res) => {
    res.json({ msg: "You are allowed here", user: req.user });
});
app.use("/api/orders", orderRoutes_1.default);
app.use("/api/tracking", trackingRoutes_1.default);
app.use("/api/warehouses", warehouseRoutes_1.default);
app.use("/api/drivers", driverRoutes_1.default);
app.use("/api/invoices", invoiceRoutes_1.default);
app.use("/api/manager", managerRoutes_1.default);
app.use("/api/labels", labelRoutes_1.default);
app.use("/api/addresses", addressRoutes_1.default);
app.use("/api/customers", customerRoutes_1.default);
app.use("/api/pricing", pricingRoutes_1.default);
app.use((err, _req, res, next) => {
    if (err?.message === "Origin not allowed by CORS") {
        return res.status(403).json({ error: "CORS origin blocked" });
    }
    return next(err);
});
const portFromEnv = Number(process.env.PORT);
const PORT = Number.isFinite(portFromEnv) && portFromEnv > 0 ? portFromEnv : 4000;
app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on port ${PORT}`);
});
