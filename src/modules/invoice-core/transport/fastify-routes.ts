import { FastifyPluginAsync } from "fastify";
import { ZodError } from "zod";

import prisma from "../../../config/prismaClient";
import { presignGetObject } from "../../../utils/s3Presign";
import { fastifyAuth } from "../../../modules/identity-access/transport/fastify-auth";
import { buildOrderScopeWhere } from "../../identity-access";
import {
  issueOrderInvoiceForActor,
  listInvoicesForActor,
} from "../application/invoiceRepo";
import {
  invoiceOrderParamsSchema,
  issueInvoiceSchema,
  listInvoicesSchema,
} from "./validation";

function sendError(reply: any, error: unknown, fallback: string) {
  if (error instanceof ZodError) {
    return reply.code(400).send({ error: "Validation failed", issues: error.flatten() });
  }
  const candidate = error as { statusCode?: number; message?: string };
  return reply.code(candidate.statusCode ?? 500).send({
    error: candidate.message ?? fallback,
  });
}

const invoiceFastifyRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get(
    "/",
    { preHandler: fastifyAuth({ permission: "finance.invoices.read" }) },
    async (request, reply) => {
      try {
        const query = listInvoicesSchema.parse(request.query ?? {});
        return reply.send(await listInvoicesForActor({ user: request.user!, ...query }));
      } catch (error) {
        return sendError(reply, error, "Failed to list invoices");
      }
    },
  );

  fastify.post(
    "/orders/:orderId/issue",
    { preHandler: fastifyAuth({ permission: "finance.invoices.issue" }) },
    async (request, reply) => {
      try {
        const params = invoiceOrderParamsSchema.parse(request.params);
        const body = issueInvoiceSchema.parse(request.body ?? {});
        const invoice = await issueOrderInvoiceForActor({
          user: request.user!,
          orderId: params.orderId,
          dueAt: body.dueAt ? new Date(body.dueAt) : null,
        });
        return reply.code(201).send(invoice);
      } catch (error) {
        return sendError(reply, error, "Failed to issue invoice");
      }
    },
  );

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
