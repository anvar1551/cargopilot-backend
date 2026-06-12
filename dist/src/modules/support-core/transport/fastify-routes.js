"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const client_1 = require("@prisma/client");
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
        roleCodes: Array.isArray(request.user?.roleCodes) ? request.user.roleCodes : [],
        permissionCodes: Array.isArray(request.user?.permissionCodes) ? request.user.permissionCodes : [],
        name: request.user?.name,
        email: request.user?.email,
    };
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
function sendError(reply, err, fallbackMessage) {
    return reply
        .code(err?.statusCode ?? 500)
        .send({ error: err?.message ?? fallbackMessage });
}
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
    fastify.get("/assignees", { preHandler: (0, fastify_auth_1.fastifyAuth)({ permission: "support.view" }) }, async (_request, reply) => {
        try {
            const assignees = await (0, supportService_1.listSupportAssignees)();
            return reply.send({ items: assignees });
        }
        catch (err) {
            return sendError(reply, err, "Failed to load support assignees");
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
            const ticket = await (0, supportService_1.createSupportTicket)({
                orderId: asNullableString(body.orderId) ?? null,
                orderNumber: asNullableString(body.orderNumber) ?? null,
                title: String(body.title || "").trim(),
                summary: asNullableString(body.summary) ?? null,
                priority: asEnumValue(client_1.SupportTicketPriority, body.priority, client_1.SupportTicketPriority.normal),
                source: asEnumValue(client_1.SupportTicketSource, body.source, client_1.SupportTicketSource.manager),
                status: asEnumValue(client_1.SupportTicketStatus, body.status, client_1.SupportTicketStatus.open),
                ownerId: body.ownerId === null ? null : asOptionalString(body.ownerId),
                sourceKey: asNullableString(body.sourceKey) ?? null,
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
            const status = asEnumValue(client_1.SupportTicketStatus, request.body?.status, client_1.SupportTicketStatus.open);
            const ticket = await (0, supportService_1.updateSupportTicketStatus)(String(request.params?.id || ""), status, actorFromRequest(request));
            return reply.send(ticket);
        }
        catch (err) {
            return sendError(reply, err, "Failed to update support ticket status");
        }
    });
    fastify.patch("/tickets/:id/assign", { preHandler: (0, fastify_auth_1.fastifyAuth)({ permission: "support.assign" }) }, async (request, reply) => {
        try {
            const body = (request.body ?? {});
            const ownerId = body.ownerId === null
                ? null
                : asOptionalString(body.ownerId) || request.user?.id || null;
            const ticket = await (0, supportService_1.assignSupportTicket)(String(request.params?.id || ""), ownerId, actorFromRequest(request));
            return reply.send(ticket);
        }
        catch (err) {
            return sendError(reply, err, "Failed to assign support ticket");
        }
    });
    fastify.post("/tickets/:id/notes", { preHandler: (0, fastify_auth_1.fastifyAuth)({ permission: "support.update" }) }, async (request, reply) => {
        try {
            const ticket = await (0, supportService_1.addSupportTicketNote)(String(request.params?.id || ""), String(request.body?.body || ""), actorFromRequest(request));
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
            const ticket = await (0, supportService_1.addSupportTicketMessage)(String(request.params?.id || ""), String(request.body?.body || ""), actorFromRequest(request));
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
            const ticket = await (0, supportService_1.updateSupportTicketStatus)(String(request.params?.id || ""), client_1.SupportTicketStatus.escalated, actorFromRequest(request));
            return reply.send(ticket);
        }
        catch (err) {
            return sendError(reply, err, "Failed to escalate support ticket");
        }
    });
};
exports.default = supportFastifyRoutes;
