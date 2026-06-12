"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.initRealtimeHub = initRealtimeHub;
exports.emitDriverNotification = emitDriverNotification;
exports.emitDriverOrderUpdate = emitDriverOrderUpdate;
exports.emitDriverUnreadCount = emitDriverUnreadCount;
const crypto_1 = require("crypto");
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const socket_io_1 = require("socket.io");
const prismaClient_1 = __importDefault(require("../../config/prismaClient"));
const notificationService_1 = require("../../modules/notifications-core/application/notificationService");
let io = null;
function deriveProfileType(args) {
    const roleCodes = new Set(args.roleCodes.map((value) => value.toLowerCase()).filter(Boolean));
    const permissionCodes = new Set(args.permissionCodes.filter(Boolean));
    if (permissionCodes.has("drivers.telemetry") || Array.from(roleCodes).some((c) => c.includes("driver"))) {
        return "driver";
    }
    if (args.warehouseId ||
        permissionCodes.has("warehouses.read") ||
        Array.from(roleCodes).some((c) => c.includes("warehouse") || c.includes("pvz") || c.includes("branch"))) {
        return "warehouse";
    }
    if (args.customerEntityId ||
        permissionCodes.has("payments.intents.read") ||
        Array.from(roleCodes).some((c) => c.includes("customer") || c.includes("client"))) {
        return "customer";
    }
    return "manager";
}
function toAllowedOriginMatcher(origins) {
    const cleaned = origins
        .map((value) => String(value || "").trim())
        .filter(Boolean);
    return (origin, callback) => {
        if (!origin)
            return callback(null, true);
        if (cleaned.length === 0)
            return callback(null, true);
        if (cleaned.includes(origin))
            return callback(null, true);
        return callback(new Error("Origin not allowed by Socket.IO CORS"));
    };
}
function parseSocketToken(socket) {
    const fromAuth = String(socket.handshake.auth?.token ?? "").trim();
    if (fromAuth)
        return fromAuth;
    const header = String(socket.handshake.headers.authorization ?? "").trim();
    if (header.toLowerCase().startsWith("bearer ")) {
        return header.slice(7).trim();
    }
    return "";
}
function userRoom(userId) {
    return `user:${userId}`;
}
function initRealtimeHub(server, corsOrigins) {
    if (io)
        return io;
    io = new socket_io_1.Server(server, {
        cors: {
            origin: toAllowedOriginMatcher(corsOrigins),
            credentials: true,
            methods: ["GET", "POST"],
        },
        transports: ["websocket", "polling"],
    });
    io.use(async (socket, next) => {
        try {
            const token = parseSocketToken(socket);
            if (!token)
                return next(new Error("Unauthorized"));
            const secret = process.env.JWT_SECRET;
            if (!secret)
                return next(new Error("JWT_SECRET not configured"));
            const decoded = jsonwebtoken_1.default.verify(token, secret);
            if (decoded?.tokenType && decoded.tokenType !== "access") {
                return next(new Error("Unauthorized"));
            }
            const user = await prismaClient_1.default.user.findUnique({
                where: { id: decoded.id },
                select: {
                    id: true,
                    warehouseId: true,
                    customerEntityId: true,
                    memberships: {
                        where: { status: "active" },
                        select: {
                            roles: {
                                select: {
                                    role: {
                                        select: {
                                            code: true,
                                            rolePermissions: {
                                                select: {
                                                    permission: {
                                                        select: { key: true },
                                                    },
                                                },
                                            },
                                        },
                                    },
                                },
                            },
                        },
                    },
                },
            });
            if (!user)
                return next(new Error("Unauthorized"));
            const roleCodes = user.memberships.flatMap((membership) => membership.roles.map((binding) => binding.role.code));
            const permissionCodes = user.memberships.flatMap((membership) => membership.roles.flatMap((binding) => binding.role.rolePermissions.map((rp) => rp.permission.key)));
            const audience = deriveProfileType({
                warehouseId: user.warehouseId ?? null,
                customerEntityId: user.customerEntityId ?? null,
                roleCodes,
                permissionCodes,
            });
            const authSocket = socket;
            authSocket.data.user = {
                id: user.id,
                audience,
                warehouseId: user.warehouseId ?? null,
            };
            return next();
        }
        catch {
            return next(new Error("Unauthorized"));
        }
    });
    io.on("connection", (socket) => {
        const authSocket = socket;
        const user = authSocket.data.user;
        if (!user) {
            socket.disconnect(true);
            return;
        }
        socket.join(userRoom(user.id));
        socket.join(`role:${user.audience}`);
        if (user.warehouseId) {
            socket.join(`warehouse:${user.warehouseId}`);
        }
        socket.emit("driver:realtime:ready", {
            connectedAt: new Date().toISOString(),
            userId: user.id,
        });
    });
    return io;
}
function getIo() {
    return io;
}
async function emitDriverNotification(userId, payload) {
    const cleanUserId = String(userId ?? "").trim();
    if (!cleanUserId)
        return;
    const cleanTitle = String(payload.title ?? "").trim();
    const cleanBody = String(payload.body ?? "").trim();
    if (!cleanTitle || !cleanBody)
        return;
    const notificationType = payload.type === "order" || payload.type === "cash" || payload.type === "system"
        ? payload.type
        : "system";
    const created = await (0, notificationService_1.createUserNotification)({
        userId: cleanUserId,
        type: notificationType,
        title: cleanTitle,
        body: cleanBody,
        orderId: payload.orderId ?? null,
        data: null,
    });
    const event = {
        id: created.id || payload.id || (0, crypto_1.randomUUID)(),
        type: notificationType,
        title: created.title,
        body: created.body,
        at: created.createdAt.toISOString(),
        orderId: created.orderId ?? payload.orderId ?? null,
    };
    const server = getIo();
    if (!server)
        return;
    server.to(userRoom(userId)).emit("driver:notification", event);
    const unreadCount = await (0, notificationService_1.countUnreadUserNotifications)(cleanUserId);
    server.to(userRoom(userId)).emit("driver:notifications:unread-count", {
        unreadCount,
        at: new Date().toISOString(),
    });
}
function emitDriverOrderUpdate(userId, payload) {
    const server = getIo();
    if (!server || !userId)
        return;
    server.to(userRoom(userId)).emit("driver:order-updated", payload);
}
async function emitDriverUnreadCount(userId) {
    const server = getIo();
    if (!server || !userId)
        return;
    const unreadCount = await (0, notificationService_1.countUnreadUserNotifications)(userId);
    server.to(userRoom(userId)).emit("driver:notifications:unread-count", {
        unreadCount,
        at: new Date().toISOString(),
    });
}
