"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const client_1 = require("@prisma/client");
const zod_1 = require("zod");
const fastify_auth_1 = require("../../../modules/identity-access/transport/fastify-auth");
const identity_access_1 = require("../../identity-access");
const customerEntityRepo_1 = require("../application/customerEntityRepo");
const createCustomerSchema = zod_1.z
    .object({
    type: zod_1.z.enum(["PERSON", "COMPANY"]),
    name: zod_1.z.string().min(2),
    email: zod_1.z.string().email().optional().nullable(),
    phone: zod_1.z.string().optional().nullable(),
    altPhone1: zod_1.z.string().optional().nullable(),
    altPhone2: zod_1.z.string().optional().nullable(),
    companyName: zod_1.z.string().optional().nullable(),
    taxId: zod_1.z.string().optional().nullable(),
})
    .superRefine((value, ctx) => {
    if (value.type === "COMPANY") {
        if (!value.companyName) {
            ctx.addIssue({
                code: "custom",
                path: ["companyName"],
                message: "Company name is required",
            });
        }
        if (!value.taxId) {
            ctx.addIssue({
                code: "custom",
                path: ["taxId"],
                message: "Tax ID is required",
            });
        }
    }
});
function sendError(reply, err, fallback) {
    if (err instanceof zod_1.ZodError) {
        return reply.code(400).send({ error: "Validation failed", issues: err.flatten() });
    }
    return reply.code(err?.statusCode ?? 500).send({ error: err?.message ?? fallback });
}
const customersFastifyRoutes = async (fastify) => {
    fastify.get("/", { preHandler: (0, fastify_auth_1.fastifyAuth)({ permission: "customers.read" }) }, async (request, reply) => {
        try {
            const q = typeof request.query?.q === "string" ? request.query.q : undefined;
            const rawType = typeof request.query?.type === "string" ? request.query.type : undefined;
            const type = rawType && Object.values(client_1.CustomerType).includes(rawType)
                ? rawType
                : undefined;
            const page = request.query?.page ? Number(request.query.page) : undefined;
            const limit = request.query?.limit ? Number(request.query.limit) : undefined;
            const scopeWhere = await (0, identity_access_1.buildCustomerEntityScopeWhere)(request.user);
            const result = await (0, customerEntityRepo_1.listCustomerEntities)({
                q,
                type,
                page,
                limit,
                where: scopeWhere ?? undefined,
            });
            return reply.send(result);
        }
        catch (err) {
            return sendError(reply, err, "Failed to fetch customers");
        }
    });
    fastify.get("/:id", { preHandler: (0, fastify_auth_1.fastifyAuth)({ permission: "customers.read" }) }, async (request, reply) => {
        try {
            const id = String(request.params?.id ?? "").trim();
            if (!id)
                return reply.code(400).send({ error: "Customer id is required" });
            const scopeWhere = await (0, identity_access_1.buildCustomerEntityScopeWhere)(request.user);
            const customer = await (0, customerEntityRepo_1.getCustomerEntityById)(id);
            if (!customer)
                return reply.code(404).send({ error: "Not found" });
            if (scopeWhere?.id) {
                const scopedId = scopeWhere.id;
                if (typeof scopedId === "object" &&
                    scopedId !== null &&
                    "in" in scopedId) {
                    const scopedIds = scopedId.in;
                    if (Array.isArray(scopedIds) && !scopedIds.includes(customer.id)) {
                        return reply.code(403).send({ error: "Forbidden" });
                    }
                }
                else if (typeof scopedId === "string" && scopedId !== customer.id) {
                    return reply.code(403).send({ error: "Forbidden" });
                }
            }
            return reply.send(customer);
        }
        catch (err) {
            return sendError(reply, err, "Failed to fetch customer");
        }
    });
    fastify.post("/", { preHandler: (0, fastify_auth_1.fastifyAuth)({ permission: "customers.write" }) }, async (request, reply) => {
        try {
            const dto = createCustomerSchema.parse(request.body);
            const created = await (0, customerEntityRepo_1.createCustomerEntity)({
                ...dto,
                type: dto.type,
            });
            return reply.code(201).send(created);
        }
        catch (err) {
            return sendError(reply, err, "Failed to create customer");
        }
    });
};
exports.default = customersFastifyRoutes;
