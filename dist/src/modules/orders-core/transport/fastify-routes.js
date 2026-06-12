"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const import_routes_1 = __importDefault(require("./routes/import.routes"));
const orders_routes_1 = __importDefault(require("./routes/orders.routes"));
const cash_routes_1 = __importDefault(require("./routes/cash.routes"));
const legs_pricing_routes_1 = __importDefault(require("./routes/legs-pricing.routes"));
const proofs_routes_1 = __importDefault(require("./routes/proofs.routes"));
const order_detail_routes_1 = __importDefault(require("./routes/order-detail.routes"));
const ordersFastifyRoutes = async (fastify) => {
    await fastify.register(import_routes_1.default);
    await fastify.register(orders_routes_1.default);
    await fastify.register(cash_routes_1.default);
    await fastify.register(legs_pricing_routes_1.default);
    await fastify.register(proofs_routes_1.default);
    // Keep dynamic order-id route last to avoid shadowing specific paths.
    await fastify.register(order_detail_routes_1.default);
};
exports.default = ordersFastifyRoutes;
