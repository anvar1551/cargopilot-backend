"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const prismaClient_1 = __importDefault(require("../../../config/prismaClient"));
const s3Presign_1 = require("../../../utils/s3Presign");
const fastify_auth_1 = require("../../../modules/identity-access/transport/fastify-auth");
const identity_access_1 = require("../../identity-access");
const invoiceFastifyRoutes = async (fastify) => {
    fastify.get("/orders/:id/url", { preHandler: (0, fastify_auth_1.fastifyAuth)({ permission: "payments.intents.read" }) }, async (request, reply) => {
        try {
            const idParam = String(request.params?.id ?? "").trim();
            if (!idParam)
                return reply.code(400).send({ error: "Order id is required" });
            const scopeWhere = (await (0, identity_access_1.buildOrderScopeWhere)(request.user)) ?? {
                id: "__no_access__",
            };
            let invoice = await prismaClient_1.default.invoice.findFirst({
                where: {
                    orderId: idParam,
                    order: {
                        is: scopeWhere,
                    },
                },
                include: { order: true },
            });
            if (!invoice) {
                invoice = await prismaClient_1.default.invoice.findFirst({
                    where: {
                        id: idParam,
                        order: {
                            is: scopeWhere,
                        },
                    },
                    include: { order: true },
                });
            }
            if (!invoice)
                return reply.code(404).send({ error: "Invoice not found" });
            if (!invoice.invoiceKey) {
                return reply.code(404).send({ error: "Invoice PDF not available yet" });
            }
            const url = await (0, s3Presign_1.presignGetObject)(invoice.invoiceKey, 60 * 5);
            return reply.send({ url });
        }
        catch (err) {
            return reply.code(err?.statusCode ?? 500).send({
                error: err?.message ?? "Failed to get invoice url",
            });
        }
    });
};
exports.default = invoiceFastifyRoutes;
