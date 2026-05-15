"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const zod_1 = require("zod");
const authFastify_1 = require("../../../middleware/authFastify");
const pricing_repo_1 = require("../repo/pricing.repo");
const validation_1 = require("../shared/validation");
function sendError(reply, error, fallback) {
    if (error instanceof zod_1.ZodError) {
        return reply.code(400).send({
            error: "Validation failed",
            issues: error.flatten(),
        });
    }
    const candidate = error;
    return reply
        .code(candidate?.statusCode ?? candidate?.status ?? 500)
        .send({ error: candidate?.message ?? fallback });
}
const pricingFastifyRoutes = async (fastify) => {
    fastify.get("/regions", { preHandler: (0, authFastify_1.fastifyAuth)({ permission: "pricing.read" }) }, async (request, reply) => {
        try {
            const query = validation_1.listPricingRegionsQuerySchema.parse(request.query);
            const regions = await (0, pricing_repo_1.listPricingRegions)(query);
            return reply.send(regions);
        }
        catch (error) {
            return sendError(reply, error, "Failed to fetch pricing regions");
        }
    });
    fastify.post("/regions", { preHandler: (0, authFastify_1.fastifyAuth)({ permission: "pricing.write" }) }, async (request, reply) => {
        try {
            const input = validation_1.createPricingRegionSchema.parse(request.body);
            const region = await (0, pricing_repo_1.createPricingRegion)(input);
            return reply.code(201).send(region);
        }
        catch (error) {
            return sendError(reply, error, "Failed to create pricing region");
        }
    });
    fastify.put("/regions/:id", { preHandler: (0, authFastify_1.fastifyAuth)({ permission: "pricing.write" }) }, async (request, reply) => {
        try {
            const { id } = validation_1.pricingRegionIdParamSchema.parse(request.params);
            const input = validation_1.updatePricingRegionSchema.parse(request.body);
            const region = await (0, pricing_repo_1.updatePricingRegion)(id, input);
            return reply.send(region);
        }
        catch (error) {
            return sendError(reply, error, "Failed to update pricing region");
        }
    });
    fastify.get("/sla-rules", { preHandler: (0, authFastify_1.fastifyAuth)({ permission: "pricing.read" }) }, async (request, reply) => {
        try {
            const query = validation_1.listDeliverySlaRulesQuerySchema.parse(request.query);
            const rules = await (0, pricing_repo_1.listDeliverySlaRules)(query);
            return reply.send(rules);
        }
        catch (error) {
            return sendError(reply, error, "Failed to fetch delivery SLA rules");
        }
    });
    fastify.post("/sla-rules", { preHandler: (0, authFastify_1.fastifyAuth)({ permission: "pricing.write" }) }, async (request, reply) => {
        try {
            const input = validation_1.createDeliverySlaRuleSchema.parse(request.body);
            const rule = await (0, pricing_repo_1.createDeliverySlaRule)(input);
            return reply.code(201).send(rule);
        }
        catch (error) {
            return sendError(reply, error, "Failed to create delivery SLA rule");
        }
    });
    fastify.put("/sla-rules/:id", { preHandler: (0, authFastify_1.fastifyAuth)({ permission: "pricing.write" }) }, async (request, reply) => {
        try {
            const { id } = validation_1.deliverySlaRuleIdParamSchema.parse(request.params);
            const input = validation_1.updateDeliverySlaRuleSchema.parse(request.body);
            const rule = await (0, pricing_repo_1.updateDeliverySlaRule)(id, input);
            return reply.send(rule);
        }
        catch (error) {
            return sendError(reply, error, "Failed to update delivery SLA rule");
        }
    });
    fastify.get("/sla-policy", { preHandler: (0, authFastify_1.fastifyAuth)({ permission: "pricing.read" }) }, async (_request, reply) => {
        try {
            const policy = await (0, pricing_repo_1.getOperationalSlaPolicy)();
            return reply.send(policy);
        }
        catch (error) {
            return sendError(reply, error, "Failed to fetch operational SLA policy");
        }
    });
    fastify.put("/sla-policy", { preHandler: (0, authFastify_1.fastifyAuth)({ permission: "pricing.write" }) }, async (request, reply) => {
        try {
            const input = validation_1.updateOperationalSlaPolicySchema.parse(request.body);
            const policy = await (0, pricing_repo_1.updateOperationalSlaPolicy)(input);
            return reply.send(policy);
        }
        catch (error) {
            return sendError(reply, error, "Failed to update operational SLA policy");
        }
    });
    fastify.post("/sla/backfill", { preHandler: (0, authFastify_1.fastifyAuth)({ permission: "pricing.write" }) }, async (request, reply) => {
        try {
            const input = validation_1.backfillOrderSlaSchema.parse(request.body ?? {});
            const result = await (0, pricing_repo_1.backfillOrderSlaSnapshots)(input);
            return reply.send(result);
        }
        catch (error) {
            return sendError(reply, error, "Failed to run SLA backfill");
        }
    });
    fastify.get("/zones", { preHandler: (0, authFastify_1.fastifyAuth)({ permission: "pricing.read" }) }, async (request, reply) => {
        try {
            const query = validation_1.listZoneMatrixQuerySchema.parse(request.query);
            const zones = await (0, pricing_repo_1.listZoneMatrix)(query);
            return reply.send(zones);
        }
        catch (error) {
            return sendError(reply, error, "Failed to fetch zone matrix");
        }
    });
    fastify.post("/zones/bulk", { preHandler: (0, authFastify_1.fastifyAuth)({ permission: "pricing.write" }) }, async (request, reply) => {
        try {
            const input = validation_1.upsertZoneMatrixSchema.parse(request.body);
            const zones = await (0, pricing_repo_1.upsertZoneMatrix)(input);
            return reply.code(201).send(zones);
        }
        catch (error) {
            return sendError(reply, error, "Failed to save zone matrix");
        }
    });
    fastify.get("/tariff-plans", { preHandler: (0, authFastify_1.fastifyAuth)({ permission: "pricing.read" }) }, async (request, reply) => {
        try {
            const query = validation_1.listTariffPlansQuerySchema.parse(request.query);
            const plans = await (0, pricing_repo_1.listTariffPlans)(query);
            return reply.send(plans);
        }
        catch (error) {
            return sendError(reply, error, "Failed to fetch tariff plans");
        }
    });
    fastify.get("/tariff-plans/:id", { preHandler: (0, authFastify_1.fastifyAuth)({ permission: "pricing.read" }) }, async (request, reply) => {
        try {
            const { id } = validation_1.tariffPlanIdParamSchema.parse(request.params);
            const plan = await (0, pricing_repo_1.getTariffPlanById)(id);
            if (!plan)
                return reply.code(404).send({ error: "Tariff plan not found" });
            return reply.send(plan);
        }
        catch (error) {
            return sendError(reply, error, "Failed to fetch tariff plan");
        }
    });
    fastify.post("/tariff-plans", { preHandler: (0, authFastify_1.fastifyAuth)({ permission: "pricing.write" }) }, async (request, reply) => {
        try {
            const input = validation_1.createTariffPlanSchema.parse(request.body);
            const plan = await (0, pricing_repo_1.createTariffPlan)(input);
            return reply.code(201).send(plan);
        }
        catch (error) {
            return sendError(reply, error, "Failed to create tariff plan");
        }
    });
    fastify.put("/tariff-plans/:id", { preHandler: (0, authFastify_1.fastifyAuth)({ permission: "pricing.write" }) }, async (request, reply) => {
        try {
            const { id } = validation_1.tariffPlanIdParamSchema.parse(request.params);
            const input = validation_1.updateTariffPlanSchema.parse(request.body);
            const plan = await (0, pricing_repo_1.updateTariffPlan)(id, input);
            return reply.send(plan);
        }
        catch (error) {
            return sendError(reply, error, "Failed to update tariff plan");
        }
    });
    fastify.post("/quote", { preHandler: (0, authFastify_1.fastifyAuth)({ permission: "pricing.read" }) }, async (request, reply) => {
        try {
            const parsed = validation_1.quoteTariffSchema.parse(request.body);
            const input = {
                ...parsed,
                customerEntityId: parsed.customerEntityId ?? request.user?.customerEntityId ?? null,
            };
            const quote = await (0, pricing_repo_1.quoteTariff)(input);
            return reply.send(quote);
        }
        catch (error) {
            return sendError(reply, error, "Failed to quote tariff plan");
        }
    });
};
exports.default = pricingFastifyRoutes;
