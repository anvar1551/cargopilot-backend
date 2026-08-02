"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const client_1 = require("@prisma/client");
const v4_1 = require("zod/v4");
const prismaClient_1 = __importDefault(require("../../../config/prismaClient"));
const fastify_auth_1 = require("../../../modules/identity-access/transport/fastify-auth");
const identity_access_1 = require("../../identity-access");
const supportService_1 = require("../application/supportService");
const supportRealtime_1 = require("../realtime/supportRealtime");
const opsMetrics_1 = require("../../../modules/observability-core/application/opsMetrics");
const sseHeaders_1 = require("../../../shared/http/sseHeaders");
function isWritableStream(stream) {
    return !stream.destroyed && stream.writable !== false;
}
function actorFromRequest(request) {
    return {
        id: request.user?.id || "",
        companyId: request.user?.companyId || null,
        permissionCodes: Array.isArray(request.user?.permissionCodes) ? request.user.permissionCodes : [],
        customerEntityId: request.user?.customerEntityId || null,
        name: request.user?.name,
        email: request.user?.email,
    };
}
function optionalEnumValue(enumObj, value) {
    const raw = String(value || "").trim();
    return Object.values(enumObj).includes(raw) ? raw : null;
}
function asEnumValue(enumObj, value, fallback) {
    const raw = String(value || "").trim();
    return Object.values(enumObj).includes(raw) ? raw : fallback;
}
function asOptionalString(value) {
    const raw = String(value ?? "").trim();
    return raw || undefined;
}
function asNullableString(value) {
    if (value === null)
        return null;
    const raw = String(value ?? "").trim();
    return raw || undefined;
}
function companyIdFromRequest(request) {
    const requestedCompanyId = asOptionalString(request.query?.companyId)
        || asOptionalString(request.body?.companyId)
        || request.user?.companyId
        || "";
    const actorCompanyId = String(request.user?.companyId || "").trim();
    const canOverride = Array.isArray(request.user?.permissionCodes)
        && request.user.permissionCodes.includes("policy.override");
    if (requestedCompanyId && requestedCompanyId !== actorCompanyId && !canOverride) {
        const err = new Error("Forbidden for this company");
        err.statusCode = 403;
        throw err;
    }
    return requestedCompanyId;
}
function hasRequestPermission(request, permission) {
    return Array.isArray(request.user?.permissionCodes)
        && request.user.permissionCodes.includes(permission);
}
async function assertSupportTicketInScope(request, ticketId) {
    const scopeWhere = (await (0, identity_access_1.buildSupportScopeWhere)(request.user)) ?? { id: "__no_access__" };
    const ticket = await prismaClient_1.default.supportTicket.findFirst({
        where: { AND: [{ id: ticketId }, scopeWhere] },
        select: { id: true },
    });
    if (!ticket) {
        const err = new Error("Support ticket not found");
        err.statusCode = 404;
        throw err;
    }
}
async function assertOrderReferenceInScope(request, reference) {
    const orderId = String(reference.orderId || "").trim();
    const orderNumber = String(reference.orderNumber || "").trim().replace(/^#/, "");
    if (!orderId && !orderNumber)
        return;
    const scopeWhere = (await (0, identity_access_1.buildOrderScopeWhere)(request.user)) ?? { id: "__no_access__" };
    const order = await prismaClient_1.default.order.findFirst({
        where: {
            AND: [orderId ? { id: orderId } : { orderNumber }, scopeWhere],
        },
        select: { id: true },
    });
    if (!order) {
        const err = new Error("Order not found");
        err.statusCode = 404;
        throw err;
    }
}
async function assertQueueInCompany(request, queueId) {
    const canOverride = hasRequestPermission(request, "policy.override");
    const companyId = String(request.user?.companyId || "").trim();
    const queue = await prismaClient_1.default.supportQueue.findFirst({
        where: {
            id: queueId,
            ...(canOverride ? {} : { companyId }),
        },
        select: { id: true },
    });
    if (!queue) {
        const err = new Error("Support queue not found");
        err.statusCode = 404;
        throw err;
    }
}
async function assertAssignmentRuleInCompany(request, ruleId) {
    const canOverride = hasRequestPermission(request, "policy.override");
    const companyId = String(request.user?.companyId || "").trim();
    const rule = await prismaClient_1.default.supportAssignmentRule.findFirst({
        where: {
            id: ruleId,
            ...(canOverride ? {} : { companyId }),
        },
        select: { id: true },
    });
    if (!rule) {
        const err = new Error("Support assignment rule not found");
        err.statusCode = 404;
        throw err;
    }
}
async function assertEligibleSupportOwner(request, ownerId) {
    if (!ownerId)
        return;
    const assignees = await (0, supportService_1.listSupportAssignees)(actorFromRequest(request));
    if (assignees.some((assignee) => assignee.id === ownerId))
        return;
    const err = new Error("Selected user is not an active support operator for this company");
    err.statusCode = 400;
    throw err;
}
function sendError(reply, err, fallbackMessage) {
    return reply
        .code(err?.statusCode ?? 500)
        .send({ error: err?.message ?? fallbackMessage });
}
const idParamsSchema = v4_1.z.object({
    id: v4_1.z.string().trim().min(1),
});
const optionalNullableStringSchema = v4_1.z.union([v4_1.z.string().trim(), v4_1.z.null()]).optional();
const supportQueueCreateBodySchema = v4_1.z.object({
    companyId: v4_1.z.string().trim().min(1).optional(),
    code: optionalNullableStringSchema,
    name: v4_1.z.string().trim().min(1),
    description: optionalNullableStringSchema,
    defaultOrgId: optionalNullableStringSchema,
    defaultOwnerId: optionalNullableStringSchema,
    isDefault: v4_1.z.boolean().optional(),
    isActive: v4_1.z.boolean().optional(),
});
const supportQueuePatchBodySchema = supportQueueCreateBodySchema.partial().refine((value) => Object.keys(value).length > 0, "At least one queue field is required");
const supportAssignmentRuleCreateBodySchema = v4_1.z.object({
    companyId: v4_1.z.string().trim().min(1).optional(),
    queueId: optionalNullableStringSchema,
    name: v4_1.z.string().trim().min(1),
    code: optionalNullableStringSchema,
    source: v4_1.z.string().trim().optional().nullable(),
    priority: v4_1.z.string().trim().optional().nullable(),
    routeContains: optionalNullableStringSchema,
    defaultOwnerId: optionalNullableStringSchema,
    conditionsJson: v4_1.z.record(v4_1.z.string(), v4_1.z.unknown()).nullable().optional(),
    sortOrder: v4_1.z.coerce.number().int().optional(),
    isActive: v4_1.z.boolean().optional(),
});
const supportAssignmentRulePatchBodySchema = supportAssignmentRuleCreateBodySchema
    .partial()
    .refine((value) => Object.keys(value).length > 0, "At least one assignment rule field is required");
const supportFastifyRoutes = async (fastify) => {
    fastify.get("/stream", { preHandler: (0, fastify_auth_1.fastifyAuth)({ permission: "support.view" }) }, async (request, reply) => {
        (0, sseHeaders_1.applySseHeaders)(request, reply);
        reply.raw.flushHeaders?.();
        const clientKey = `${request.user?.id || "anon"}:${request.ip || "ip"}`;
        const lastEventId = String(request.headers["last-event-id"] || request.headers["Last-Event-ID"] || "").trim();
        let disconnected = false;
        (0, opsMetrics_1.recordSseConnected)({ stream: "support", clientKey });
        let closed = false;
        const send = (event, payload, id) => {
            if (closed || !isWritableStream(reply.raw))
                return false;
            try {
                if (id)
                    reply.raw.write(`id: ${id}\n`);
                reply.raw.write(`event: ${event}\n`);
                reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`);
                return true;
            }
            catch {
                return false;
            }
        };
        if (!send("ready", {
            connectedAt: new Date().toISOString(),
            resumedFrom: lastEventId || null,
        })) {
            if (!disconnected) {
                disconnected = true;
                (0, opsMetrics_1.recordSseDisconnected)("support");
            }
            return reply.hijack();
        }
        const redisReplayEvents = await (0, supportRealtime_1.replaySupportRefreshFromRedis)({
            lastEventId,
            limit: Number(process.env.SUPPORT_STREAM_REPLAY_MAX_EVENTS || 200),
        });
        const replayEvents = redisReplayEvents.length
            ? redisReplayEvents
            : (0, supportRealtime_1.replaySupportRefreshSince)(lastEventId);
        const replayLimit = Math.max(10, Number(process.env.SUPPORT_STREAM_REPLAY_MAX_EVENTS || 200));
        const replaySlice = replayEvents.slice(-replayLimit);
        replaySlice.forEach((event) => {
            send("support-refresh", event, event.id);
        });
        if (replayEvents.length > replaySlice.length) {
            send("support-replay-truncated", {
                skipped: replayEvents.length - replaySlice.length,
                delivered: replaySlice.length,
            });
        }
        const heartbeat = setInterval(() => {
            if (closed || !isWritableStream(reply.raw))
                return;
            try {
                reply.raw.write(`: ping ${Date.now()}\n\n`);
            }
            catch {
                closed = true;
            }
        }, Math.max(10000, Number(process.env.SUPPORT_STREAM_HEARTBEAT_MS || 25000)));
        const unsubscribe = (0, supportRealtime_1.subscribeSupportRefresh)((event) => {
            const sent = send("support-refresh", event, event.id);
            if (!sent)
                closed = true;
        });
        const onClose = () => {
            if (disconnected)
                return;
            disconnected = true;
            closed = true;
            (0, opsMetrics_1.recordSseDisconnected)("support");
            clearInterval(heartbeat);
            unsubscribe();
        };
        request.raw.on("close", onClose);
        reply.raw.on("close", onClose);
        reply.raw.on("error", onClose);
        return reply.hijack();
    });
    fastify.get("/assignees", { preHandler: (0, fastify_auth_1.fastifyAuth)({ permission: "support.view" }) }, async (request, reply) => {
        try {
            const assignees = await (0, supportService_1.listSupportAssignees)(actorFromRequest(request));
            return reply.send({ items: assignees });
        }
        catch (err) {
            return sendError(reply, err, "Failed to load support assignees");
        }
    });
    fastify.get("/summary", { preHandler: (0, fastify_auth_1.fastifyAuth)({ permission: "support.view" }) }, async (request, reply) => {
        try {
            const scopeWhere = await (0, identity_access_1.buildSupportScopeWhere)(request.user);
            const summary = await (0, supportService_1.getSupportSummary)({
                includeArchived: request.query?.includeArchived === "true",
                actor: actorFromRequest(request),
                scopeWhere,
            });
            return reply.send(summary);
        }
        catch (err) {
            return sendError(reply, err, "Failed to load support summary");
        }
    });
    fastify.get("/queues", { preHandler: (0, fastify_auth_1.fastifyAuth)({ permission: "support.configure" }) }, async (request, reply) => {
        try {
            const items = await (0, supportService_1.listSupportQueues)(companyIdFromRequest(request));
            return reply.send({ items });
        }
        catch (err) {
            return sendError(reply, err, "Failed to load support queues");
        }
    });
    fastify.post("/queues", {
        preHandler: (0, fastify_auth_1.fastifyAuth)({ permission: "support.configure" }),
        schema: { body: supportQueueCreateBodySchema },
    }, async (request, reply) => {
        try {
            const body = (request.body ?? {});
            const defaultOwnerId = asNullableString(body.defaultOwnerId) ?? null;
            await assertEligibleSupportOwner(request, defaultOwnerId);
            const queue = await (0, supportService_1.createSupportQueue)({
                companyId: companyIdFromRequest(request),
                code: asNullableString(body.code) ?? null,
                name: String(body.name || "").trim(),
                description: asNullableString(body.description) ?? null,
                defaultOrgId: asNullableString(body.defaultOrgId) ?? null,
                defaultOwnerId,
                isDefault: Boolean(body.isDefault),
                isActive: body.isActive !== false,
            });
            return reply.code(201).send(queue);
        }
        catch (err) {
            return sendError(reply, err, "Failed to create support queue");
        }
    });
    fastify.patch("/queues/:id", {
        preHandler: (0, fastify_auth_1.fastifyAuth)({ permission: "support.configure" }),
        schema: { params: idParamsSchema, body: supportQueuePatchBodySchema },
    }, async (request, reply) => {
        try {
            const queueId = String(request.params?.id || "");
            await assertQueueInCompany(request, queueId);
            const body = (request.body ?? {});
            const defaultOwnerId = body.defaultOwnerId === undefined
                ? undefined
                : asNullableString(body.defaultOwnerId) ?? null;
            await assertEligibleSupportOwner(request, defaultOwnerId);
            const queue = await (0, supportService_1.updateSupportQueue)(queueId, {
                code: body.code === undefined ? undefined : asNullableString(body.code) ?? null,
                name: body.name === undefined ? undefined : String(body.name || "").trim(),
                description: body.description === undefined ? undefined : asNullableString(body.description) ?? null,
                defaultOrgId: body.defaultOrgId === undefined ? undefined : asNullableString(body.defaultOrgId) ?? null,
                defaultOwnerId,
                isDefault: body.isDefault === undefined ? undefined : Boolean(body.isDefault),
                isActive: body.isActive === undefined ? undefined : Boolean(body.isActive),
            });
            return reply.send(queue);
        }
        catch (err) {
            return sendError(reply, err, "Failed to update support queue");
        }
    });
    fastify.delete("/queues/:id", {
        preHandler: (0, fastify_auth_1.fastifyAuth)({ permission: "support.configure" }),
        schema: { params: idParamsSchema },
    }, async (request, reply) => {
        try {
            const queueId = String(request.params?.id || "");
            await assertQueueInCompany(request, queueId);
            const result = await (0, supportService_1.deleteSupportQueue)(queueId);
            return reply.send(result);
        }
        catch (err) {
            return sendError(reply, err, "Failed to delete support queue");
        }
    });
    fastify.get("/assignment-rules", { preHandler: (0, fastify_auth_1.fastifyAuth)({ permission: "support.configure" }) }, async (request, reply) => {
        try {
            const items = await (0, supportService_1.listSupportAssignmentRules)(companyIdFromRequest(request));
            return reply.send({ items });
        }
        catch (err) {
            return sendError(reply, err, "Failed to load support assignment rules");
        }
    });
    fastify.post("/assignment-rules", {
        preHandler: (0, fastify_auth_1.fastifyAuth)({ permission: "support.configure" }),
        schema: { body: supportAssignmentRuleCreateBodySchema },
    }, async (request, reply) => {
        try {
            const body = (request.body ?? {});
            const queueId = asNullableString(body.queueId) ?? null;
            if (queueId)
                await assertQueueInCompany(request, queueId);
            const defaultOwnerId = asNullableString(body.defaultOwnerId) ?? null;
            await assertEligibleSupportOwner(request, defaultOwnerId);
            const rule = await (0, supportService_1.createSupportAssignmentRule)({
                companyId: companyIdFromRequest(request),
                queueId,
                name: String(body.name || "").trim(),
                code: asNullableString(body.code) ?? null,
                source: optionalEnumValue(client_1.SupportTicketSource, body.source),
                priority: optionalEnumValue(client_1.SupportTicketPriority, body.priority),
                routeContains: asNullableString(body.routeContains) ?? null,
                defaultOwnerId,
                conditionsJson: typeof body.conditionsJson === "object" && body.conditionsJson !== null
                    ? body.conditionsJson
                    : null,
                sortOrder: Number(body.sortOrder),
                isActive: body.isActive !== false,
            });
            return reply.code(201).send(rule);
        }
        catch (err) {
            return sendError(reply, err, "Failed to create support assignment rule");
        }
    });
    fastify.patch("/assignment-rules/:id", {
        preHandler: (0, fastify_auth_1.fastifyAuth)({ permission: "support.configure" }),
        schema: {
            params: idParamsSchema,
            body: supportAssignmentRulePatchBodySchema,
        },
    }, async (request, reply) => {
        try {
            const ruleId = String(request.params?.id || "");
            await assertAssignmentRuleInCompany(request, ruleId);
            const body = (request.body ?? {});
            const queueId = body.queueId === undefined ? undefined : asNullableString(body.queueId) ?? null;
            if (queueId)
                await assertQueueInCompany(request, queueId);
            const defaultOwnerId = body.defaultOwnerId === undefined
                ? undefined
                : asNullableString(body.defaultOwnerId) ?? null;
            await assertEligibleSupportOwner(request, defaultOwnerId);
            const rule = await (0, supportService_1.updateSupportAssignmentRule)(ruleId, {
                queueId,
                name: body.name === undefined ? undefined : String(body.name || "").trim(),
                code: body.code === undefined ? undefined : asNullableString(body.code) ?? null,
                source: body.source === undefined ? undefined : optionalEnumValue(client_1.SupportTicketSource, body.source),
                priority: body.priority === undefined ? undefined : optionalEnumValue(client_1.SupportTicketPriority, body.priority),
                routeContains: body.routeContains === undefined ? undefined : asNullableString(body.routeContains) ?? null,
                defaultOwnerId,
                conditionsJson: body.conditionsJson === undefined
                    ? undefined
                    : typeof body.conditionsJson === "object" && body.conditionsJson !== null
                        ? body.conditionsJson
                        : null,
                sortOrder: body.sortOrder === undefined ? undefined : Number(body.sortOrder),
                isActive: body.isActive === undefined ? undefined : Boolean(body.isActive),
            });
            return reply.send(rule);
        }
        catch (err) {
            return sendError(reply, err, "Failed to update support assignment rule");
        }
    });
    fastify.delete("/assignment-rules/:id", {
        preHandler: (0, fastify_auth_1.fastifyAuth)({ permission: "support.configure" }),
        schema: { params: idParamsSchema },
    }, async (request, reply) => {
        try {
            const ruleId = String(request.params?.id || "");
            await assertAssignmentRuleInCompany(request, ruleId);
            const result = await (0, supportService_1.deleteSupportAssignmentRule)(ruleId);
            return reply.send(result);
        }
        catch (err) {
            return sendError(reply, err, "Failed to delete support assignment rule");
        }
    });
    fastify.get("/tickets", { preHandler: (0, fastify_auth_1.fastifyAuth)({ permission: "support.view" }) }, async (request, reply) => {
        const startedAt = Date.now();
        try {
            const scopeWhere = await (0, identity_access_1.buildSupportScopeWhere)(request.user);
            const limit = Number(request.query?.limit);
            const result = await (0, supportService_1.listSupportTickets)({
                status: asOptionalString(request.query?.status),
                priority: asOptionalString(request.query?.priority),
                source: asOptionalString(request.query?.source),
                owner: (asOptionalString(request.query?.owner) || "mine"),
                q: asOptionalString(request.query?.q),
                cursor: asOptionalString(request.query?.cursor),
                limit: Number.isFinite(limit) ? limit : undefined,
                includeArchived: String(request.query?.includeArchived || "") === "true",
                actor: actorFromRequest(request),
                scopeWhere,
            });
            reply.header("X-Support-Cache", result.cacheHit ? "HIT" : "MISS");
            reply.header("X-Support-Time-Ms", String(Date.now() - startedAt));
            return reply.send(result.payload);
        }
        catch (err) {
            return sendError(reply, err, "Failed to load support tickets");
        }
    });
    fastify.post("/tickets", { preHandler: (0, fastify_auth_1.fastifyAuth)({ permission: "support.createTicket" }) }, async (request, reply) => {
        try {
            const body = (request.body ?? {});
            const orderId = asNullableString(body.orderId) ?? null;
            const orderNumber = asNullableString(body.orderNumber) ?? null;
            await assertOrderReferenceInScope(request, { orderId, orderNumber });
            const ticket = await (0, supportService_1.createSupportTicket)({
                orderId,
                orderNumber,
                title: String(body.title || "").trim(),
                summary: asNullableString(body.summary) ?? null,
                priority: asEnumValue(client_1.SupportTicketPriority, body.priority, client_1.SupportTicketPriority.normal),
                source: client_1.SupportTicketSource.manager,
                status: client_1.SupportTicketStatus.open,
                ownerId: hasRequestPermission(request, "support.assign")
                    ? body.ownerId === null
                        ? null
                        : asOptionalString(body.ownerId)
                    : undefined,
                sourceKey: null,
                companyId: request.user?.companyId ?? null,
            }, actorFromRequest(request));
            return reply.code(201).send(ticket);
        }
        catch (err) {
            const status = String(err?.message || "").includes("required")
                ? 400
                : err?.statusCode ?? 500;
            return reply
                .code(status)
                .send({ error: err?.message || "Failed to create support ticket" });
        }
    });
    fastify.get("/tickets/:id", { preHandler: (0, fastify_auth_1.fastifyAuth)({ permission: "support.view" }) }, async (request, reply) => {
        const startedAt = Date.now();
        try {
            const scopeWhere = await (0, identity_access_1.buildSupportScopeWhere)(request.user);
            const id = String(request.params?.id || "").trim();
            const result = await (0, supportService_1.getSupportTicketScoped)({ id, scopeWhere });
            reply.header("X-Support-Cache", result.cacheHit ? "HIT" : "MISS");
            reply.header("X-Support-Time-Ms", String(Date.now() - startedAt));
            if (!result.payload) {
                return reply.code(404).send({ error: "Support ticket not found" });
            }
            return reply.send(result.payload);
        }
        catch (err) {
            return sendError(reply, err, "Failed to load support ticket");
        }
    });
    fastify.patch("/tickets/:id/status", { preHandler: (0, fastify_auth_1.fastifyAuth)({ permission: "support.update" }) }, async (request, reply) => {
        try {
            const ticketId = String(request.params?.id || "");
            const status = asEnumValue(client_1.SupportTicketStatus, request.body?.status, client_1.SupportTicketStatus.open);
            if (status === client_1.SupportTicketStatus.resolved && !hasRequestPermission(request, "support.resolve")) {
                return reply.code(403).send({ error: "Missing permission: support.resolve" });
            }
            if (status === client_1.SupportTicketStatus.escalated && !hasRequestPermission(request, "support.escalate")) {
                return reply.code(403).send({ error: "Missing permission: support.escalate" });
            }
            await assertSupportTicketInScope(request, ticketId);
            const ticket = await (0, supportService_1.updateSupportTicketStatus)(ticketId, status, actorFromRequest(request));
            return reply.send(ticket);
        }
        catch (err) {
            return sendError(reply, err, "Failed to update support ticket status");
        }
    });
    fastify.patch("/tickets/:id/assign", { preHandler: (0, fastify_auth_1.fastifyAuth)({ permission: "support.assign" }) }, async (request, reply) => {
        try {
            const ticketId = String(request.params?.id || "");
            await assertSupportTicketInScope(request, ticketId);
            const body = (request.body ?? {});
            const ownerId = body.ownerId === null
                ? null
                : asOptionalString(body.ownerId) || request.user?.id || null;
            const ticket = await (0, supportService_1.assignSupportTicket)(ticketId, ownerId, actorFromRequest(request));
            return reply.send(ticket);
        }
        catch (err) {
            return sendError(reply, err, "Failed to assign support ticket");
        }
    });
    fastify.post("/tickets/:id/notes", { preHandler: (0, fastify_auth_1.fastifyAuth)({ permission: "support.update" }) }, async (request, reply) => {
        try {
            const ticketId = String(request.params?.id || "");
            await assertSupportTicketInScope(request, ticketId);
            const ticket = await (0, supportService_1.addSupportTicketNote)(ticketId, String(request.body?.body || ""), actorFromRequest(request));
            return reply.code(201).send(ticket);
        }
        catch (err) {
            const status = String(err?.message || "").includes("required")
                ? 400
                : err?.statusCode ?? 500;
            return reply
                .code(status)
                .send({ error: err?.message || "Failed to add support note" });
        }
    });
    fastify.post("/tickets/:id/messages", { preHandler: (0, fastify_auth_1.fastifyAuth)({ permission: "support.update" }) }, async (request, reply) => {
        try {
            const ticketId = String(request.params?.id || "");
            await assertSupportTicketInScope(request, ticketId);
            const ticket = await (0, supportService_1.addSupportTicketMessage)(ticketId, String(request.body?.body || ""), actorFromRequest(request));
            return reply.code(201).send(ticket);
        }
        catch (err) {
            const status = String(err?.message || "").includes("required")
                ? 400
                : err?.statusCode ?? 500;
            return reply
                .code(status)
                .send({ error: err?.message || "Failed to add support message" });
        }
    });
    fastify.post("/tickets/:id/escalate", { preHandler: (0, fastify_auth_1.fastifyAuth)({ permission: "support.escalate" }) }, async (request, reply) => {
        try {
            const ticketId = String(request.params?.id || "");
            await assertSupportTicketInScope(request, ticketId);
            const ticket = await (0, supportService_1.updateSupportTicketStatus)(ticketId, client_1.SupportTicketStatus.escalated, actorFromRequest(request));
            return reply.send(ticket);
        }
        catch (err) {
            return sendError(reply, err, "Failed to escalate support ticket");
        }
    });
};
exports.default = supportFastifyRoutes;
