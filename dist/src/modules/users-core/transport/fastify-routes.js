"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const client_1 = require("@prisma/client");
const zod_1 = require("zod");
const authFastify_1 = require("../../../middleware/authFastify");
const identity_access_1 = require("../../identity-access");
const userRepo_1 = require("../application/userRepo");
function isDatabaseUnavailableError(err) {
    const code = String(err?.code ?? "").toUpperCase();
    const message = String(err?.message ?? "").toLowerCase();
    if (code === "ETIMEDOUT" ||
        code === "ECONNREFUSED" ||
        code === "EHOSTUNREACH" ||
        code === "ENETUNREACH" ||
        code === "P1001" ||
        code === "P1002") {
        return true;
    }
    return (message.includes("timed out") ||
        message.includes("can't reach database server") ||
        message.includes("cannot reach database server"));
}
function isMissingRefreshSessionTableError(err) {
    const code = String(err?.code ?? "").toUpperCase();
    const message = String(err?.message ?? "").toLowerCase();
    if (code === "P2021")
        return true;
    return (message.includes("userrefreshsession") &&
        (message.includes("does not exist") || message.includes("table")));
}
function extractClientIp(request) {
    const forwarded = request.headers?.["x-forwarded-for"];
    if (typeof forwarded === "string" && forwarded.trim()) {
        return forwarded.split(",")[0]?.trim() || null;
    }
    if (Array.isArray(forwarded) && forwarded.length > 0) {
        return String(forwarded[0] ?? "").trim() || null;
    }
    return typeof request.ip === "string" ? request.ip : null;
}
const refreshSchema = zod_1.z.object({
    refreshToken: zod_1.z.string().min(20, "Refresh token is required"),
});
const logoutSchema = zod_1.z.object({
    refreshToken: zod_1.z.string().min(20, "Refresh token is required"),
});
const changePasswordSchema = zod_1.z
    .object({
    currentPassword: zod_1.z.string().min(1, "Current password is required"),
    newPassword: zod_1.z.string().min(6, "New password must be at least 6 characters"),
})
    .superRefine((value, ctx) => {
    if (value.currentPassword === value.newPassword) {
        ctx.addIssue({
            code: "custom",
            path: ["newPassword"],
            message: "New password must be different from current password",
        });
    }
});
const createUserByManagerSchema = zod_1.z
    .object({
    name: zod_1.z.string().min(2),
    email: zod_1.z.string().email(),
    password: zod_1.z.string().min(6),
    role: zod_1.z.enum(identity_access_1.ACTOR_ROLES),
    driverType: zod_1.z.enum(["local", "linehaul"]).optional(),
    warehouseId: zod_1.z.uuid().optional().nullable(),
    customerEntityId: zod_1.z.uuid().optional().nullable(),
    phone: zod_1.z.string().optional().nullable(),
})
    .superRefine((v, ctx) => {
    const supportsWarehouse = v.role === identity_access_1.ROLE_WAREHOUSE || v.role === identity_access_1.ROLE_DRIVER;
    if (!supportsWarehouse && v.warehouseId) {
        ctx.addIssue({
            code: "custom",
            path: ["warehouseId"],
            message: "warehouseId is only allowed when role is WAREHOUSE or DRIVER",
        });
    }
    if (v.role === identity_access_1.ROLE_WAREHOUSE && !v.warehouseId) {
        ctx.addIssue({
            code: "custom",
            path: ["warehouseId"],
            message: "warehouseId is required when role is WAREHOUSE",
        });
    }
    if (v.role !== identity_access_1.ROLE_CUSTOMER && v.customerEntityId) {
        ctx.addIssue({
            code: "custom",
            path: ["customerEntityId"],
            message: "customerEntityId is only allowed when role is CUSTOMER",
        });
    }
    if (v.driverType && v.role !== identity_access_1.ROLE_DRIVER) {
        ctx.addIssue({
            code: "custom",
            path: ["driverType"],
            message: "driverType is only allowed when role is DRIVER",
        });
    }
});
const usersFastifyRoutes = async (fastify) => {
    fastify.post("/register", async (request, reply) => {
        try {
            const body = (request.body ?? {});
            const role = typeof body.role === "string" ? body.role : undefined;
            if (role && role !== identity_access_1.ROLE_CUSTOMER) {
                return reply.code(403).send({ error: "Public registration is customer-only" });
            }
            const customerTypeInput = typeof body.customerType === "string" ? body.customerType : undefined;
            const customerType = customerTypeInput && Object.values(client_1.CustomerType).includes(customerTypeInput)
                ? customerTypeInput
                : undefined;
            const result = await (0, userRepo_1.registerUser)({
                name: String(body.name ?? ""),
                email: String(body.email ?? ""),
                password: String(body.password ?? ""),
                role: identity_access_1.ROLE_CUSTOMER,
                customerType,
                companyName: body.companyName == null ? null : String(body.companyName),
                phone: body.phone == null ? null : String(body.phone),
                userAgent: typeof request.headers["user-agent"] === "string"
                    ? request.headers["user-agent"]
                    : null,
                ipAddress: extractClientIp(request),
            });
            return reply.code(201).send(result);
        }
        catch (err) {
            console.error("register error:", err?.message || err);
            if (isMissingRefreshSessionTableError(err)) {
                return reply.code(503).send({
                    error: "Auth session storage is not initialized. Run Prisma migrations and restart backend.",
                });
            }
            const message = err?.message || "Registration failed";
            const statusCode = message.includes("JWT_SECRET not configured") ? 500 : 400;
            return reply.code(statusCode).send({ error: message });
        }
    });
    fastify.post("/login", async (request, reply) => {
        try {
            const body = (request.body ?? {});
            const result = await (0, userRepo_1.loginUser)(String(body.email ?? ""), String(body.password ?? ""), {
                userAgent: typeof request.headers["user-agent"] === "string"
                    ? request.headers["user-agent"]
                    : null,
                ipAddress: extractClientIp(request),
            });
            return reply.send(result);
        }
        catch (err) {
            console.error("login error:", err?.message || err);
            if (isMissingRefreshSessionTableError(err)) {
                return reply.code(503).send({
                    error: "Auth session storage is not initialized. Run Prisma migrations and restart backend.",
                });
            }
            if (isDatabaseUnavailableError(err)) {
                return reply.code(503).send({
                    error: "Database is temporarily unreachable. Please try another network or try again later.",
                });
            }
            const message = err?.message || "Login failed";
            const statusCode = message.includes("Invalid email or password")
                ? 401
                : message.includes("JWT_SECRET not configured")
                    ? 500
                    : 400;
            return reply.code(statusCode).send({ error: message });
        }
    });
    fastify.post("/refresh", async (request, reply) => {
        try {
            const dto = refreshSchema.parse(request.body ?? {});
            const result = await (0, userRepo_1.refreshUserSession)({
                refreshToken: dto.refreshToken,
                userAgent: typeof request.headers["user-agent"] === "string"
                    ? request.headers["user-agent"]
                    : null,
                ipAddress: extractClientIp(request),
            });
            return reply.send(result);
        }
        catch (err) {
            const message = err?.message ?? "Failed to refresh session";
            const statusCode = message.includes("refresh token") || message.includes("token")
                ? 401
                : err instanceof zod_1.z.ZodError
                    ? 400
                    : 400;
            return reply.code(statusCode).send({ error: message });
        }
    });
    fastify.post("/logout", async (request, reply) => {
        try {
            const dto = logoutSchema.parse(request.body ?? {});
            await (0, userRepo_1.revokeRefreshSession)(dto.refreshToken);
            return reply.send({ ok: true });
        }
        catch (err) {
            const message = err?.message ?? "Failed to logout";
            return reply.code(err instanceof zod_1.z.ZodError ? 400 : 400).send({ error: message });
        }
    });
    fastify.post("/change-password", { preHandler: (0, authFastify_1.fastifyAuth)() }, async (request, reply) => {
        try {
            if (!request.user?.id) {
                return reply.code(401).send({ error: "Unauthorized" });
            }
            const dto = changePasswordSchema.parse(request.body ?? {});
            await (0, userRepo_1.changeUserPassword)({
                userId: request.user.id,
                currentPassword: dto.currentPassword,
                newPassword: dto.newPassword,
            });
            return reply.send({ message: "Password updated successfully" });
        }
        catch (err) {
            const message = err?.message ?? "Failed to update password";
            const statusCode = message === "Unauthorized"
                ? 401
                : message === "Current password is incorrect"
                    ? 400
                    : err instanceof zod_1.z.ZodError
                        ? 400
                        : 400;
            return reply.code(statusCode).send({ error: message });
        }
    });
    fastify.post("/", { preHandler: (0, authFastify_1.fastifyAuth)({ permission: "users.manage" }) }, async (request, reply) => {
        try {
            const dto = createUserByManagerSchema.parse(request.body ?? {});
            const user = await (0, userRepo_1.createUserAsManager)({
                name: dto.name,
                email: dto.email,
                password: dto.password,
                role: dto.role,
                driverType: dto.driverType,
                warehouseId: dto.warehouseId ?? null,
                customerEntityId: dto.customerEntityId ?? null,
                phone: dto.phone ?? null,
            });
            return reply.code(201).send({ user });
        }
        catch (err) {
            return reply.code(err?.statusCode ?? 400).send({ error: err?.message ?? "Bad request" });
        }
    });
    fastify.get("/", { preHandler: (0, authFastify_1.fastifyAuth)({ permission: "users.manage" }) }, async (request, reply) => {
        try {
            const query = (request.query ?? {});
            const q = typeof query.q === "string" ? query.q : undefined;
            const role = typeof query.role === "string" && identity_access_1.ACTOR_ROLES.includes(query.role)
                ? query.role
                : undefined;
            const page = query.page ? Number(query.page) : 1;
            const limit = query.limit ? Number(query.limit) : 20;
            const result = await (0, userRepo_1.listUsers)({ q, role, page, limit });
            return reply.send(result);
        }
        catch (err) {
            return reply.code(400).send({ error: err?.message ?? "Failed" });
        }
    });
    fastify.delete("/:id", { preHandler: (0, authFastify_1.fastifyAuth)({ permission: "users.manage" }) }, async (request, reply) => {
        try {
            if (!request.user?.id) {
                return reply.code(401).send({ error: "Unauthorized" });
            }
            const userId = typeof request.params?.id === "string" ? request.params.id : "";
            await (0, userRepo_1.deleteUserAsManager)({
                targetUserId: userId,
                actorUserId: request.user.id,
            });
            return reply.send({ message: "User deleted successfully" });
        }
        catch (err) {
            return reply.code(400).send({
                error: err?.message ?? "Failed to delete user",
            });
        }
    });
};
exports.default = usersFastifyRoutes;
