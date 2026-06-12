"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const fastify_auth_1 = require("../../../identity-access/transport/fastify-auth");
const __1 = require("../..");
const shared_1 = require("../shared");
const importRoutes = async (fastify) => {
    fastify.get("/import/template.csv", { preHandler: (0, fastify_auth_1.fastifyAuth)({ permission: "shipment.create" }) }, async (_request, reply) => {
        const csv = (0, __1.getOrderImportTemplateCsv)();
        reply.header("Content-Type", "text/csv; charset=utf-8");
        reply.header("Content-Disposition", 'attachment; filename="order-import-template-v1.csv"');
        return reply.code(200).send(csv);
    });
    fastify.post("/import/preview", { preHandler: (0, fastify_auth_1.fastifyAuth)({ permission: "shipment.create" }) }, async (request, reply) => {
        try {
            if (!request.user?.id)
                return reply.code(401).send({ error: "Unauthorized" });
            const body = (request.body ?? {});
            const csvText = typeof body.csvText === "string" ? body.csvText : "";
            const customerEntityId = typeof body.customerEntityId === "string" ? body.customerEntityId : request.user.customerEntityId ?? null;
            if (!csvText.trim())
                return reply.code(400).send({ error: "csvText is required" });
            if (!customerEntityId)
                return reply.code(400).send({ error: "customerEntityId is required for bulk import" });
            const preview = await (0, __1.previewOrderImport)({ csvText, customerEntityId });
            return reply.send(preview);
        }
        catch (err) {
            return (0, shared_1.sendError)(reply, err, "Failed to preview import");
        }
    });
    fastify.post("/import/confirm", { preHandler: (0, fastify_auth_1.fastifyAuth)({ permission: "shipment.create" }) }, async (request, reply) => {
        try {
            if (!request.user?.id)
                return reply.code(401).send({ error: "Unauthorized" });
            const body = (request.body ?? {});
            const csvText = typeof body.csvText === "string" ? body.csvText : "";
            const customerEntityId = typeof body.customerEntityId === "string" ? body.customerEntityId : request.user.customerEntityId ?? null;
            if (!csvText.trim())
                return reply.code(400).send({ error: "csvText is required" });
            if (!customerEntityId)
                return reply.code(400).send({ error: "customerEntityId is required for bulk import" });
            const result = await (0, __1.importOrdersFromCsv)({ actor: request.user, csvText, customerEntityId });
            await (0, shared_1.emitMutationInvalidation)("order_mutation");
            return reply.code(201).send({ success: true, count: result.count, orders: result.orders });
        }
        catch (err) {
            return (0, shared_1.sendError)(reply, err, "Failed to import orders");
        }
    });
};
exports.default = importRoutes;
