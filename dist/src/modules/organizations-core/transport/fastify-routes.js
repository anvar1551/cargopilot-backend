"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const zod_1 = require("zod");
const identity_access_1 = require("../../identity-access");
const fastify_auth_1 = require("../../identity-access/transport/fastify-auth");
const organizationRepo_1 = require("../application/organizationRepo");
const organizationTypeSchema = zod_1.z.enum([
    "company",
    "branch",
    "agent",
    "pickup_point",
    "carrier",
    "client",
]);
const listOrganizationsQuerySchema = zod_1.z.object({
    type: organizationTypeSchema.optional(),
    parentOrgId: zod_1.z.string().uuid().optional(),
    isActive: zod_1.z
        .string()
        .optional()
        .transform((value) => {
        if (value == null || value === "")
            return undefined;
        const normalized = value.trim().toLowerCase();
        if (normalized === "true" || normalized === "1")
            return true;
        if (normalized === "false" || normalized === "0")
            return false;
        return undefined;
    }),
    q: zod_1.z.string().optional(),
    page: zod_1.z.coerce.number().int().min(1).optional(),
    limit: zod_1.z.coerce.number().int().min(1).max(100).optional(),
});
const createOrganizationSchema = zod_1.z.object({
    name: zod_1.z.string().trim().min(2).max(120),
    type: organizationTypeSchema,
    code: zod_1.z.string().trim().min(2).max(64).optional().nullable(),
    parentOrgId: zod_1.z.string().uuid().optional().nullable(),
    isActive: zod_1.z.boolean().optional(),
});
const updateOrganizationSchema = zod_1.z.object({
    name: zod_1.z.string().trim().min(2).max(120).optional(),
    type: organizationTypeSchema.optional(),
    code: zod_1.z.string().trim().min(2).max(64).optional().nullable(),
    parentOrgId: zod_1.z.string().uuid().optional().nullable(),
    isActive: zod_1.z.boolean().optional(),
});
function sendError(reply, err, fallback) {
    if (err instanceof zod_1.ZodError) {
        return reply
            .code(400)
            .send({ error: "Validation failed", issues: err.flatten() });
    }
    const anyErr = err;
    return reply
        .code(anyErr?.statusCode ?? 500)
        .send({ error: anyErr?.message ?? fallback });
}
function asOrganizationType(value) {
    return value;
}
async function resolveParentForWrite(args) {
    if (!args.parentOrgId)
        return null;
    const parent = await (0, organizationRepo_1.getOrganizationById)({
        id: args.parentOrgId,
        where: args.scopeWhere,
    });
    if (!parent) {
        const err = new Error("Parent organization is not accessible");
        err.statusCode = 403;
        throw err;
    }
    return parent;
}
function enforceHierarchy(args) {
    if (!(0, organizationRepo_1.isAllowedParentType)(args)) {
        const err = new Error(`Invalid hierarchy: ${args.childType} cannot be nested under ${args.parentType ?? "null"}`);
        err.statusCode = 400;
        throw err;
    }
}
const organizationsFastifyRoutes = async (fastify) => {
    fastify.get("/", { preHandler: (0, fastify_auth_1.fastifyAuth)({ permission: "organizations.read" }) }, async (request, reply) => {
        try {
            const query = listOrganizationsQuerySchema.parse(request.query ?? {});
            const scopeWhere = await (0, identity_access_1.buildOrganizationScopeWhere)(request.user);
            const result = await (0, organizationRepo_1.listOrganizations)({
                where: scopeWhere ?? undefined,
                type: query.type ? asOrganizationType(query.type) : undefined,
                parentOrgId: query.parentOrgId ?? undefined,
                isActive: query.isActive,
                q: query.q,
                page: query.page,
                limit: query.limit,
            });
            return reply.send(result);
        }
        catch (err) {
            return sendError(reply, err, "Failed to list organizations");
        }
    });
    fastify.get("/:id", { preHandler: (0, fastify_auth_1.fastifyAuth)({ permission: "organizations.read" }) }, async (request, reply) => {
        try {
            const id = String(request.params?.id || "").trim();
            if (!id)
                return reply.code(400).send({ error: "Organization id is required" });
            const scopeWhere = await (0, identity_access_1.buildOrganizationScopeWhere)(request.user);
            const item = await (0, organizationRepo_1.getOrganizationById)({ id, where: scopeWhere });
            if (!item)
                return reply.code(404).send({ error: "Organization not found" });
            return reply.send(item);
        }
        catch (err) {
            return sendError(reply, err, "Failed to fetch organization");
        }
    });
    fastify.post("/", { preHandler: (0, fastify_auth_1.fastifyAuth)({ permission: "organizations.write" }) }, async (request, reply) => {
        try {
            const body = createOrganizationSchema.parse(request.body ?? {});
            const scopeWhere = await (0, identity_access_1.buildOrganizationScopeWhere)(request.user);
            const parent = await resolveParentForWrite({
                parentOrgId: body.parentOrgId ?? null,
                scopeWhere,
            });
            enforceHierarchy({
                childType: asOrganizationType(body.type),
                parentType: parent?.type ?? null,
            });
            if (body.type === "company" &&
                !parent &&
                !(0, identity_access_1.hasAnyPermissionSync)(request.user, ["policy.override"])) {
                return reply
                    .code(403)
                    .send({ error: "Creating top-level company requires policy.override" });
            }
            const created = await (0, organizationRepo_1.createOrganization)({
                name: body.name,
                type: asOrganizationType(body.type),
                code: body.code ?? null,
                parentOrgId: body.parentOrgId ?? null,
                isActive: body.isActive ?? true,
            });
            return reply.code(201).send(created);
        }
        catch (err) {
            if (err?.code === "P2002") {
                return reply.code(409).send({ error: "Organization code already exists" });
            }
            return sendError(reply, err, "Failed to create organization");
        }
    });
    fastify.put("/:id", { preHandler: (0, fastify_auth_1.fastifyAuth)({ permission: "organizations.write" }) }, async (request, reply) => {
        try {
            const id = String(request.params?.id || "").trim();
            if (!id)
                return reply.code(400).send({ error: "Organization id is required" });
            const body = updateOrganizationSchema.parse(request.body ?? {});
            const scopeWhere = await (0, identity_access_1.buildOrganizationScopeWhere)(request.user);
            const current = await (0, organizationRepo_1.getOrganizationById)({ id, where: scopeWhere });
            if (!current)
                return reply.code(404).send({ error: "Organization not found" });
            const nextType = body.type
                ? asOrganizationType(body.type)
                : current.type;
            const nextParentId = body.parentOrgId === undefined ? current.parentOrgId : body.parentOrgId;
            if (nextParentId === id) {
                return reply.code(400).send({ error: "Organization cannot be its own parent" });
            }
            const parent = await resolveParentForWrite({
                parentOrgId: nextParentId ?? null,
                scopeWhere,
            });
            enforceHierarchy({
                childType: nextType,
                parentType: parent?.type ?? null,
            });
            if (nextType === "company" &&
                !parent &&
                !(0, identity_access_1.hasAnyPermissionSync)(request.user, ["policy.override"])) {
                return reply
                    .code(403)
                    .send({ error: "Creating top-level company requires policy.override" });
            }
            const updated = await (0, organizationRepo_1.updateOrganization)({
                id,
                name: body.name,
                type: nextType,
                code: body.code,
                parentOrgId: nextParentId ?? null,
                isActive: body.isActive,
            });
            return reply.send(updated);
        }
        catch (err) {
            if (err?.code === "P2002") {
                return reply.code(409).send({ error: "Organization code already exists" });
            }
            return sendError(reply, err, "Failed to update organization");
        }
    });
    fastify.delete("/:id", { preHandler: (0, fastify_auth_1.fastifyAuth)({ permission: "organizations.write" }) }, async (request, reply) => {
        try {
            const id = String(request.params?.id || "").trim();
            if (!id)
                return reply.code(400).send({ error: "Organization id is required" });
            const scopeWhere = await (0, identity_access_1.buildOrganizationScopeWhere)(request.user);
            const current = await (0, organizationRepo_1.getOrganizationById)({ id, where: scopeWhere });
            if (!current)
                return reply.code(404).send({ error: "Organization not found" });
            const deactivated = await (0, organizationRepo_1.deactivateOrganization)(id);
            return reply.send(deactivated);
        }
        catch (err) {
            return sendError(reply, err, "Failed to delete organization");
        }
    });
};
exports.default = organizationsFastifyRoutes;
