"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.listNotifications = listNotifications;
exports.getUnreadCount = getUnreadCount;
exports.markNotificationRead = markNotificationRead;
exports.markAllNotificationsRead = markAllNotificationsRead;
const client_1 = require("@prisma/client");
const realtimeHub_1 = require("../../features/realtime/realtimeHub");
const orderService_shared_1 = require("../orders/orderService.shared");
const notificationService_1 = require("./notificationService");
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
function assertDriverOrManager(role) {
    if (role === client_1.AppRole.driver || role === client_1.AppRole.manager)
        return;
    throw new Error("Forbidden");
}
/** Returns notifications with cursor pagination and optional type/unread filters. */
async function listNotifications(req, res) {
    try {
        const actor = (0, orderService_shared_1.requireOrderActor)(req.user);
        assertDriverOrManager(actor.role);
        const data = await (0, notificationService_1.listUserNotifications)(actor.id, {
            limit: req.query?.limit ? Number(req.query.limit) : undefined,
            cursor: typeof req.query?.cursor === "string" ? req.query.cursor : undefined,
            type: parseType(req.query?.type),
            unread: parseUnread(req.query?.unread),
        });
        return res.json(data);
    }
    catch (err) {
        return res.status(400).json({ error: err?.message ?? "Failed to list notifications" });
    }
}
/** Returns unread notification count (optionally filtered by type). */
async function getUnreadCount(req, res) {
    try {
        const actor = (0, orderService_shared_1.requireOrderActor)(req.user);
        assertDriverOrManager(actor.role);
        const unreadCount = await (0, notificationService_1.countUnreadUserNotifications)(actor.id, parseType(req.query?.type));
        return res.json({ unreadCount });
    }
    catch (err) {
        return res.status(400).json({ error: err?.message ?? "Failed to get unread count" });
    }
}
/** Marks one notification as read for current user. */
async function markNotificationRead(req, res) {
    try {
        const actor = (0, orderService_shared_1.requireOrderActor)(req.user);
        assertDriverOrManager(actor.role);
        const notificationId = String(req.params?.id ?? "").trim();
        if (!notificationId)
            return res.status(400).json({ error: "Missing notification id" });
        const result = await (0, notificationService_1.markUserNotificationRead)(actor.id, notificationId);
        if (!result)
            return res.status(404).json({ error: "Notification not found" });
        void (0, realtimeHub_1.emitDriverUnreadCount)(actor.id).catch(() => undefined);
        return res.json({ success: true, id: result.id, readAt: result.readAt });
    }
    catch (err) {
        return res.status(400).json({ error: err?.message ?? "Failed to mark notification as read" });
    }
}
/** Marks all matching notifications as read for current user. */
async function markAllNotificationsRead(req, res) {
    try {
        const actor = (0, orderService_shared_1.requireOrderActor)(req.user);
        assertDriverOrManager(actor.role);
        const type = parseType(req.body?.type ?? req.query?.type);
        const updatedCount = await (0, notificationService_1.markAllUserNotificationsRead)(actor.id, type);
        void (0, realtimeHub_1.emitDriverUnreadCount)(actor.id).catch(() => undefined);
        return res.json({ success: true, updatedCount });
    }
    catch (err) {
        return res.status(400).json({ error: err?.message ?? "Failed to mark all notifications as read" });
    }
}
