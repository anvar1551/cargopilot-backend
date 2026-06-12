"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const zod_1 = require("zod");
const fastify_auth_1 = require("./fastify-auth");
const auth_service_1 = require("../application/auth.service");
const iam_service_1 = require("../application/iam.service");
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
const usersFastifyRoutes = async (fastify) => {
    await (0, iam_service_1.seedSystemPermissions)();
    fastify.post("/register", async (request, reply) => {
        try {
            const body = (request.body ?? {});
            const result = await (0, auth_service_1.registerUser)({
                name: String(body.name ?? ""),
                email: String(body.email ?? ""),
                password: String(body.password ?? ""),
                companyId: typeof body.companyId === "string" ? body.companyId : null,
                roleCodes: Array.isArray(body.roleCodes)
                    ? body.roleCodes.map((value) => String(value))
                    : undefined,
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
            const message = err?.message ?? "Registration failed";
            return reply.code(400).send({ error: message });
        }
    });
    fastify.post("/login", async (request, reply) => {
        try {
            const body = (request.body ?? {});
            const result = await (0, auth_service_1.loginUser)({
                email: String(body.email ?? ""),
                password: String(body.password ?? ""),
                userAgent: typeof request.headers["user-agent"] === "string"
                    ? request.headers["user-agent"]
                    : null,
                ipAddress: extractClientIp(request),
            });
            return reply.send(result);
        }
        catch (err) {
            const message = err?.message || "Login failed";
            const statusCode = message.includes("Invalid email or password") ? 401 : 400;
            return reply.code(statusCode).send({ error: message });
        }
    });
    fastify.post("/refresh", async (request, reply) => {
        try {
            const dto = refreshSchema.parse(request.body ?? {});
            const result = await (0, auth_service_1.refreshUserSession)({
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
            const statusCode = message.includes("token") ? 401 : 400;
            return reply.code(statusCode).send({ error: message });
        }
    });
    fastify.post("/logout", async (request, reply) => {
        try {
            const dto = logoutSchema.parse(request.body ?? {});
            await (0, auth_service_1.revokeRefreshSession)(dto.refreshToken);
            return reply.send({ ok: true });
        }
        catch (err) {
            return reply.code(err instanceof zod_1.z.ZodError ? 400 : 400).send({
                error: err?.message ?? "Failed to logout",
            });
        }
    });
    fastify.get("/me", { preHandler: (0, fastify_auth_1.fastifyAuth)() }, async (request, reply) => {
        return reply.send({ user: request.user });
    });
    fastify.post("/change-password", { preHandler: (0, fastify_auth_1.fastifyAuth)() }, async (request, reply) => {
        try {
            if (!request.user?.id) {
                return reply.code(401).send({ error: "Unauthorized" });
            }
            const dto = changePasswordSchema.parse(request.body ?? {});
            await (0, auth_service_1.changeUserPassword)({
                userId: request.user.id,
                currentPassword: dto.currentPassword,
                newPassword: dto.newPassword,
            });
            return reply.send({ message: "Password updated successfully" });
        }
        catch (err) {
            const message = err?.message ?? "Failed to update password";
            const statusCode = message === "Unauthorized" ? 401 : 400;
            return reply.code(statusCode).send({ error: message });
        }
    });
    fastify.get("/permissions", { preHandler: (0, fastify_auth_1.fastifyAuth)({ permission: "roles.read" }) }, async (_request, reply) => {
        const items = await (0, iam_service_1.listPermissions)();
        return reply.send({ items });
    });
    fastify.get("/roles", { preHandler: (0, fastify_auth_1.fastifyAuth)({ permission: "roles.read" }) }, async (request, reply) => {
        if (!request.user?.companyId)
            return reply.code(400).send({ error: "companyId missing" });
        const query = (request.query ?? {});
        const includeSystem = String(query.includeSystem ?? "true").toLowerCase() !== "false";
        const items = await (0, iam_service_1.listRolesForCompany)({
            companyId: request.user.companyId,
            includeSystem,
        });
        return reply.send({ items });
    });
    fastify.post("/roles", { preHandler: (0, fastify_auth_1.fastifyAuth)({ permission: "role.bindPermissions" }) }, async (request, reply) => {
        try {
            if (!request.user?.companyId) {
                return reply.code(400).send({ error: "companyId missing" });
            }
            const body = (request.body ?? {});
            const role = await (0, iam_service_1.createRoleForCompany)({
                companyId: request.user.companyId,
                code: typeof body.code === "string" ? body.code : null,
                name: String(body.name ?? ""),
                permissionKeys: Array.isArray(body.permissionKeys)
                    ? body.permissionKeys.map((value) => String(value))
                    : [],
                isOwnerRole: Boolean(body.isOwnerRole),
            });
            return reply.code(201).send({ role });
        }
        catch (err) {
            return reply.code(400).send({ error: err?.message ?? "Failed to create role" });
        }
    });
    fastify.get("/", { preHandler: (0, fastify_auth_1.fastifyAuth)({ permission: "membership.invite" }) }, async (request, reply) => {
        if (!request.user?.companyId)
            return reply.code(400).send({ error: "companyId missing" });
        const query = (request.query ?? {});
        const q = typeof query.q === "string" ? query.q : undefined;
        const page = query.page ? Number(query.page) : 1;
        const limit = query.limit ? Number(query.limit) : 20;
        const result = await (0, auth_service_1.listUsersForCompany)({
            companyId: request.user.companyId,
            q,
            page,
            limit,
        });
        return reply.send(result);
    });
    fastify.post("/", { preHandler: (0, fastify_auth_1.fastifyAuth)({ permission: "membership.invite" }) }, async (request, reply) => {
        try {
            if (!request.user?.companyId)
                return reply.code(400).send({ error: "companyId missing" });
            const body = (request.body ?? {});
            const user = await (0, auth_service_1.createUserByCompanyAdmin)({
                companyId: request.user.companyId,
                name: String(body.name ?? ""),
                email: String(body.email ?? ""),
                password: String(body.password ?? ""),
                roleCodes: Array.isArray(body.roleCodes)
                    ? body.roleCodes.map((value) => String(value))
                    : [],
                branchId: typeof body.branchId === "string" ? body.branchId : null,
                warehouseId: typeof body.warehouseId === "string" ? body.warehouseId : null,
                customerEntityId: typeof body.customerEntityId === "string" ? body.customerEntityId : null,
                driverType: body.driverType === "local" || body.driverType === "linehaul"
                    ? body.driverType
                    : null,
                scopes: body.scopes,
            });
            return reply.code(201).send({ user });
        }
        catch (err) {
            return reply.code(400).send({ error: err?.message ?? "Bad request" });
        }
    });
    fastify.delete("/:id", { preHandler: (0, fastify_auth_1.fastifyAuth)({ permission: "membership.suspend" }) }, async (request, reply) => {
        try {
            if (!request.user?.id || !request.user?.companyId) {
                return reply.code(401).send({ error: "Unauthorized" });
            }
            const userId = typeof request.params?.id === "string" ? request.params.id : "";
            await (0, auth_service_1.deleteUserMembershipFromCompany)({
                actorUserId: request.user.id,
                targetUserId: userId,
                companyId: request.user.companyId,
            });
            return reply.send({ message: "User deleted successfully" });
        }
        catch (err) {
            return reply.code(400).send({
                error: err?.message ?? "Failed to delete user",
            });
        }
    });
    fastify.patch("/:id", { preHandler: (0, fastify_auth_1.fastifyAuth)({ permission: "membership.invite" }) }, async (request, reply) => {
        try {
            if (!request.user?.companyId) {
                return reply.code(400).send({ error: "companyId missing" });
            }
            const userId = typeof request.params?.id === "string" ? request.params.id : "";
            const body = (request.body ?? {});
            const user = await (0, auth_service_1.updateUserAccessByCompanyAdmin)({
                companyId: request.user.companyId,
                userId,
                name: body.name === undefined ? undefined : String(body.name),
                email: body.email === undefined ? undefined : String(body.email),
                roleCodes: Array.isArray(body.roleCodes)
                    ? body.roleCodes.map((value) => String(value))
                    : undefined,
                branchId: body.branchId === undefined
                    ? undefined
                    : typeof body.branchId === "string"
                        ? body.branchId
                        : null,
                warehouseId: body.warehouseId === undefined
                    ? undefined
                    : typeof body.warehouseId === "string"
                        ? body.warehouseId
                        : null,
                customerEntityId: body.customerEntityId === undefined
                    ? undefined
                    : typeof body.customerEntityId === "string"
                        ? body.customerEntityId
                        : null,
                driverType: body.driverType === undefined
                    ? undefined
                    : body.driverType === "local" || body.driverType === "linehaul"
                        ? body.driverType
                        : null,
                scopes: body.scopes,
            });
            return reply.send({ user });
        }
        catch (err) {
            return reply.code(400).send({ error: err?.message ?? "Failed to update user access" });
        }
    });
};
exports.default = usersFastifyRoutes;
