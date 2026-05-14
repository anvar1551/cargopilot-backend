import { FastifyPluginAsync } from "fastify";
import fastifyMultipart from "@fastify/multipart";
import {
  OrderDocumentType,
  OrderLegStatus,
  PricingComponentSource,
  PricingComponentType,
  TransportMode,
} from "@prisma/client";

import prisma from "../../../config/prismaClient";
import { emitAnalyticsInvalidationForMutation } from "../../../middleware/analyticsInvalidate";
import { fastifyAuth } from "../../../middleware/authFastify";
import {
  assignDriversBulkForActor,
  assignTasksBulkForActor,
  collectCashBulkForActor,
  collectCashForActor,
  createOrderForActor,
  exportOrdersCsvForActor,
  getCashQueueSummaryForActorView,
  getOrderForActor,
  getOrderImportTemplateCsv,
  handoffCashBulkForActor,
  handoffCashForActor,
  importOrdersFromCsv,
  listCashQueueForActorView,
  listDriverWorkloadForActor,
  listOrderProofLinksForActor,
  listOrdersForActor,
  previewOrderImport,
  requireOrderActor,
  settleCashBulkForActor,
  settleCashForActor,
  submitProofForActor,
  updateDriverStatusForActor,
  updateStatusBulkForActor,
} from "..";
import { authorize, buildOrderScopeWhere } from "../../identity-access";
import {
  createPricingComponent,
  listOrderDocuments,
  listOrderLegs,
  listPricingComponents,
  upsertOrderLeg,
} from "../../orders-legs";

function parseMaxPhotoBytes() {
  const fallback = 6 * 1024 * 1024;
  const raw = Number(process.env.DELIVERY_PROOF_MAX_PHOTO_BYTES ?? fallback);
  if (!Number.isFinite(raw) || raw <= 0) return fallback;
  return Math.floor(raw);
}

function fieldValue(field: any) {
  if (field == null) return undefined;
  if (typeof field === "string") return field;
  if (typeof field.value === "string") return field.value;
  return undefined;
}

function asEnumValue<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fieldName: string,
): T | undefined {
  if (value == null || value === "") return undefined;
  const asText = String(value).trim();
  if ((allowed as readonly string[]).includes(asText)) {
    return asText as T;
  }
  const err = new Error(`Invalid ${fieldName}: ${asText}`) as Error & { statusCode: number };
  err.statusCode = 400;
  throw err;
}

function parseNumber(value: unknown, fieldName: string, required = false) {
  if (value == null || value === "") {
    if (required) {
      const err = new Error(`${fieldName} is required`) as Error & { statusCode: number };
      err.statusCode = 400;
      throw err;
    }
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    const err = new Error(`${fieldName} must be a number`) as Error & { statusCode: number };
    err.statusCode = 400;
    throw err;
  }
  return parsed;
}

async function emitMutationInvalidation(args: {
  reason: "order_mutation" | "cash_mutation";
  request: any;
  entityId?: string | null;
}) {
  await emitAnalyticsInvalidationForMutation({
    reason: args.reason,
    method: args.request.method,
    path: args.request.url,
    user: args.request.user ?? null,
    entityId:
      args.entityId ??
      (typeof args.request.params?.id === "string" ? args.request.params.id : null),
  });
}

function sendError(reply: any, err: any, fallback = "Failed") {
  return reply.code(err?.statusCode ?? 500).send({ error: err?.message ?? fallback });
}

async function ensureOrderInScope(request: any, orderId: string) {
  const user = request.user;
  if (!user) {
    const err = new Error("Unauthorized") as Error & { statusCode: number };
    err.statusCode = 401;
    throw err;
  }
  await authorize(user, "orders.read");
  const scopeWhere = (await buildOrderScopeWhere(user)) ?? { id: "__no_access__" };
  const order = await prisma.order.findFirst({
    where: { AND: [{ id: orderId }, scopeWhere] },
    select: { id: true },
  });
  if (!order) {
    const err = new Error("Order not found") as Error & { statusCode: number };
    err.statusCode = 404;
    throw err;
  }
}

