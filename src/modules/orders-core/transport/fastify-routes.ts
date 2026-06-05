import { FastifyPluginAsync } from "fastify";
import importRoutes from "./routes/import.routes";
import ordersRoutes from "./routes/orders.routes";
import cashRoutes from "./routes/cash.routes";
import legsPricingRoutes from "./routes/legs-pricing.routes";
import proofsRoutes from "./routes/proofs.routes";
import orderDetailRoutes from "./routes/order-detail.routes";

const ordersFastifyRoutes: FastifyPluginAsync = async (fastify) => {
  await fastify.register(importRoutes);
  await fastify.register(ordersRoutes);
  await fastify.register(cashRoutes);
  await fastify.register(legsPricingRoutes);
  await fastify.register(proofsRoutes);
  // Keep dynamic order-id route last to avoid shadowing specific paths.
  await fastify.register(orderDetailRoutes);
};

export default ordersFastifyRoutes;
