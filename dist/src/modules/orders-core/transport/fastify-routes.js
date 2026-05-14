"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const multipart_1 = __importDefault(require("@fastify/multipart"));
const client_1 = require("@prisma/client");
const prismaClient_1 = __importDefault(require("../../../config/prismaClient"));
const analyticsInvalidate_1 = require("../../../middleware/analyticsInvalidate");
const authFastify_1 = require("../../../middleware/authFastify");
const __1 = require("..");
const identity_access_1 = require("../../identity-access");
const orders_legs_1 = require("../../orders-legs");
function parseMaxPhotoBytes() {
    const fallback = 6 * 1024 * 1024;
    const raw = Number(process.env.DELIVERY_PROOF_MAX_PHOTO_BYTES ?? fallback);
    if (!Number.isFinite(raw) || raw <= 0)
        return fallback;
    return Math.floor(raw);
}
function fieldValue(field) {
    if (field == null)
        return undefined;
    if (typeof field === "string")
        return field;
    if (typeof field.value === "string")
        return field.value;
    return undefined;
}
function asEnumValue(value, allowed, fieldName) {
    if (value == null || value === "")
        return undefined;
    const asText = String(value).trim();
    if (allowed.includes(asText)) {
        return asText;
    }
    const err = new Error(`Invalid ${fieldName}: ${asText}`);
    err.statusCode = 400;
    throw err;
}
function parseNumber(value, fieldName, required = false) {
    if (value == null || value === "") {
        if (required) {
            const err = new Error(`${fieldName} is required`);
            err.statusCode = 400;
            throw err;
        }
        return undefined;
    }
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
        const err = new Error(`${fieldName} must be a number`);
        err.statusCode = 400;
        throw err;
    }
    return parsed;
}
async function emitMutationInvalidation(args) {
    await (0, analyticsInvalidate_1.emitAnalyticsInvalidationForMutation)({
        reason: args.reason,
        method: args.request.method,
        path: args.request.url,
        user: args.request.user ?? null,
        entityId: args.entityId ??
            (typeof args.request.params?.id === "string" ? args.request.params.id : null),
    });
}
function sendError(reply, err, fallback = "Failed") {
    return reply.code(err?.statusCode ?? 500).send({ error: err?.message ?? fallback });
}
async function ensureOrderInScope(request, orderId) {
    const user = request.user;
    if (!user) {
        const err = new Error("Unauthorized");
        err.statusCode = 401;
        throw err;
    }
    await (0, identity_access_1.authorize)(user, "orders.read");
    const scopeWhere = (await (0, identity_access_1.buildOrderScopeWhere)(user)) ?? { id: "__no_access__" };
    const order = await prismaClient_1.default.order.findFirst({
        where: { AND: [{ id: orderId }, scopeWhere] },
        select: { id: true },
    });
    if (!order) {
        const err = new Error("Order not found");
        err.statusCode = 404;
        throw err;
    }
}
async function handleProofSubmit(request, reply, forcedStage) {
    const file = await request.file();
    if (!file) {
        return reply.code(400).send({ error: "photo is required" });
    }
    const buffer = await file.toBuffer();
    const stage = fieldValue(file.fields?.stage);
    const signedBy = fieldValue(file.fields?.signedBy);
    const signatureSvg = fieldValue(file.fields?.signatureSvg);
    const savedAt = fieldValue(file.fields?.savedAt);
    const signaturePaths = fieldValue(file.fields?.signaturePaths);
    const actor = (0, __1.requireOrderActor)(request.user);
    try {
        const result = await (0, __1.submitProofForActor)({
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
    }
    catch (err) {
        return sendError(reply, err, "Failed");
    }
}
const ordersFastifyRoutes = async (fastify) => {
    await fastify.register(multipart_1.default, {
        limits: {
            files: 1,
            fileSize: parseMaxPhotoBytes(),
        },
    });
    fastify.post("/", { preHandler: (0, authFastify_1.fastifyAuth)({ permission: "orders.write" }) }, async (request, reply) => {
        try {
            const result = await (0, __1.createOrderForActor)({ user: request.user, body: request.body });
            await emitMutationInvalidation({ reason: "order_mutation", request });
            return reply.code(result.statusCode).send(result.payload);
        }
        catch (err) {
            return sendError(reply, err, "Failed to create order");
        }
    });
    fastify.get("/import/template.csv", { preHandler: (0, authFastify_1.fastifyAuth)({ permission: "orders.write" }) }, async (_request, reply) => {
        const csv = (0, __1.getOrderImportTemplateCsv)();
        reply.header("Content-Type", "text/csv; charset=utf-8");
        reply.header("Content-Disposition", 'attachment; filename="order-import-template-v1.csv"');
        return reply.code(200).send(csv);
    });
    fastify.post("/import/preview", { preHandler: (0, authFastify_1.fastifyAuth)({ permission: "orders.write" }) }, async (request, reply) => {
        try {
            if (!request.user?.id || !request.user.role) {
                return reply.code(401).send({ error: "Unauthorized" });
            }
            const body = (request.body ?? {});
            const csvText = typeof body.csvText === "string" ? body.csvText : "";
            const customerEntityId = typeof body.customerEntityId === "string"
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
            const preview = await (0, __1.previewOrderImport)({ csvText, customerEntityId });
            return reply.send(preview);
        }
        catch (err) {
            return sendError(reply, err, "Failed to preview import");
        }
    });
    fastify.post("/import/confirm", { preHandler: (0, authFastify_1.fastifyAuth)({ permission: "orders.write" }) }, async (request, reply) => {
        try {
            if (!request.user?.id || !request.user.role) {
                return reply.code(401).send({ error: "Unauthorized" });
            }
            const body = (request.body ?? {});
            const csvText = typeof body.csvText === "string" ? body.csvText : "";
            const customerEntityId = typeof body.customerEntityId === "string"
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
            const result = await (0, __1.importOrdersFromCsv)({
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
        }
        catch (err) {
            return sendError(reply, err, "Failed to import orders");
        }
    });
    fastify.get("/", { preHandler: (0, authFastify_1.fastifyAuth)({ permission: "orders.read" }) }, async (request, reply) => {
        try {
            const actor = request.user;
            const result = await (0, __1.listOrdersForActor)({ actor, query: (request.query ?? {}) });
            return reply.send(result);
        }
        catch (err) {
            return sendError(reply, err, "Failed to list orders");
        }
    });
    fastify.get("/export.csv", { preHandler: (0, authFastify_1.fastifyAuth)({ permission: "orders.export" }) }, async (request, reply) => {
        try {
            const actor = request.user;
            const result = await (0, __1.exportOrdersCsvForActor)({ actor, query: (request.query ?? {}) });
            reply.header("Content-Type", "text/csv; charset=utf-8");
            reply.header("Content-Disposition", `attachment; filename=\"${result.filename}\"`);
            return reply.code(200).send(result.csv);
        }
        catch (err) {
            return sendError(reply, err, "Failed to export CSV");
        }
    });
    fastify.get("/driver-workloads", { preHandler: (0, authFastify_1.fastifyAuth)({ permission: "orders.read" }) }, async (request, reply) => {
        try {
            const actor = request.user;
            const workloads = await (0, __1.listDriverWorkloadForActor)(actor);
            return reply.send({ workloads });
        }
        catch (err) {
            return sendError(reply, err, "Failed to fetch workloads");
        }
    });
    fastify.post("/assign-driver-bulk", { preHandler: (0, authFastify_1.fastifyAuth)({ permission: "orders.write" }) }, async (request, reply) => {
        try {
            const includeFull = request.query?.include === "full";
            const actor = (0, __1.requireOrderActor)(request.user);
            const result = await (0, __1.assignDriversBulkForActor)({
                actor,
                body: (request.body ?? {}),
                includeFull,
            });
            await emitMutationInvalidation({ reason: "order_mutation", request });
            return reply.send(result);
        }
        catch (err) {
            return sendError(reply, err, "Failed");
        }
    });
    fastify.post("/tasks/assign-bulk", { preHandler: (0, authFastify_1.fastifyAuth)({ permission: "orders.write" }) }, async (request, reply) => {
        try {
            const includeFull = request.query?.include === "full";
            const actor = (0, __1.requireOrderActor)(request.user);
            const result = await (0, __1.assignTasksBulkForActor)({
                actor,
                body: (request.body ?? {}),
                includeFull,
            });
            await emitMutationInvalidation({ reason: "order_mutation", request });
            return reply.send(result);
        }
        catch (err) {
            return sendError(reply, err, "Failed");
        }
    });
    fastify.post("/status-bulk", { preHandler: (0, authFastify_1.fastifyAuth)({ permission: "orders.write" }) }, async (request, reply) => {
        try {
            const includeFull = request.query?.include === "full";
            const actor = (0, __1.requireOrderActor)(request.user);
            const result = await (0, __1.updateStatusBulkForActor)({
                actor,
                body: (request.body ?? {}),
                includeFull,
            });
            await emitMutationInvalidation({ reason: "order_mutation", request });
            return reply.send(result);
        }
        catch (err) {
            return sendError(reply, err, "Failed");
        }
    });
    fastify.post("/driver-status", { preHandler: (0, authFastify_1.fastifyAuth)({ permission: "orders.write" }) }, async (request, reply) => {
        try {
            const actor = (0, __1.requireOrderActor)(request.user);
            const result = await (0, __1.updateDriverStatusForActor)({
                actor,
                body: (request.body ?? {}),
            });
            await emitMutationInvalidation({ reason: "order_mutation", request });
            return reply.send(result);
        }
        catch (err) {
            return sendError(reply, err, "Failed");
        }
    });
    fastify.get("/:id/legs", { preHandler: (0, authFastify_1.fastifyAuth)({ permission: "orders.read" }) }, async (request, reply) => {
        try {
            const orderId = String(request.params?.id ?? "").trim();
            await ensureOrderInScope(request, orderId);
            const legs = await (0, orders_legs_1.listOrderLegs)(orderId);
            return reply.send({ legs });
        }
        catch (err) {
            return sendError(reply, err, "Failed");
        }
    });
    fastify.post("/:id/legs", { preHandler: (0, authFastify_1.fastifyAuth)({ permission: "orders.write" }) }, async (request, reply) => {
        try {
            const actor = (0, __1.requireOrderActor)(request.user);
            const orderId = String(request.params?.id ?? "").trim();
            await ensureOrderInScope(request, orderId);
            const body = (request.body ?? {});
            const leg = await (0, orders_legs_1.upsertOrderLeg)(orderId, {
                legId: (request.params?.legId ?? body.legId ?? null),
                sequence: parseNumber(body.sequence, "sequence"),
                mode: asEnumValue(body.mode, Object.values(client_1.TransportMode), "mode"),
                status: asEnumValue(body.status, Object.values(client_1.OrderLegStatus), "status"),
                fromCountry: (body.fromCountry ?? undefined),
                toCountry: (body.toCountry ?? undefined),
                transitRoute: body.transitRoute,
                fromWarehouseId: (body.fromWarehouseId ?? undefined),
                toWarehouseId: (body.toWarehouseId ?? undefined),
                carrierCode: (body.carrierCode ?? undefined),
                carrierRef: (body.carrierRef ?? undefined),
                vehicleRef: (body.vehicleRef ?? undefined),
                plannedDepartureAt: (body.plannedDepartureAt ?? undefined),
                plannedArrivalAt: (body.plannedArrivalAt ?? undefined),
                actualDepartureAt: (body.actualDepartureAt ?? undefined),
                actualArrivalAt: (body.actualArrivalAt ?? undefined),
                notes: (body.notes ?? undefined),
                metadata: body.metadata,
            }, actor);
            await emitMutationInvalidation({ reason: "order_mutation", request, entityId: orderId });
            return reply.send({ leg });
        }
        catch (err) {
            return sendError(reply, err, "Failed");
        }
    });
    fastify.put("/:id/legs/:legId", { preHandler: (0, authFastify_1.fastifyAuth)({ permission: "orders.write" }) }, async (request, reply) => {
        try {
            const actor = (0, __1.requireOrderActor)(request.user);
            const orderId = String(request.params?.id ?? "").trim();
            await ensureOrderInScope(request, orderId);
            const body = (request.body ?? {});
            const leg = await (0, orders_legs_1.upsertOrderLeg)(orderId, {
                legId: String(request.params?.legId ?? "").trim() || null,
                sequence: parseNumber(body.sequence, "sequence"),
                mode: asEnumValue(body.mode, Object.values(client_1.TransportMode), "mode"),
                status: asEnumValue(body.status, Object.values(client_1.OrderLegStatus), "status"),
                fromCountry: (body.fromCountry ?? undefined),
                toCountry: (body.toCountry ?? undefined),
                transitRoute: body.transitRoute,
                fromWarehouseId: (body.fromWarehouseId ?? undefined),
                toWarehouseId: (body.toWarehouseId ?? undefined),
                carrierCode: (body.carrierCode ?? undefined),
                carrierRef: (body.carrierRef ?? undefined),
                vehicleRef: (body.vehicleRef ?? undefined),
                plannedDepartureAt: (body.plannedDepartureAt ?? undefined),
                plannedArrivalAt: (body.plannedArrivalAt ?? undefined),
                actualDepartureAt: (body.actualDepartureAt ?? undefined),
                actualArrivalAt: (body.actualArrivalAt ?? undefined),
                notes: (body.notes ?? undefined),
                metadata: body.metadata,
            }, actor);
            await emitMutationInvalidation({ reason: "order_mutation", request, entityId: orderId });
            return reply.send({ leg });
        }
        catch (err) {
            return sendError(reply, err, "Failed");
        }
    });
    fastify.get("/:id/pricing-components", { preHandler: (0, authFastify_1.fastifyAuth)({ permission: "orders.read" }) }, async (request, reply) => {
        try {
            const orderId = String(request.params?.id ?? "").trim();
            await ensureOrderInScope(request, orderId);
            const items = await (0, orders_legs_1.listPricingComponents)(orderId);
            return reply.send({ items });
        }
        catch (err) {
            return sendError(reply, err, "Failed");
        }
    });
    fastify.post("/:id/pricing-components", { preHandler: (0, authFastify_1.fastifyAuth)({ permission: "orders.write" }) }, async (request, reply) => {
        try {
            const actor = (0, __1.requireOrderActor)(request.user);
            const orderId = String(request.params?.id ?? "").trim();
            await ensureOrderInScope(request, orderId);
            const body = (request.body ?? {});
            const item = await (0, orders_legs_1.createPricingComponent)(orderId, {
                orderLegId: (body.orderLegId ?? undefined),
                componentType: asEnumValue(body.componentType, Object.values(client_1.PricingComponentType), "componentType"),
                source: asEnumValue(body.source, Object.values(client_1.PricingComponentSource), "source"),
                description: (body.description ?? undefined),
                amount: parseNumber(body.amount, "amount", true),
                currency: String(body.currency ?? "").trim(),
                fxRateSnapshot: parseNumber(body.fxRateSnapshot, "fxRateSnapshot"),
                baseCurrency: body.baseCurrency != null ? String(body.baseCurrency).trim() : undefined,
                baseAmount: parseNumber(body.baseAmount, "baseAmount"),
                referenceKey: (body.referenceKey ?? undefined),
            }, actor);
            await emitMutationInvalidation({ reason: "order_mutation", request, entityId: orderId });
            return reply.code(201).send({ item });
        }
        catch (err) {
            return sendError(reply, err, "Failed");
        }
    });
    fastify.get("/:id/documents", { preHandler: (0, authFastify_1.fastifyAuth)({ permission: "orders.read" }) }, async (request, reply) => {
        try {
            const orderId = String(request.params?.id ?? "").trim();
            await ensureOrderInScope(request, orderId);
            const query = (request.query ?? {});
            const type = asEnumValue(query.type, Object.values(client_1.OrderDocumentType), "type");
            const limit = parseNumber(query.limit, "limit");
            const items = await (0, orders_legs_1.listOrderDocuments)(orderId, {
                type: type ?? null,
                limit: limit ?? undefined,
            });
            return reply.send({ items });
        }
        catch (err) {
            return sendError(reply, err, "Failed");
        }
    });
    fastify.get("/:id/proofs", { preHandler: (0, authFastify_1.fastifyAuth)({ permission: "orders.read" }) }, async (request, reply) => {
        try {
            const user = request.user;
            const result = await (0, __1.listOrderProofLinksForActor)({
                user,
                orderId: String(request.params?.id ?? "").trim(),
                query: (request.query ?? {}),
            });
            return reply.send(result);
        }
        catch (err) {
            return sendError(reply, err, "Failed");
        }
    });
    fastify.post("/:id/proofs", { preHandler: (0, authFastify_1.fastifyAuth)({ permission: "orders.write" }) }, async (request, reply) => handleProofSubmit(request, reply));
    fastify.post("/:id/delivery-proof", { preHandler: (0, authFastify_1.fastifyAuth)({ permission: "orders.write" }) }, async (request, reply) => handleProofSubmit(request, reply, "delivery"));
    fastify.post("/cash/collect-bulk", { preHandler: (0, authFastify_1.fastifyAuth)({ permission: "orders.write" }) }, async (request, reply) => {
        try {
            const actor = (0, __1.requireOrderActor)(request.user);
            const result = await (0, __1.collectCashBulkForActor)({ actor, body: (request.body ?? {}) });
            await emitMutationInvalidation({ reason: "cash_mutation", request });
            return reply.code(result.statusCode).send(result.payload);
        }
        catch (err) {
            return sendError(reply, err, "Failed to collect cash in bulk");
        }
    });
    fastify.post("/cash/handoff-bulk", { preHandler: (0, authFastify_1.fastifyAuth)({ permission: "orders.write" }) }, async (request, reply) => {
        try {
            const actor = (0, __1.requireOrderActor)(request.user);
            const result = await (0, __1.handoffCashBulkForActor)({ actor, body: (request.body ?? {}) });
            await emitMutationInvalidation({ reason: "cash_mutation", request });
            return reply.code(result.statusCode).send(result.payload);
        }
        catch (err) {
            return sendError(reply, err, "Failed to hand off cash in bulk");
        }
    });
    fastify.post("/cash/settle-bulk", { preHandler: (0, authFastify_1.fastifyAuth)({ permission: "orders.write" }) }, async (request, reply) => {
        try {
            const actor = (0, __1.requireOrderActor)(request.user);
            const result = await (0, __1.settleCashBulkForActor)({ actor, body: (request.body ?? {}) });
            await emitMutationInvalidation({ reason: "cash_mutation", request });
            return reply.code(result.statusCode).send(result.payload);
        }
        catch (err) {
            return sendError(reply, err, "Failed to settle cash in bulk");
        }
    });
    fastify.get("/cash/queue", { preHandler: (0, authFastify_1.fastifyAuth)({ permission: "orders.read" }) }, async (request, reply) => {
        try {
            const actor = (0, __1.requireOrderActor)(request.user);
            const data = await (0, __1.listCashQueueForActorView)({
                actor,
                query: (request.query ?? {}),
            });
            return reply.send(data);
        }
        catch (err) {
            return sendError(reply, err, "Failed to load cash queue");
        }
    });
    fastify.get("/cash/queue-summary", { preHandler: (0, authFastify_1.fastifyAuth)({ permission: "orders.read" }) }, async (request, reply) => {
        try {
            const actor = (0, __1.requireOrderActor)(request.user);
            const summary = await (0, __1.getCashQueueSummaryForActorView)({
                actor,
                query: (request.query ?? {}),
            });
            return reply.send(summary);
        }
        catch (err) {
            return sendError(reply, err, "Failed to load cash queue summary");
        }
    });
    fastify.post("/:id/cash/collect", { preHandler: (0, authFastify_1.fastifyAuth)({ permission: "orders.write" }) }, async (request, reply) => {
        try {
            const actor = (0, __1.requireOrderActor)(request.user);
            const result = await (0, __1.collectCashForActor)({
                actor,
                orderId: String(request.params?.id ?? "").trim(),
                body: (request.body ?? {}),
            });
            await emitMutationInvalidation({ reason: "cash_mutation", request });
            return reply.send(result);
        }
        catch (err) {
            return sendError(reply, err, "Failed to collect cash");
        }
    });
    fastify.post("/:id/cash/handoff", { preHandler: (0, authFastify_1.fastifyAuth)({ permission: "orders.write" }) }, async (request, reply) => {
        try {
            const actor = (0, __1.requireOrderActor)(request.user);
            const result = await (0, __1.handoffCashForActor)({
                actor,
                orderId: String(request.params?.id ?? "").trim(),
                body: (request.body ?? {}),
            });
            await emitMutationInvalidation({ reason: "cash_mutation", request });
            return reply.send(result);
        }
        catch (err) {
            return sendError(reply, err, "Failed to hand off cash");
        }
    });
    fastify.post("/:id/cash/settle", { preHandler: (0, authFastify_1.fastifyAuth)({ permission: "orders.write" }) }, async (request, reply) => {
        try {
            const actor = (0, __1.requireOrderActor)(request.user);
            const result = await (0, __1.settleCashForActor)({
                actor,
                orderId: String(request.params?.id ?? "").trim(),
                body: (request.body ?? {}),
            });
            await emitMutationInvalidation({ reason: "cash_mutation", request });
            return reply.send(result);
        }
        catch (err) {
            return sendError(reply, err, "Failed to settle cash");
        }
    });
    fastify.get("/:id", { preHandler: (0, authFastify_1.fastifyAuth)({ permission: "orders.read" }) }, async (request, reply) => {
        try {
            const actor = request.user;
            const orderId = String(request.params?.id ?? "").trim();
            const result = await (0, __1.getOrderForActor)({ actor, orderId });
            if (result.status === 200)
                return reply.send(result.order);
            if (result.status === 404)
                return reply.code(404).send({ error: "Not found" });
            return reply.code(403).send({ error: "Forbidden" });
        }
        catch (err) {
            return sendError(reply, err, "Failed to fetch order");
        }
    });
};
exports.default = ordersFastifyRoutes;