async function handleProofSubmit(request: any, reply: any, forcedStage?: "delivery") {
  const file = await request.file();
  if (!file) {
    return reply.code(400).send({ error: "photo is required" });
  }
  const buffer = await file.toBuffer();

  const stage = fieldValue((file.fields as any)?.stage);
  const signedBy = fieldValue((file.fields as any)?.signedBy);
  const signatureSvg = fieldValue((file.fields as any)?.signatureSvg);
  const savedAt = fieldValue((file.fields as any)?.savedAt);
  const signaturePaths = fieldValue((file.fields as any)?.signaturePaths);

  const actor = requireOrderActor(request.user);

  try {
    const result = await submitProofForActor({
      actor,
      orderId: String(request.params?.id ?? "").trim(),
      body: {
        stage,
        signedBy,
        signatureSvg,
        savedAt,
        signaturePaths,
      },
      file: {
        buffer,
        originalname: file.filename,
        mimetype: file.mimetype,
        size: buffer.length,
      },
      forcedStage,
    });

    await emitMutationInvalidation({
      reason: "order_mutation",
      request,
      entityId: typeof request.params?.id === "string" ? request.params.id : null,
    });

    return reply.send(result);
  } catch (err: any) {
    return sendError(reply, err, "Failed");
  }
}

const ordersFastifyRoutes: FastifyPluginAsync = async (fastify) => {
  await fastify.register(fastifyMultipart, {
    limits: {
      files: 1,
      fileSize: parseMaxPhotoBytes(),
    },
  });

  fastify.post("/", { preHandler: fastifyAuth({ permission: "orders.write" }) }, async (request, reply) => {
    try {
      const result = await createOrderForActor({ user: request.user, body: request.body });
      await emitMutationInvalidation({ reason: "order_mutation", request });
      return reply.code(result.statusCode).send(result.payload);
    } catch (err: any) {
      return sendError(reply, err, "Failed to create order");
    }
  });

  fastify.get("/import/template.csv", { preHandler: fastifyAuth({ permission: "orders.write" }) }, async (_request, reply) => {
    const csv = getOrderImportTemplateCsv();
    reply.header("Content-Type", "text/csv; charset=utf-8");
    reply.header("Content-Disposition", 'attachment; filename="order-import-template-v1.csv"');
    return reply.code(200).send(csv);
  });

  fastify.post("/import/preview", { preHandler: fastifyAuth({ permission: "orders.write" }) }, async (request, reply) => {
    try {
      if (!request.user?.id || !request.user.role) {
        return reply.code(401).send({ error: "Unauthorized" });
      }

      const body = (request.body ?? {}) as Record<string, unknown>;
      const csvText = typeof body.csvText === "string" ? body.csvText : "";
      const customerEntityId =
        typeof body.customerEntityId === "string"
          ? body.customerEntityId
          : request.user.customerEntityId ?? null;

      if (!csvText.trim()) {
        return reply.code(400).send({ error: "csvText is required" });
      }

      if (!customerEntityId) {
        return reply
          .code(400)
          .send({ error: "customerEntityId is required for bulk import" });
      }

      const preview = await previewOrderImport({ csvText, customerEntityId });
      return reply.send(preview);
    } catch (err: any) {
      return sendError(reply, err, "Failed to preview import");
    }
  });

  fastify.post("/import/confirm", { preHandler: fastifyAuth({ permission: "orders.write" }) }, async (request, reply) => {
    try {
      if (!request.user?.id || !request.user.role) {
        return reply.code(401).send({ error: "Unauthorized" });
      }

      const body = (request.body ?? {}) as Record<string, unknown>;
      const csvText = typeof body.csvText === "string" ? body.csvText : "";
      const customerEntityId =
        typeof body.customerEntityId === "string"
          ? body.customerEntityId
          : request.user.customerEntityId ?? null;

      if (!csvText.trim()) {
        return reply.code(400).send({ error: "csvText is required" });
      }

      if (!customerEntityId) {
        return reply
          .code(400)
          .send({ error: "customerEntityId is required for bulk import" });
      }

      const result = await importOrdersFromCsv({
        actor: request.user,
        csvText,
        customerEntityId,
      });

      await emitMutationInvalidation({ reason: "order_mutation", request });

      return reply.code(201).send({
        success: true,
        count: result.count,
        orders: result.orders,
      });
    } catch (err: any) {
      return sendError(reply, err, "Failed to import orders");
    }
  });

  fastify.get("/", { preHandler: fastifyAuth({ permission: "orders.read" }) }, async (request, reply) => {
    try {
      const actor = request.user as Express.User;
      const result = await listOrdersForActor({ actor, query: (request.query ?? {}) as any });
      return reply.send(result);
    } catch (err: any) {
      return sendError(reply, err, "Failed to list orders");
    }
  });

  fastify.get("/export.csv", { preHandler: fastifyAuth({ permission: "orders.export" }) }, async (request, reply) => {
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

  fastify.get("/driver-workloads", { preHandler: fastifyAuth({ permission: "orders.read" }) }, async (request, reply) => {
    try {
      const actor = request.user as Express.User;
      const workloads = await listDriverWorkloadForActor(actor);
      return reply.send({ workloads });
    } catch (err: any) {
      return sendError(reply, err, "Failed to fetch workloads");
    }
  });

  fastify.post("/assign-driver-bulk", { preHandler: fastifyAuth({ permission: "orders.write" }) }, async (request, reply) => {
    try {
      const includeFull = (request.query as any)?.include === "full";
      const actor = requireOrderActor(request.user);
      const result = await assignDriversBulkForActor({
        actor,
        body: (request.body ?? {}) as any,
        includeFull,
      });
      await emitMutationInvalidation({ reason: "order_mutation", request });
      return reply.send(result);
    } catch (err: any) {
      return sendError(reply, err, "Failed");
    }
  });

  fastify.post("/tasks/assign-bulk", { preHandler: fastifyAuth({ permission: "orders.write" }) }, async (request, reply) => {
    try {
      const includeFull = (request.query as any)?.include === "full";
      const actor = requireOrderActor(request.user);
      const result = await assignTasksBulkForActor({
        actor,
        body: (request.body ?? {}) as any,
        includeFull,
      });
      await emitMutationInvalidation({ reason: "order_mutation", request });
      return reply.send(result);
    } catch (err: any) {
      return sendError(reply, err, "Failed");
    }
  });

  fastify.post("/status-bulk", { preHandler: fastifyAuth({ permission: "orders.write" }) }, async (request, reply) => {
    try {
      const includeFull = (request.query as any)?.include === "full";
      const actor = requireOrderActor(request.user);
      const result = await updateStatusBulkForActor({
        actor,
        body: (request.body ?? {}) as any,
        includeFull,
      });
      await emitMutationInvalidation({ reason: "order_mutation", request });
      return reply.send(result);
    } catch (err: any) {
      return sendError(reply, err, "Failed");
    }
  });

  fastify.post("/driver-status", { preHandler: fastifyAuth({ permission: "orders.write" }) }, async (request, reply) => {
    try {
      const actor = requireOrderActor(request.user);
      const result = await updateDriverStatusForActor({
        actor,
        body: (request.body ?? {}) as any,
      });
      await emitMutationInvalidation({ reason: "order_mutation", request });
      return reply.send(result);
    } catch (err: any) {
      return sendError(reply, err, "Failed");
    }
  });

  fastify.get("/:id/legs", { preHandler: fastifyAuth({ permission: "orders.read" }) }, async (request, reply) => {
    try {
      const orderId = String((request.params as any)?.id ?? "").trim();
      await ensureOrderInScope(request, orderId);
      const legs = await listOrderLegs(orderId);
      return reply.send({ legs });
    } catch (err: any) {
      return sendError(reply, err, "Failed");
    }
  });

  fastify.post("/:id/legs", { preHandler: fastifyAuth({ permission: "orders.write" }) }, async (request, reply) => {
    try {
      const actor = requireOrderActor(request.user);
      const orderId = String((request.params as any)?.id ?? "").trim();
      await ensureOrderInScope(request, orderId);

      const body = (request.body ?? {}) as Record<string, unknown>;
      const leg = await upsertOrderLeg(orderId, {
        legId: ((request.params as any)?.legId ?? body.legId ?? null) as string | null,
        sequence: parseNumber(body.sequence, "sequence"),
        mode: asEnumValue(body.mode, Object.values(TransportMode), "mode") as
          | TransportMode
          | undefined,
        status: asEnumValue(body.status, Object.values(OrderLegStatus), "status") as
          | OrderLegStatus
          | undefined,
        fromCountry: (body.fromCountry ?? undefined) as string | undefined,
        toCountry: (body.toCountry ?? undefined) as string | undefined,
        transitRoute: body.transitRoute,
        fromWarehouseId: (body.fromWarehouseId ?? undefined) as string | undefined,
        toWarehouseId: (body.toWarehouseId ?? undefined) as string | undefined,
        carrierCode: (body.carrierCode ?? undefined) as string | undefined,
        carrierRef: (body.carrierRef ?? undefined) as string | undefined,
        vehicleRef: (body.vehicleRef ?? undefined) as string | undefined,
        plannedDepartureAt: (body.plannedDepartureAt ?? undefined) as string | undefined,
        plannedArrivalAt: (body.plannedArrivalAt ?? undefined) as string | undefined,
        actualDepartureAt: (body.actualDepartureAt ?? undefined) as string | undefined,
        actualArrivalAt: (body.actualArrivalAt ?? undefined) as string | undefined,
        notes: (body.notes ?? undefined) as string | undefined,
        metadata: body.metadata,
      }, actor);

      await emitMutationInvalidation({ reason: "order_mutation", request, entityId: orderId });
      return reply.send({ leg });
    } catch (err: any) {
      return sendError(reply, err, "Failed");
    }
  });

  fastify.put("/:id/legs/:legId", { preHandler: fastifyAuth({ permission: "orders.write" }) }, async (request, reply) => {
    try {
      const actor = requireOrderActor(request.user);
      const orderId = String((request.params as any)?.id ?? "").trim();
      await ensureOrderInScope(request, orderId);

      const body = (request.body ?? {}) as Record<string, unknown>;
      const leg = await upsertOrderLeg(orderId, {
        legId: String((request.params as any)?.legId ?? "").trim() || null,
        sequence: parseNumber(body.sequence, "sequence"),
        mode: asEnumValue(body.mode, Object.values(TransportMode), "mode") as
          | TransportMode
          | undefined,
        status: asEnumValue(body.status, Object.values(OrderLegStatus), "status") as
          | OrderLegStatus
          | undefined,
        fromCountry: (body.fromCountry ?? undefined) as string | undefined,
        toCountry: (body.toCountry ?? undefined) as string | undefined,
        transitRoute: body.transitRoute,
        fromWarehouseId: (body.fromWarehouseId ?? undefined) as string | undefined,
        toWarehouseId: (body.toWarehouseId ?? undefined) as string | undefined,
        carrierCode: (body.carrierCode ?? undefined) as string | undefined,
        carrierRef: (body.carrierRef ?? undefined) as string | undefined,
        vehicleRef: (body.vehicleRef ?? undefined) as string | undefined,
        plannedDepartureAt: (body.plannedDepartureAt ?? undefined) as string | undefined,
        plannedArrivalAt: (body.plannedArrivalAt ?? undefined) as string | undefined,
        actualDepartureAt: (body.actualDepartureAt ?? undefined) as string | undefined,
        actualArrivalAt: (body.actualArrivalAt ?? undefined) as string | undefined,
        notes: (body.notes ?? undefined) as string | undefined,
        metadata: body.metadata,
      }, actor);

      await emitMutationInvalidation({ reason: "order_mutation", request, entityId: orderId });
      return reply.send({ leg });
    } catch (err: any) {
      return sendError(reply, err, "Failed");
    }
  });

  fastify.get("/:id/pricing-components", { preHandler: fastifyAuth({ permission: "orders.read" }) }, async (request, reply) => {
    try {
      const orderId = String((request.params as any)?.id ?? "").trim();
      await ensureOrderInScope(request, orderId);
      const items = await listPricingComponents(orderId);
      return reply.send({ items });
    } catch (err: any) {
      return sendError(reply, err, "Failed");
    }
  });

  fastify.post("/:id/pricing-components", { preHandler: fastifyAuth({ permission: "orders.write" }) }, async (request, reply) => {
    try {
      const actor = requireOrderActor(request.user);
      const orderId = String((request.params as any)?.id ?? "").trim();
      await ensureOrderInScope(request, orderId);
      const body = (request.body ?? {}) as Record<string, unknown>;

      const item = await createPricingComponent(orderId, {
        orderLegId: (body.orderLegId ?? undefined) as string | undefined,
        componentType: asEnumValue(
          body.componentType,
          Object.values(PricingComponentType),
          "componentType",
        ) as PricingComponentType,
        source: asEnumValue(body.source, Object.values(PricingComponentSource), "source") as
          | PricingComponentSource
          | undefined,
        description: (body.description ?? undefined) as string | undefined,
        amount: parseNumber(body.amount, "amount", true)!,
        currency: String(body.currency ?? "").trim(),
        fxRateSnapshot: parseNumber(body.fxRateSnapshot, "fxRateSnapshot"),
        baseCurrency:
          body.baseCurrency != null ? String(body.baseCurrency).trim() : undefined,
        baseAmount: parseNumber(body.baseAmount, "baseAmount"),
        referenceKey: (body.referenceKey ?? undefined) as string | undefined,
      }, actor);

      await emitMutationInvalidation({ reason: "order_mutation", request, entityId: orderId });
      return reply.code(201).send({ item });
    } catch (err: any) {
      return sendError(reply, err, "Failed");
    }
  });

  fastify.get("/:id/documents", { preHandler: fastifyAuth({ permission: "orders.read" }) }, async (request, reply) => {
    try {
      const orderId = String((request.params as any)?.id ?? "").trim();
      await ensureOrderInScope(request, orderId);
      const query = (request.query ?? {}) as Record<string, unknown>;
      const type = asEnumValue(query.type, Object.values(OrderDocumentType), "type") as
        | OrderDocumentType
        | undefined;
      const limit = parseNumber(query.limit, "limit");
      const items = await listOrderDocuments(orderId, {
        type: type ?? null,
        limit: limit ?? undefined,
      });
      return reply.send({ items });
    } catch (err: any) {
      return sendError(reply, err, "Failed");
    }
  });

  fastify.get("/:id/proofs", { preHandler: fastifyAuth({ permission: "orders.read" }) }, async (request, reply) => {
    try {
      const user = request.user as Express.User;
      const result = await listOrderProofLinksForActor({
        user,
        orderId: String((request.params as any)?.id ?? "").trim(),
        query: (request.query ?? {}) as any,
      });
      return reply.send(result);
    } catch (err: any) {
      return sendError(reply, err, "Failed");
    }
  });

  fastify.post("/:id/proofs", { preHandler: fastifyAuth({ permission: "orders.write" }) }, async (request, reply) =>
    handleProofSubmit(request, reply),
  );

  fastify.post("/:id/delivery-proof", { preHandler: fastifyAuth({ permission: "orders.write" }) }, async (request, reply) =>
    handleProofSubmit(request, reply, "delivery"),
  );

  fastify.post("/cash/collect-bulk", { preHandler: fastifyAuth({ permission: "orders.write" }) }, async (request, reply) => {
    try {
      const actor = requireOrderActor(request.user);
      const result = await collectCashBulkForActor({ actor, body: (request.body ?? {}) as any });
      await emitMutationInvalidation({ reason: "cash_mutation", request });
      return reply.code(result.statusCode).send(result.payload);
    } catch (err: any) {
      return sendError(reply, err, "Failed to collect cash in bulk");
    }
  });

  fastify.post("/cash/handoff-bulk", { preHandler: fastifyAuth({ permission: "orders.write" }) }, async (request, reply) => {
    try {
      const actor = requireOrderActor(request.user);
      const result = await handoffCashBulkForActor({ actor, body: (request.body ?? {}) as any });
      await emitMutationInvalidation({ reason: "cash_mutation", request });
      return reply.code(result.statusCode).send(result.payload);
    } catch (err: any) {
      return sendError(reply, err, "Failed to hand off cash in bulk");
    }
  });

  fastify.post("/cash/settle-bulk", { preHandler: fastifyAuth({ permission: "orders.write" }) }, async (request, reply) => {
    try {
      const actor = requireOrderActor(request.user);
      const result = await settleCashBulkForActor({ actor, body: (request.body ?? {}) as any });
      await emitMutationInvalidation({ reason: "cash_mutation", request });
      return reply.code(result.statusCode).send(result.payload);
    } catch (err: any) {
      return sendError(reply, err, "Failed to settle cash in bulk");
    }
  });

  fastify.get("/cash/queue", { preHandler: fastifyAuth({ permission: "orders.read" }) }, async (request, reply) => {
    try {
      const actor = requireOrderActor(request.user);
      const data = await listCashQueueForActorView({
        actor,
        query: (request.query ?? {}) as any,
      });
      return reply.send(data);
    } catch (err: any) {
      return sendError(reply, err, "Failed to load cash queue");
    }
  });

  fastify.get("/cash/queue-summary", { preHandler: fastifyAuth({ permission: "orders.read" }) }, async (request, reply) => {
    try {
      const actor = requireOrderActor(request.user);
      const summary = await getCashQueueSummaryForActorView({
        actor,
        query: (request.query ?? {}) as any,
      });
      return reply.send(summary);
    } catch (err: any) {
      return sendError(reply, err, "Failed to load cash queue summary");
    }
  });

  fastify.post("/:id/cash/collect", { preHandler: fastifyAuth({ permission: "orders.write" }) }, async (request, reply) => {
    try {
      const actor = requireOrderActor(request.user);
      const result = await collectCashForActor({
        actor,
        orderId: String((request.params as any)?.id ?? "").trim(),
        body: (request.body ?? {}) as any,
      });
      await emitMutationInvalidation({ reason: "cash_mutation", request });
      return reply.send(result);
    } catch (err: any) {
      return sendError(reply, err, "Failed to collect cash");
    }
  });

  fastify.post("/:id/cash/handoff", { preHandler: fastifyAuth({ permission: "orders.write" }) }, async (request, reply) => {
    try {
      const actor = requireOrderActor(request.user);
      const result = await handoffCashForActor({
        actor,
        orderId: String((request.params as any)?.id ?? "").trim(),
        body: (request.body ?? {}) as any,
      });
      await emitMutationInvalidation({ reason: "cash_mutation", request });
      return reply.send(result);
    } catch (err: any) {
      return sendError(reply, err, "Failed to hand off cash");
    }
  });

  fastify.post("/:id/cash/settle", { preHandler: fastifyAuth({ permission: "orders.write" }) }, async (request, reply) => {
    try {
      const actor = requireOrderActor(request.user);
      const result = await settleCashForActor({
        actor,
        orderId: String((request.params as any)?.id ?? "").trim(),
        body: (request.body ?? {}) as any,
      });
      await emitMutationInvalidation({ reason: "cash_mutation", request });
      return reply.send(result);
    } catch (err: any) {
      return sendError(reply, err, "Failed to settle cash");
    }
  });

  fastify.get("/:id", { preHandler: fastifyAuth({ permission: "orders.read" }) }, async (request, reply) => {
    try {
      const actor = request.user as Express.User;
      const orderId = String((request.params as any)?.id ?? "").trim();
      const result = await getOrderForActor({ actor, orderId });

      if (result.status === 200) return reply.send(result.order);
      if (result.status === 404) return reply.code(404).send({ error: "Not found" });
      return reply.code(403).send({ error: "Forbidden" });
    } catch (err: any) {
      return sendError(reply, err, "Failed to fetch order");
    }
  });
};

export default ordersFastifyRoutes;
