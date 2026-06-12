"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const zod_1 = require("zod");
const prismaClient_1 = __importDefault(require("../../../config/prismaClient"));
const fastify_auth_1 = require("../../../modules/identity-access/transport/fastify-auth");
const identity_access_1 = require("../../identity-access");
const addressRepo_1 = require("../application/addressRepo");
const addressCreateSchema = zod_1.z.object({
    customerEntityId: zod_1.z.string().uuid().optional().nullable(),
    country: zod_1.z.string().optional().nullable(),
    city: zod_1.z.string().optional().nullable(),
    neighborhood: zod_1.z.string().optional().nullable(),
    street: zod_1.z.string().optional().nullable(),
    latitude: zod_1.z.number().optional().nullable(),
    longitude: zod_1.z.number().optional().nullable(),
    addressLine1: zod_1.z.string().optional().nullable(),
    addressLine2: zod_1.z.string().optional().nullable(),
    building: zod_1.z.string().optional().nullable(),
    apartment: zod_1.z.string().optional().nullable(),
    floor: zod_1.z.string().optional().nullable(),
    landmark: zod_1.z.string().optional().nullable(),
    postalCode: zod_1.z.string().optional().nullable(),
    addressType: zod_1.z.enum(["RESIDENTIAL", "BUSINESS"]).optional().nullable(),
    isSaved: zod_1.z.boolean().optional().default(true),
});
function sendError(reply, err, fallback) {
    if (err instanceof zod_1.ZodError) {
        return reply.code(400).send({ error: "Validation failed", issues: err.flatten() });
    }
    return reply.code(err?.statusCode ?? 500).send({ error: err?.message ?? fallback });
}
const addressesFastifyRoutes = async (fastify) => {
    fastify.get("/", { preHandler: (0, fastify_auth_1.fastifyAuth)({ permission: "customers.read" }) }, async (request, reply) => {
        try {
            const q = typeof request.query?.q === "string" ? request.query.q : undefined;
            const take = request.query?.take ? Number(request.query.take) : undefined;
            const queryCustomerEntityId = typeof request.query?.customerEntityId === "string"
                ? request.query.customerEntityId
                : undefined;
            const scopeWhere = await (0, identity_access_1.buildCustomerEntityScopeWhere)(request.user);
            if (scopeWhere?.id === "__no_access__") {
                return reply.code(403).send({ error: "Forbidden" });
            }
            let customerEntityId;
            if (!scopeWhere || Object.keys(scopeWhere).length === 0) {
                customerEntityId = queryCustomerEntityId;
            }
            else if (scopeWhere.id && typeof scopeWhere.id === "string") {
                customerEntityId = scopeWhere.id;
                if (queryCustomerEntityId && queryCustomerEntityId !== customerEntityId) {
                    return reply.code(403).send({ error: "Forbidden" });
                }
            }
            else {
                customerEntityId = request.user?.customerEntityId ?? undefined;
                if (queryCustomerEntityId && queryCustomerEntityId !== customerEntityId) {
                    return reply.code(403).send({ error: "Forbidden" });
                }
            }
            const rows = await (0, addressRepo_1.listAddresses)({ customerEntityId, q, take });
            return reply.send(rows);
        }
        catch (err) {
            return sendError(reply, err, "Failed to fetch addresses");
        }
    });
    fastify.post("/", { preHandler: (0, fastify_auth_1.fastifyAuth)({ permission: "customers.write" }) }, async (request, reply) => {
        try {
            const dto = addressCreateSchema.parse(request.body);
            const scopeWhere = await (0, identity_access_1.buildCustomerEntityScopeWhere)(request.user);
            if (scopeWhere?.id === "__no_access__") {
                return reply.code(403).send({ error: "Forbidden" });
            }
            let ownerCustomerEntityId = null;
            if (!scopeWhere || Object.keys(scopeWhere).length === 0) {
                ownerCustomerEntityId = dto.customerEntityId ?? request.user?.customerEntityId ?? null;
            }
            else if (scopeWhere.id && typeof scopeWhere.id === "string") {
                ownerCustomerEntityId = scopeWhere.id;
                if (dto.customerEntityId && dto.customerEntityId !== ownerCustomerEntityId) {
                    return reply.code(403).send({ error: "Forbidden" });
                }
            }
            else {
                ownerCustomerEntityId = request.user?.customerEntityId ?? null;
                if (dto.customerEntityId && dto.customerEntityId !== ownerCustomerEntityId) {
                    return reply.code(403).send({ error: "Forbidden" });
                }
            }
            if (!ownerCustomerEntityId) {
                return reply.code(400).send({
                    error: "customerEntityId is required to create an address",
                });
            }
            const created = await prismaClient_1.default.address.create({
                data: {
                    customerEntity: {
                        connect: { id: ownerCustomerEntityId },
                    },
                    country: dto.country ?? null,
                    city: dto.city ?? null,
                    neighborhood: dto.neighborhood ?? null,
                    street: dto.street ?? null,
                    latitude: dto.latitude ?? null,
                    longitude: dto.longitude ?? null,
                    addressLine1: dto.addressLine1 ?? null,
                    addressLine2: dto.addressLine2 ?? null,
                    building: dto.building ?? null,
                    apartment: dto.apartment ?? null,
                    floor: dto.floor ?? null,
                    landmark: dto.landmark ?? null,
                    postalCode: dto.postalCode ?? null,
                    addressType: dto.addressType ?? null,
                    isSaved: dto.isSaved ?? true,
                },
            });
            return reply.code(201).send(created);
        }
        catch (err) {
            return sendError(reply, err, "Failed to create address");
        }
    });
};
exports.default = addressesFastifyRoutes;
