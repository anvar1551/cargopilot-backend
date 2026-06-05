import { FastifyPluginAsync } from "fastify";

import prisma from "../../../config/prismaClient";
import { presignGetObject } from "../../../utils/s3Presign";
import { fastifyAuth } from "../../../modules/identity-access/transport/fastify-auth";
import { buildOrderScopeWhere } from "../../identity-access";

const invoiceFastifyRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get(
    "/orders/:id/url",
    { preHandler: fastifyAuth({ permission: "payments.intents.read" }) },
    async (request, reply) => {
      try {
        const idParam = String((request.params as any)?.id ?? "").trim();
        if (!idParam) return reply.code(400).send({ error: "Order id is required" });

        const scopeWhere = (await buildOrderScopeWhere(request.user!)) ?? {
          id: "__no_access__",
        };

        let invoice = await prisma.invoice.findFirst({
          where: {
            orderId: idParam,
            order: {
              is: scopeWhere,
            },
          },
          include: { order: true },
        });

        if (!invoice) {
          invoice = await prisma.invoice.findFirst({
            where: {
              id: idParam,
              order: {
                is: scopeWhere,
              },
            },
            include: { order: true },
          });
        }

        if (!invoice) return reply.code(404).send({ error: "Invoice not found" });
        if (!invoice.invoiceKey) {
          return reply.code(404).send({ error: "Invoice PDF not available yet" });
        }

        const url = await presignGetObject(invoice.invoiceKey, 60 * 5);
        return reply.send({ url });
      } catch (err: any) {
        return reply.code(err?.statusCode ?? 500).send({
          error: err?.message ?? "Failed to get invoice url",
        });
      }
    },
  );
};

export default invoiceFastifyRoutes;
