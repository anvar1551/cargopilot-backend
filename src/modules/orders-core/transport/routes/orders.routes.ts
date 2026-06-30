import { FastifyPluginAsync } from "fastify";
import { OrderStatus, ReasonCode } from "@prisma/client";
import { z } from "zod/v4";
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
import type { AppUser } from "../../../../types/app-user";

function enumSchema<T extends Record<string, string>>(enumObj: T) {
  return z.enum(Object.values(enumObj) as [string, ...string[]]);
}

const orderCreateBodySchema = z.record(z.string(), z.unknown());

const orderListQuerySchema = z.object({
  q: z.string().optional(),
  page: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().max(500).optional(),
  cursor: z.string().optional(),
  mode: z.enum(["page", "cursor"]).optional(),
  scope: z.enum(["fast", "deep"]).optional(),
  statuses: z.union([z.string(), z.array(z.string())]).optional(),
  createdFrom: z.string().optional(),
  createdTo: z.string().optional(),
  customerQuery: z.string().optional(),
  assignedDriverId: z.string().optional(),
  warehouseId: z.string().optional(),
  region: z.string().optional(),
});

const includeQuerySchema = z.object({
  include: z.enum(["full"]).optional(),
});

const bulkOrderIdsSchema = z.union([
  z.array(z.string().trim().min(1)).min(1),
  z.string().trim().min(1),
]);

const assignTasksBulkBodySchema = z.object({
  driverId: z.string().trim().min(1),
  type: z.enum(["pickup", "delivery", "linehaul"]).optional(),
  warehouseId: z.string().trim().nullable().optional(),
  note: z.string().nullable().optional(),
  region: z.string().nullable().optional(),
  orderIds: bulkOrderIdsSchema,
});

const statusBulkBodySchema = z.object({
  status: enumSchema(OrderStatus),
  reasonCode: enumSchema(ReasonCode).nullable().optional(),
  warehouseId: z.string().trim().nullable().optional(),
  note: z.string().nullable().optional(),
  region: z.string().nullable().optional(),
  orderIds: bulkOrderIdsSchema,
});

const driverStatusBodySchema = z.object({
  orderId: z.string().trim().min(1),
  status: enumSchema(OrderStatus),
  reasonCode: enumSchema(ReasonCode).nullable().optional(),
  note: z.string().nullable().optional(),
  region: z.string().nullable().optional(),
});

const ordersRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post("/", {
    preHandler: fastifyAuth({ permission: "shipment.create" }),
    schema: { body: orderCreateBodySchema },
  }, async (request, reply) => {
    try {
      const result = await createOrderForActor({ user: request.user, body: request.body });
      await emitMutationInvalidation("order_mutation");
      return reply.code(result.statusCode).send(result.payload);
    } catch (err: any) {
      return sendError(reply, err, "Failed to create order");
    }
  });

  fastify.get("/", {
    preHandler: fastifyAuth({ permission: "shipment.view" }),
    schema: { querystring: orderListQuerySchema },
  }, async (request, reply) => {
    try {
      const actor = request.user as AppUser;
      const result = await listOrdersForActor({ actor, query: (request.query ?? {}) as any });
      return reply.send(result);
    } catch (err: any) {
      return sendError(reply, err, "Failed to list orders");
    }
  });

  fastify.get("/export.csv", {
    preHandler: fastifyAuth({ permission: "shipment.export" }),
    schema: { querystring: orderListQuerySchema },
  }, async (request, reply) => {
    try {
      const actor = request.user as AppUser;
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
      const actor = request.user as AppUser;
      const workloads = await listDriverWorkloadForActor(actor);
      return reply.send({ workloads });
    } catch (err: any) {
      return sendError(reply, err, "Failed to fetch workloads");
    }
  });

  fastify.post("/assign-driver-bulk", {
    preHandler: fastifyAuth({ permission: "shipment.assignCourier" }),
    schema: { querystring: includeQuerySchema, body: assignTasksBulkBodySchema },
  }, async (request, reply) => {
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

  fastify.post("/tasks/assign-bulk", {
    preHandler: fastifyAuth({ permission: "shipment.assignCourier" }),
    schema: { querystring: includeQuerySchema, body: assignTasksBulkBodySchema },
  }, async (request, reply) => {
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

  fastify.post("/status-bulk", {
    preHandler: fastifyAuth({ permission: "shipment.changeStatus" }),
    schema: { querystring: includeQuerySchema, body: statusBulkBodySchema },
  }, async (request, reply) => {
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

  fastify.post("/driver-status", {
    preHandler: fastifyAuth({ permission: "shipment.changeStatus" }),
    schema: { body: driverStatusBodySchema },
  }, async (request, reply) => {
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
