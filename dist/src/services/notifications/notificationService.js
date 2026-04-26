"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createUserNotification = createUserNotification;
exports.listUserNotifications = listUserNotifications;
exports.countUnreadUserNotifications = countUnreadUserNotifications;
exports.markUserNotificationRead = markUserNotificationRead;
exports.markAllUserNotificationsRead = markAllUserNotificationsRead;
exports.cleanupExpiredNotifications = cleanupExpiredNotifications;
const prismaClient_1 = __importDefault(require("../../config/prismaClient"));
const client_1 = require("@prisma/client");
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
function retentionDays() {
    const raw = Number(process.env.DRIVER_NOTIFICATIONS_RETENTION_DAYS ?? 30);
    if (!Number.isFinite(raw) || raw <= 0)
        return 30;
    return Math.floor(raw);
}
function retentionCutoff() {
    const days = retentionDays();
    const now = Date.now();
    return new Date(now - days * 24 * 60 * 60 * 1000);
}
function encodeCursor(input) {
    const raw = `${input.createdAt.toISOString()}|${input.id}`;
    return Buffer.from(raw, "utf8").toString("base64url");
}
function decodeCursor(cursor) {
    if (!cursor)
        return null;
    try {
        const decoded = Buffer.from(cursor, "base64url").toString("utf8");
        const [createdAtRaw, id] = decoded.split("|");
        if (!createdAtRaw || !id)
            return null;
        const createdAt = new Date(createdAtRaw);
        if (Number.isNaN(createdAt.getTime()))
            return null;
        return { createdAt, id };
    }
    catch {
        return null;
    }
}
function parseLimit(value) {
    const parsed = Number(value ?? DEFAULT_LIMIT);
    if (!Number.isFinite(parsed))
        return DEFAULT_LIMIT;
    return Math.min(Math.max(Math.floor(parsed), 1), MAX_LIMIT);
}
async function createUserNotification(input) {
    const userId = String(input.userId ?? "").trim();
    if (!userId)
        throw new Error("userId is required");
    const title = String(input.title ?? "").trim();
    const body = String(input.body ?? "").trim();
    if (!title || !body)
        throw new Error("title and body are required");
    return prismaClient_1.default.userNotification.create({
        data: {
            userId,
            type: input.type,
            title,
            body,
            orderId: input.orderId ?? null,
            data: input.data == null ? client_1.Prisma.JsonNull : input.data,
        },
    });
}
async function listUserNotifications(userId, params = {}) {
    const limit = parseLimit(params.limit);
    const cutoff = retentionCutoff();
    const cursor = decodeCursor(params.cursor);
    const whereBase = {
        userId,
        createdAt: {
            gte: cutoff,
        },
        ...(params.type ? { type: params.type } : {}),
        ...(params.unread === true
            ? { readAt: null }
            : params.unread === false
                ? { readAt: { not: null } }
                : {}),
    };
    const whereWithCursor = cursor
        ? {
            AND: [
                whereBase,
                {
                    OR: [
                        { createdAt: { lt: cursor.createdAt } },
                        {
                            AND: [{ createdAt: cursor.createdAt }, { id: { lt: cursor.id } }],
                        },
                    ],
                },
            ],
        }
        : whereBase;
    const rows = await prismaClient_1.default.userNotification.findMany({
        where: whereWithCursor,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: limit + 1,
    });
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const tail = items[items.length - 1];
    return {
        items: items.map((item) => ({
            id: item.id,
            type: item.type,
            title: item.title,
            body: item.body,
            at: item.createdAt.toISOString(),
            unread: !item.readAt,
            orderId: item.orderId,
        })),
        hasMore,
        nextCursor: hasMore && tail ? encodeCursor({ createdAt: tail.createdAt, id: tail.id }) : null,
        limit,
    };
}
async function countUnreadUserNotifications(userId, type) {
    const cutoff = retentionCutoff();
    const unreadCount = await prismaClient_1.default.userNotification.count({
        where: {
            userId,
            createdAt: { gte: cutoff },
            readAt: null,
            ...(type ? { type } : {}),
        },
    });
    return unreadCount;
}
async function markUserNotificationRead(userId, notificationId) {
    const found = await prismaClient_1.default.userNotification.findFirst({
        where: {
            id: notificationId,
            userId,
        },
        select: { id: true, readAt: true },
    });
    if (!found)
        return null;
    if (found.readAt)
        return found;
    return prismaClient_1.default.userNotification.update({
        where: { id: notificationId },
        data: { readAt: new Date() },
        select: { id: true, readAt: true },
    });
}
async function markAllUserNotificationsRead(userId, type) {
    const result = await prismaClient_1.default.userNotification.updateMany({
        where: {
            userId,
            readAt: null,
            createdAt: { gte: retentionCutoff() },
            ...(type ? { type } : {}),
        },
        data: {
            readAt: new Date(),
        },
    });
    return result.count;
}
async function cleanupExpiredNotifications() {
    const cutoff = retentionCutoff();
    return prismaClient_1.default.userNotification.deleteMany({
        where: {
            createdAt: { lt: cutoff },
        },
    });
}
