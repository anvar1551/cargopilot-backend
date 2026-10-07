import { assertCreationInputAuthority } from "../../domain/creation-authority";
import { FastifyPluginAsync } from "fastify";
import { fastifyAuth } from "../../../identity-access/transport/fastify-auth";
import { getOrderImportTemplateCsv, importOrdersFromCsv, previewOrderImport } from "../..";
import { emitMutationInvalidation, sendError } from "../shared";
import { readImportReceiptStatus } from "../../read/import-receipt-status";

const importRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get("/import/:operationId/status", { preHandler: fastifyAuth({ permission: "shipment.create" }) }, async (request, reply) => {
    try {
      reply.header("Cache-Control", "no-store");
      return reply.send(await readImportReceiptStatus(request.user!, (request.params as { operationId: string }).operationId));
    } catch (err) { return sendError(reply, err, "Failed to read import receipt"); }
  });
  fastify.get("/import/template.csv", { preHandler: fastifyAuth({ permission: "shipment.create" }) }, async (_request, reply) => {
    const csv = getOrderImportTemplateCsv();
    reply.header("Content-Type", "text/csv; charset=utf-8");
    reply.header("Content-Disposition", 'attachment; filename="order-import-template-v1.csv"');
    return reply.code(200).send(csv);
  });

  fastify.post("/import/preview", { preHandler: fastifyAuth({ permission: "shipment.create" }) }, async (request, reply) => {
    try {
      if (!request.user?.id) return reply.code(401).send({ error: "Unauthorized" });
      const body = (request.body ?? {}) as Record<string, unknown>;
      assertCreationInputAuthority(body);
      const csvText = typeof body.csvText === "string" ? body.csvText : "";
      const customerEntityId = typeof body.customerEntityId === "string" ? body.customerEntityId : null;
      if (!csvText.trim()) return reply.code(400).send({ error: "csvText is required" });
      const preview = await previewOrderImport({ actor: request.user!, csvText, customerEntityId });
      return reply.send(preview);
    } catch (err: any) {
      return sendError(reply, err, "Failed to preview import");
    }
  });

  fastify.post("/import/confirm", { preHandler: fastifyAuth({ permission: "shipment.create" }) }, async (request, reply) => {
    try {
      if (!request.user?.id) return reply.code(401).send({ error: "Unauthorized" });
      const body = (request.body ?? {}) as Record<string, unknown>;
      assertCreationInputAuthority(body);
      const csvText = typeof body.csvText === "string" ? body.csvText : "";
      const customerEntityId = typeof body.customerEntityId === "string" ? body.customerEntityId : null;
      if (!csvText.trim()) return reply.code(400).send({ error: "csvText is required" });
      const result = await importOrdersFromCsv({ actor: request.user, csvText, customerEntityId, operationId: body.operationId });
      if (result.replayedRows < result.count) await emitMutationInvalidation("order_mutation");
      return reply.code(201).send({ success: true, count: result.count, orders: result.orders, replayedRows: result.replayedRows, downstreamRecoveryRequired: result.downstreamRecoveryRequired });
    } catch (err: any) {
      return sendError(reply, err, "Failed to import orders");
    }
  });
};

export default importRoutes;
