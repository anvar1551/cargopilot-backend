import { FastifyPluginAsync } from "fastify";
import prisma from "../../../config/prismaClient";
import { fastifyAuth } from "../../../modules/identity-access/transport/fastify-auth";
import { buildOrderScopeWhere } from "../../identity-access";
import { presignGetObject } from "../../../utils/s3Presign";

const labelsFastifyRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get(
    "/orders/:id/url",
    { preHandler: fastifyAuth({ permission: "shipment.view" }) },
    async (request, reply) => {
      try {
        const orderId = String((request.params as any)?.id || "").trim();
        const user = request.user!;
        const scopedWhere = await buildOrderScopeWhere(user);
        if (!scopedWhere) {
          return reply.code(403).send({ error: "Forbidden" });
        }

        const order = await prisma.order.findFirst({
          where: { id: orderId, ...scopedWhere },
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

