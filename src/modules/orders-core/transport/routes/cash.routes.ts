import { FastifyPluginAsync } from "fastify";
import { fastifyAuth } from "../../../identity-access/transport/fastify-auth";
import {
  collectCashBulkForActor,
  collectCashForActor,
  getCashQueueSummaryForActorView,
  handoffCashBulkForActor,
  handoffCashForActor,
  listCashQueueForActorView,
  requireOrderActor,
  settleCashBulkForActor,
  settleCashForActor,
} from "../..";
import { emitMutationInvalidation, sendError } from "../shared";

const cashRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post("/cash/collect-bulk", { preHandler: fastifyAuth({ permission: "shipment.update" }) }, async (request, reply) => {
    try {
      const actor = requireOrderActor(request.user);
      const result = await collectCashBulkForActor({ actor, body: (request.body ?? {}) as any });
      await emitMutationInvalidation("cash_mutation");
      return reply.code(result.statusCode).send(result.payload);
    } catch (err: any) {
      return sendError(reply, err, "Failed to collect cash in bulk");
    }
  });

  fastify.post("/cash/handoff-bulk", { preHandler: fastifyAuth({ permission: "shipment.update" }) }, async (request, reply) => {
    try {
      const actor = requireOrderActor(request.user);
      const result = await handoffCashBulkForActor({ actor, body: (request.body ?? {}) as any });
      await emitMutationInvalidation("cash_mutation");
      return reply.code(result.statusCode).send(result.payload);
    } catch (err: any) {
      return sendError(reply, err, "Failed to hand off cash in bulk");
    }
  });

  fastify.post("/cash/settle-bulk", { preHandler: fastifyAuth({ permission: "finance.settleCash" }) }, async (request, reply) => {
    try {
      const actor = requireOrderActor(request.user);
      const result = await settleCashBulkForActor({ actor, body: (request.body ?? {}) as any });
      await emitMutationInvalidation("cash_mutation");
      return reply.code(result.statusCode).send(result.payload);
    } catch (err: any) {
      return sendError(reply, err, "Failed to settle cash in bulk");
    }
  });

  fastify.get("/cash/queue", { preHandler: fastifyAuth({ permission: "shipment.view" }) }, async (request, reply) => {
    try {
      const actor = requireOrderActor(request.user);
      const data = await listCashQueueForActorView({ actor, query: (request.query ?? {}) as any });
      return reply.send(data);
    } catch (err: any) {
      return sendError(reply, err, "Failed to load cash queue");
    }
  });

  fastify.get("/cash/queue-summary", { preHandler: fastifyAuth({ permission: "shipment.view" }) }, async (request, reply) => {
    try {
      const actor = requireOrderActor(request.user);
      const summary = await getCashQueueSummaryForActorView({ actor, query: (request.query ?? {}) as any });
      return reply.send(summary);
    } catch (err: any) {
      return sendError(reply, err, "Failed to load cash queue summary");
    }
  });

  fastify.post("/:id/cash/collect", { preHandler: fastifyAuth({ permission: "shipment.update" }) }, async (request, reply) => {
    try {
      const actor = requireOrderActor(request.user);
      const result = await collectCashForActor({
        actor,
        orderId: String((request.params as any)?.id ?? "").trim(),
        body: (request.body ?? {}) as any,
      });
      await emitMutationInvalidation("cash_mutation");
      return reply.send(result);
    } catch (err: any) {
      return sendError(reply, err, "Failed to collect cash");
    }
  });

  fastify.post("/:id/cash/handoff", { preHandler: fastifyAuth({ permission: "shipment.update" }) }, async (request, reply) => {
    try {
      const actor = requireOrderActor(request.user);
      const result = await handoffCashForActor({
        actor,
        orderId: String((request.params as any)?.id ?? "").trim(),
        body: (request.body ?? {}) as any,
      });
      await emitMutationInvalidation("cash_mutation");
      return reply.send(result);
    } catch (err: any) {
      return sendError(reply, err, "Failed to hand off cash");
    }
  });

  fastify.post("/:id/cash/settle", { preHandler: fastifyAuth({ permission: "finance.settleCash" }) }, async (request, reply) => {
    try {
      const actor = requireOrderActor(request.user);
      const result = await settleCashForActor({
        actor,
        orderId: String((request.params as any)?.id ?? "").trim(),
        body: (request.body ?? {}) as any,
      });
      await emitMutationInvalidation("cash_mutation");
      return reply.send(result);
    } catch (err: any) {
      return sendError(reply, err, "Failed to settle cash");
    }
  });
};

export default cashRoutes;
