import { FastifyPluginAsync } from "fastify";
import prisma from "../../../config/prismaClient";
import { fastifyAuth } from "../../../middleware/authFastify";
import { presignGetObject } from "../../../utils/s3Presign";

const labelsFastifyRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get(
    "/orders/:id/url",
    { preHandler: fastifyAuth({ permission: "orders.read" }) },
    async (request, reply) => {
      try {
        const orderId = String((request.params as any)?.id || "").trim();
        const user = request.user!;

        const order = await prisma.order.findUnique({
          where: { id: orderId },
          select: {
            id: true,
            customerId: true,
            customerEntityId: true,
            assignedDriverId: true,
            currentWarehouseId: true,
            labelKey: true,
            parcels: {
              select: {
                id: true,
                pieceNo: true,
                pieceTotal: true,
                parcelCode: true,
                labelKey: true,
              },
              orderBy: { pieceNo: "asc" },
            },
          },
        });

        if (!order) return reply.code(404).send({ error: "Order not found" });

        if (user.role === "customer") {
          const allowed =
            (user.customerEntityId && order.customerEntityId === user.customerEntityId) ||
            order.customerId === user.id;
          if (!allowed) return reply.code(403).send({ error: "Forbidden" });
        } else if (user.role === "driver" && order.assignedDriverId !== user.id) {
          return reply.code(403).send({ error: "Forbidden" });
        }

        const parcelLabels = order.parcels.filter((p) => Boolean(p.labelKey));
        if (parcelLabels.length === 0 && order.labelKey) {
          const url = await presignGetObject(order.labelKey, 300);
          return reply.send({ url });
        }

        if (parcelLabels.length === 0) {
          return reply.code(404).send({ error: "Label not available yet" });
        }

        const urls = await Promise.all(
          parcelLabels.map(async (parcel) => ({
            parcelId: parcel.id,
            parcelCode: parcel.parcelCode,
            pieceNo: parcel.pieceNo,
            pieceTotal: parcel.pieceTotal,
            url: await presignGetObject(parcel.labelKey!, 300),
          })),
        );

        return reply.send({ url: urls[0].url, urls });
      } catch (err: any) {
        return reply.code(500).send({ error: err?.message || "Failed to load label" });
      }
    },
  );
};

export default labelsFastifyRoutes;
