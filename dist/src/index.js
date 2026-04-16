"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const morgan_1 = __importDefault(require("morgan"));
const auth_1 = require("./middleware/auth");
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
// Stripe webhook must come before JSON body parsing middleware.
app.use("/api/webhooks", webhookRoutes_1.default);
app.use((0, cors_1.default)());
app.use(express_1.default.json());
app.use((0, morgan_1.default)("dev"));
app.get("/api/health", async (_req, res) => {
    try {
        await prismaClient_1.default.$queryRaw `SELECT 1`;
        res.json({ status: "ok" });
    }
    catch (err) {
        res.status(500).json({ status: "error", error: err?.message });
    }
});
app.use("/api/auth", userRoutes_1.default);
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
const portFromEnv = Number(process.env.PORT);
const PORT = Number.isFinite(portFromEnv) && portFromEnv > 0 ? portFromEnv : 4000;
app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on port ${PORT}`);
});
