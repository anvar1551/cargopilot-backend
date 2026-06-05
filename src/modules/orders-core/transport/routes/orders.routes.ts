import { FastifyPluginAsync } from "fastify";
import { fastifyAuth } from "../../../identity-access/transport/fastify-auth";
import {
  assignDriversBulkForActor,
  assignTasksBulkForActor,
  createOrderForActor,
  exportOrdersCsvForActor,
  listDriverWorkloadForActor,
  listOrdersForActor,
  requireOrderActor,
  updateDriverStatusForActor,
  updateStatusBulkForActor,
} from "../..";
import { emitMutationInvalidation, sendError } from "../shared";

const ordersRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post("/", { preHandler: fastifyAuth({ permission: "shipment.create" }) }, async (request, reply) => {
    try {
      const result = await createOrderForActor({ user: request.user, body: request.body });
      await emitMutationInvalidation("order_mutation");
      return reply.code(result.statusCode).send(result.payload);
    } catch (err: any) {
      return sendError(reply, err, "Failed to create order");
    }
  });

  fastify.get("/", { preHandler: fastifyAuth({ permission: "shipment.view" }) }, async (request, reply) => {
    try {
      const actor = request.user as Express.User;
      const result = await listOrdersForActor({ actor, query: (request.query ?? {}) as any });
      return reply.send(result);
    } catch (err: any) {
      return sendError(reply, err, "Failed to list orders");
    }
  });

  fastify.get("/export.csv", { preHandler: fastifyAuth({ permission: "shipment.export" }) }, async (request, reply) => {
    try {
      const actor = request.user as Express.User;
      const result = await exportOrdersCsvForActor({ actor, query: (request.query ?? {}) as any });
      reply.header("Content-Type", "text/csv; charset=utf-8");
      reply.header("Content-Disposition", `attachment; filename=\"${result.filename}\"`);
      return reply.code(200).send(result.csv);
    } catch (err: any) {
      return sendError(reply, err, "Failed to export CSV");
    }
  });

  fastify.get("/driver-workloads", { preHandler: fastifyAuth({ permission: "shipment.view" }) }, async (request, reply) => {
    try {
      const actor = request.user as Express.User;
      const workloads = await listDriverWorkloadForActor(actor);
      return reply.send({ workloads });
    } catch (err: any) {
      return sendError(reply, err, "Failed to fetch workloads");
    }
  });

  fastify.post("/assign-driver-bulk", { preHandler: fastifyAuth({ permission: "shipment.assignCourier" }) }, async (request, reply) => {
    try {
      const includeFull = (request.query as any)?.include === "full";
      const actor = requireOrderActor(request.user);
      const result = await assignDriversBulkForActor({ actor, body: (request.body ?? {}) as any, includeFull });
      await emitMutationInvalidation("order_mutation");
      return reply.send(result);
    } catch (err: any) {
      return sendError(reply, err, "Failed");
    }
  });

  fastify.post("/tasks/assign-bulk", { preHandler: fastifyAuth({ permission: "shipment.assignCourier" }) }, async (request, reply) => {
    try {
      const includeFull = (request.query as any)?.include === "full";
      const actor = requireOrderActor(request.user);
      const result = await assignTasksBulkForActor({ actor, body: (request.body ?? {}) as any, includeFull });
      await emitMutationInvalidation("order_mutation");
      return reply.send(result);
    } catch (err: any) {
      return sendError(reply, err, "Failed");
    }
  });

  fastify.post("/status-bulk", { preHandler: fastifyAuth({ permission: "shipment.changeStatus" }) }, async (request, reply) => {
    try {
      const includeFull = (request.query as any)?.include === "full";
      const actor = requireOrderActor(request.user);
      const result = await updateStatusBulkForActor({ actor, body: (request.body ?? {}) as any, includeFull });
      await emitMutationInvalidation("order_mutation");
      return reply.send(result);
    } catch (err: any) {
      return sendError(reply, err, "Failed");
    }
  });

  fastify.post("/driver-status", { preHandler: fastifyAuth({ permission: "shipment.changeStatus" }) }, async (request, reply) => {
    try {
      const actor = requireOrderActor(request.user);
      const result = await updateDriverStatusForActor({ actor, body: (request.body ?? {}) as any });
      await emitMutationInvalidation("order_mutation");
      return reply.send(result);
    } catch (err: any) {
      return sendError(reply, err, "Failed");
    }
  });
};

export default ordersRoutes;
