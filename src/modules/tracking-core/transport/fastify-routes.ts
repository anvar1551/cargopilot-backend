import { FastifyPluginAsync } from "fastify";

import prisma from "../../../config/prismaClient";
import { fastifyAuth } from "../../../modules/identity-access/transport/fastify-auth";
import { buildOrderScopeWhere } from "../../identity-access";
import { getTrackingByOrderId } from "../application/trackingRepo";

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}

const trackingFastifyRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get(
    "/:id",
    { preHandler: fastifyAuth({ permission: "shipment.view" }) },
    async (request, reply) => {
      try {
        const orderId = String((request.params as any)?.id ?? "").trim();
        if (!isUuid(orderId)) {
          return reply.code(400).send({ error: "Invalid orderId" });
        }

        const scopeWhere = (await buildOrderScopeWhere(request.user!)) ?? {
          id: "__no_access__",
        };
        const order = await prisma.order.findFirst({
          where: {
            AND: [{ id: orderId }, scopeWhere],
          },
          select: { id: true },
        });

        if (!order) return reply.code(404).send({ error: "Order not found" });

        const tracking = await getTrackingByOrderId(orderId);
        return reply.send(tracking);
      } catch (err: any) {
        return reply.code(err?.statusCode ?? 500).send({
          error: err?.message || "Server error",
        });
      }
    },
  );
};

export default trackingFastifyRoutes;

