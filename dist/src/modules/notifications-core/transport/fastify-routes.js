"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const client_1 = require("@prisma/client");
const realtimeHub_1 = require("../../../features/realtime/realtimeHub");
const authFastify_1 = require("../../../middleware/authFastify");
const identity_access_1 = require("../../identity-access");
const shared_1 = require("../../orders-core/shared");
const notificationService_1 = require("../application/notificationService");
function parseType(value) {
    if (value === client_1.NotificationType.order)
        return client_1.NotificationType.order;
    if (value === client_1.NotificationType.cash)
        return client_1.NotificationType.cash;
    if (value === client_1.NotificationType.system)
        return client_1.NotificationType.system;
    return null;
}
function parseUnread(value) {
    if (value === true || value === "true" || value === "1" || value === 1)
        return true;
    if (value === false || value === "false" || value === "0" || value === 0)
        return false;
    return null;
}
async function ensureNotificationsAccess(user) {
    if (!user) {
        const err = new Error("Unauthorized");
        err.statusCode = 401;
        throw err;
    }
    const allowed = await (0, identity_access_1.hasPermission)(user, "drivers.telemetry");
    if (!allowed) {
        const err = new Error("Forbidden");
        err.statusCode = 403;
        throw err;
    }
}
const notificationsFastifyRoutes = async (fastify) => {
    fastify.get("/", { preHandler: (0, authFastify_1.fastifyAuth)() }, async (request, reply) => {
        try {
            await ensureNotificationsAccess(request.user);
            const actor = (0, shared_1.requireOrderActor)(request.user);
            const data = await (0, notificationService_1.listUserNotifications)(actor.id, {
                limit: request.query?.limit ? Number(request.query.limit) : undefined,
                cursor: typeof request.query?.cursor === "string" ? request.query.cursor : undefined,
                type: parseType(request.query?.type),
                unread: parseUnread(request.query?.unread),
            });
            return reply.send(data);
        }
        catch (err) {
            return reply.code(err?.statusCode ?? 400).send({
                error: err?.message ?? "Failed to list notifications",
            });
        }
    });
    fastify.get("/unread-count", { preHandler: (0, authFastify_1.fastifyAuth)() }, async (request, reply) => {
        try {
            await ensureNotificationsAccess(request.user);
            const actor = (0, shared_1.requireOrderActor)(request.user);
            const unreadCount = await (0, notificationService_1.countUnreadUserNotifications)(actor.id, parseType(request.query?.type));
            return reply.send({ unreadCount });
        }
        catch (err) {
            return reply.code(err?.statusCode ?? 400).send({
                error: err?.message ?? "Failed to get unread count",
            });
        }
    });
    fastify.post("/:id/read", { preHandler: (0, authFastify_1.fastifyAuth)() }, async (request, reply) => {
        try {
            await ensureNotificationsAccess(request.user);
            const actor = (0, shared_1.requireOrderActor)(request.user);
            const notificationId = String(request.params?.id ?? "").trim();
            if (!notificationId)
                return reply.code(400).send({ error: "Missing notification id" });
            const result = await (0, notificationService_1.markUserNotificationRead)(actor.id, notificationId);
            if (!result)
                return reply.code(404).send({ error: "Notification not found" });
            void (0, realtimeHub_1.emitDriverUnreadCount)(actor.id).catch(() => undefined);
            return reply.send({ success: true, id: result.id, readAt: result.readAt });
        }
        catch (err) {
            return reply.code(err?.statusCode ?? 400).send({
                error: err?.message ?? "Failed to mark notification as read",
            });
        }
    });
    fastify.post("/read-all", { preHandler: (0, authFastify_1.fastifyAuth)() }, async (request, reply) => {
        try {
            await ensureNotificationsAccess(request.user);
            const actor = (0, shared_1.requireOrderActor)(request.user);
            const type = parseType(request.body?.type ?? request.query?.type);
            const updatedCount = await (0, notificationService_1.markAllUserNotificationsRead)(actor.id, type);
            void (0, realtimeHub_1.emitDriverUnreadCount)(actor.id).catch(() => undefined);
            return reply.send({ success: true, updatedCount });
        }
        catch (err) {
            return reply.code(err?.statusCode ?? 400).send({
                error: err?.message ?? "Failed to mark all notifications as read",
            });
        }
    });
};
exports.default = notificationsFastifyRoutes;
