import { FastifyPluginAsync } from "fastify";
import { ZodError } from "zod";
import { fastifyAuth } from "../../../middleware/authFastify";
import {
  backfillOrderSlaSnapshots,
  createDeliverySlaRule,
  createPricingRegion,
  createTariffPlan,
  getOperationalSlaPolicy,
  getTariffPlanById,
  listDeliverySlaRules,
  listPricingRegions,
  listTariffPlans,
  listZoneMatrix,
  quoteTariff,
  updateDeliverySlaRule,
  updateOperationalSlaPolicy,
  updatePricingRegion,
  updateTariffPlan,
  upsertZoneMatrix,
} from "../repo/pricing.repo";
import {
  backfillOrderSlaSchema,
  createDeliverySlaRuleSchema,
  createPricingRegionSchema,
  createTariffPlanSchema,
  deliverySlaRuleIdParamSchema,
  listDeliverySlaRulesQuerySchema,
  listPricingRegionsQuerySchema,
  listTariffPlansQuerySchema,
  listZoneMatrixQuerySchema,
  pricingRegionIdParamSchema,
  quoteTariffSchema,
  tariffPlanIdParamSchema,
  updateDeliverySlaRuleSchema,
  updateOperationalSlaPolicySchema,
  updatePricingRegionSchema,
  updateTariffPlanSchema,
  upsertZoneMatrixSchema,
} from "../shared/validation";

function sendError(reply: any, error: unknown, fallback: string) {
  if (error instanceof ZodError) {
    return reply.code(400).send({
      error: "Validation failed",
      issues: error.flatten(),
    });
  }

  const candidate = error as { status?: number; statusCode?: number; message?: string };
  return reply
    .code(candidate?.statusCode ?? candidate?.status ?? 500)
    .send({ error: candidate?.message ?? fallback });
}

const pricingFastifyRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get(
    "/regions",
    { preHandler: fastifyAuth({ permission: "pricing.read" }) },
    async (request, reply) => {
      try {
        const query = listPricingRegionsQuerySchema.parse(request.query);
        const regions = await listPricingRegions(query);
        return reply.send(regions);
      } catch (error) {
        return sendError(reply, error, "Failed to fetch pricing regions");
      }
    },
  );

  fastify.post(
    "/regions",
    { preHandler: fastifyAuth({ permission: "pricing.write" }) },
    async (request, reply) => {
      try {
        const input = createPricingRegionSchema.parse(request.body);
        const region = await createPricingRegion(input);
        return reply.code(201).send(region);
      } catch (error) {
        return sendError(reply, error, "Failed to create pricing region");
      }
    },
  );

  fastify.put(
    "/regions/:id",
    { preHandler: fastifyAuth({ permission: "pricing.write" }) },
    async (request, reply) => {
      try {
        const { id } = pricingRegionIdParamSchema.parse(request.params);
        const input = updatePricingRegionSchema.parse(request.body);
        const region = await updatePricingRegion(id, input);
        return reply.send(region);
      } catch (error) {
        return sendError(reply, error, "Failed to update pricing region");
      }
    },
  );

  fastify.get(
    "/sla-rules",
    { preHandler: fastifyAuth({ permission: "pricing.read" }) },
    async (request, reply) => {
      try {
        const query = listDeliverySlaRulesQuerySchema.parse(request.query);
        const rules = await listDeliverySlaRules(query);
        return reply.send(rules);
      } catch (error) {
        return sendError(reply, error, "Failed to fetch delivery SLA rules");
      }
    },
  );

  fastify.post(
    "/sla-rules",
    { preHandler: fastifyAuth({ permission: "pricing.write" }) },
    async (request, reply) => {
      try {
        const input = createDeliverySlaRuleSchema.parse(request.body);
        const rule = await createDeliverySlaRule(input);
        return reply.code(201).send(rule);
      } catch (error) {
        return sendError(reply, error, "Failed to create delivery SLA rule");
      }
    },
  );

  fastify.put(
    "/sla-rules/:id",
    { preHandler: fastifyAuth({ permission: "pricing.write" }) },
    async (request, reply) => {
      try {
        const { id } = deliverySlaRuleIdParamSchema.parse(request.params);
        const input = updateDeliverySlaRuleSchema.parse(request.body);
        const rule = await updateDeliverySlaRule(id, input);
        return reply.send(rule);
      } catch (error) {
        return sendError(reply, error, "Failed to update delivery SLA rule");
      }
    },
  );

  fastify.get(
    "/sla-policy",
    { preHandler: fastifyAuth({ permission: "pricing.read" }) },
    async (_request, reply) => {
      try {
        const policy = await getOperationalSlaPolicy();
        return reply.send(policy);
      } catch (error) {
        return sendError(reply, error, "Failed to fetch operational SLA policy");
      }
    },
  );

  fastify.put(
    "/sla-policy",
    { preHandler: fastifyAuth({ permission: "pricing.write" }) },
    async (request, reply) => {
      try {
        const input = updateOperationalSlaPolicySchema.parse(request.body);
        const policy = await updateOperationalSlaPolicy(input);
        return reply.send(policy);
      } catch (error) {
        return sendError(reply, error, "Failed to update operational SLA policy");
      }
    },
  );

  fastify.post(
    "/sla/backfill",
    { preHandler: fastifyAuth({ permission: "pricing.write" }) },
    async (request, reply) => {
      try {
        const input = backfillOrderSlaSchema.parse(request.body ?? {});
        const result = await backfillOrderSlaSnapshots(input);
        return reply.send(result);
      } catch (error) {
        return sendError(reply, error, "Failed to run SLA backfill");
      }
    },
  );

  fastify.get(
    "/zones",
    { preHandler: fastifyAuth({ permission: "pricing.read" }) },
    async (request, reply) => {
      try {
        const query = listZoneMatrixQuerySchema.parse(request.query);
        const zones = await listZoneMatrix(query);
        return reply.send(zones);
      } catch (error) {
        return sendError(reply, error, "Failed to fetch zone matrix");
      }
    },
  );

  fastify.post(
    "/zones/bulk",
    { preHandler: fastifyAuth({ permission: "pricing.write" }) },
    async (request, reply) => {
      try {
        const input = upsertZoneMatrixSchema.parse(request.body);
        const zones = await upsertZoneMatrix(input);
        return reply.code(201).send(zones);
      } catch (error) {
        return sendError(reply, error, "Failed to save zone matrix");
      }
    },
  );

  fastify.get(
    "/tariff-plans",
    { preHandler: fastifyAuth({ permission: "pricing.read" }) },
    async (request, reply) => {
      try {
        const query = listTariffPlansQuerySchema.parse(request.query);
        const plans = await listTariffPlans(query);
        return reply.send(plans);
      } catch (error) {
        return sendError(reply, error, "Failed to fetch tariff plans");
      }
    },
  );

  fastify.get(
    "/tariff-plans/:id",
    { preHandler: fastifyAuth({ permission: "pricing.read" }) },
    async (request, reply) => {
      try {
        const { id } = tariffPlanIdParamSchema.parse(request.params);
        const plan = await getTariffPlanById(id);
        if (!plan) return reply.code(404).send({ error: "Tariff plan not found" });
        return reply.send(plan);
      } catch (error) {
        return sendError(reply, error, "Failed to fetch tariff plan");
      }
    },
  );

  fastify.post(
    "/tariff-plans",
    { preHandler: fastifyAuth({ permission: "pricing.write" }) },
    async (request, reply) => {
      try {
        const input = createTariffPlanSchema.parse(request.body);
        const plan = await createTariffPlan(input);
        return reply.code(201).send(plan);
      } catch (error) {
        return sendError(reply, error, "Failed to create tariff plan");
      }
    },
  );

  fastify.put(
    "/tariff-plans/:id",
    { preHandler: fastifyAuth({ permission: "pricing.write" }) },
    async (request, reply) => {
      try {
        const { id } = tariffPlanIdParamSchema.parse(request.params);
        const input = updateTariffPlanSchema.parse(request.body);
        const plan = await updateTariffPlan(id, input);
        return reply.send(plan);
      } catch (error) {
        return sendError(reply, error, "Failed to update tariff plan");
      }
    },
  );

  fastify.post(
    "/quote",
    { preHandler: fastifyAuth({ permission: "pricing.read" }) },
    async (request, reply) => {
      try {
        const parsed = quoteTariffSchema.parse(request.body);
        const input = {
          ...parsed,
          customerEntityId: parsed.customerEntityId ?? request.user?.customerEntityId ?? null,
        };
        const quote = await quoteTariff(input);
        return reply.send(quote);
      } catch (error) {
        return sendError(reply, error, "Failed to quote tariff plan");
      }
    },
  );
};

export default pricingFastifyRoutes;
