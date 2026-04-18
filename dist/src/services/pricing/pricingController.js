"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createRegion = createRegion;
exports.getRegions = getRegions;
exports.updateRegion = updateRegion;
exports.createSlaRule = createSlaRule;
exports.getSlaRules = getSlaRules;
exports.updateSlaRule = updateSlaRule;
exports.getSlaPolicy = getSlaPolicy;
exports.updateSlaPolicy = updateSlaPolicy;
exports.saveZoneMatrix = saveZoneMatrix;
exports.getZoneMatrix = getZoneMatrix;
exports.createPlan = createPlan;
exports.getPlans = getPlans;
exports.getPlan = getPlan;
exports.updatePlan = updatePlan;
exports.quotePlan = quotePlan;
const zod_1 = require("zod");
const pricingRepo_1 = require("./pricingRepo");
const pricing_shared_1 = require("./pricing.shared");
function sendError(res, error, fallback) {
    if (error instanceof zod_1.ZodError) {
        return res.status(400).json({
            error: "Validation failed",
            issues: error.flatten(),
        });
    }
    const candidate = error;
    return res
        .status(candidate?.status ?? 500)
        .json({ error: candidate?.message ?? fallback });
}
async function createRegion(req, res) {
    try {
        const input = pricing_shared_1.createPricingRegionSchema.parse(req.body);
        const region = await (0, pricingRepo_1.createPricingRegion)(input);
        return res.status(201).json(region);
    }
    catch (error) {
        console.error("createRegion error:", error);
        return sendError(res, error, "Failed to create pricing region");
    }
}
async function getRegions(req, res) {
    try {
        const query = pricing_shared_1.listPricingRegionsQuerySchema.parse(req.query);
        const effectiveQuery = req.user?.role === "customer"
            ? {
                ...query,
                isActive: true,
            }
            : query;
        const regions = await (0, pricingRepo_1.listPricingRegions)(effectiveQuery);
        return res.json(regions);
    }
    catch (error) {
        console.error("getRegions error:", error);
        return sendError(res, error, "Failed to fetch pricing regions");
    }
}
async function updateRegion(req, res) {
    try {
        const { id } = pricing_shared_1.pricingRegionIdParamSchema.parse(req.params);
        const input = pricing_shared_1.updatePricingRegionSchema.parse(req.body);
        const region = await (0, pricingRepo_1.updatePricingRegion)(id, input);
        return res.json(region);
    }
    catch (error) {
        console.error("updateRegion error:", error);
        return sendError(res, error, "Failed to update pricing region");
    }
}
async function createSlaRule(req, res) {
    try {
        const input = pricing_shared_1.createDeliverySlaRuleSchema.parse(req.body);
        const rule = await (0, pricingRepo_1.createDeliverySlaRule)(input);
        return res.status(201).json(rule);
    }
    catch (error) {
        console.error("createSlaRule error:", error);
        return sendError(res, error, "Failed to create delivery SLA rule");
    }
}
async function getSlaRules(req, res) {
    try {
        const query = pricing_shared_1.listDeliverySlaRulesQuerySchema.parse(req.query);
        const rules = await (0, pricingRepo_1.listDeliverySlaRules)(query);
        return res.json(rules);
    }
    catch (error) {
        console.error("getSlaRules error:", error);
        return sendError(res, error, "Failed to fetch delivery SLA rules");
    }
}
async function updateSlaRule(req, res) {
    try {
        const { id } = pricing_shared_1.deliverySlaRuleIdParamSchema.parse(req.params);
        const input = pricing_shared_1.updateDeliverySlaRuleSchema.parse(req.body);
        const rule = await (0, pricingRepo_1.updateDeliverySlaRule)(id, input);
        return res.json(rule);
    }
    catch (error) {
        console.error("updateSlaRule error:", error);
        return sendError(res, error, "Failed to update delivery SLA rule");
    }
}
async function getSlaPolicy(req, res) {
    try {
        const policy = await (0, pricingRepo_1.getOperationalSlaPolicy)();
        return res.json(policy);
    }
    catch (error) {
        console.error("getSlaPolicy error:", error);
        return sendError(res, error, "Failed to fetch operational SLA policy");
    }
}
async function updateSlaPolicy(req, res) {
    try {
        const input = pricing_shared_1.updateOperationalSlaPolicySchema.parse(req.body);
        const policy = await (0, pricingRepo_1.updateOperationalSlaPolicy)(input);
        return res.json(policy);
    }
    catch (error) {
        console.error("updateSlaPolicy error:", error);
        return sendError(res, error, "Failed to update operational SLA policy");
    }
}
async function saveZoneMatrix(req, res) {
    try {
        const input = pricing_shared_1.upsertZoneMatrixSchema.parse(req.body);
        const zones = await (0, pricingRepo_1.upsertZoneMatrix)(input);
        return res.status(201).json(zones);
    }
    catch (error) {
        console.error("saveZoneMatrix error:", error);
        return sendError(res, error, "Failed to save zone matrix");
    }
}
async function getZoneMatrix(req, res) {
    try {
        const query = pricing_shared_1.listZoneMatrixQuerySchema.parse(req.query);
        const zones = await (0, pricingRepo_1.listZoneMatrix)(query);
        return res.json(zones);
    }
    catch (error) {
        console.error("getZoneMatrix error:", error);
        return sendError(res, error, "Failed to fetch zone matrix");
    }
}
async function createPlan(req, res) {
    try {
        const input = pricing_shared_1.createTariffPlanSchema.parse(req.body);
        const plan = await (0, pricingRepo_1.createTariffPlan)(input);
        return res.status(201).json(plan);
    }
    catch (error) {
        console.error("createPlan error:", error);
        return sendError(res, error, "Failed to create tariff plan");
    }
}
async function getPlans(req, res) {
    try {
        const query = pricing_shared_1.listTariffPlansQuerySchema.parse(req.query);
        const plans = await (0, pricingRepo_1.listTariffPlans)(query);
        return res.json(plans);
    }
    catch (error) {
        console.error("getPlans error:", error);
        return sendError(res, error, "Failed to fetch tariff plans");
    }
}
async function getPlan(req, res) {
    try {
        const { id } = pricing_shared_1.tariffPlanIdParamSchema.parse(req.params);
        const plan = await (0, pricingRepo_1.getTariffPlanById)(id);
        if (!plan) {
            return res.status(404).json({ error: "Tariff plan not found" });
        }
        return res.json(plan);
    }
    catch (error) {
        console.error("getPlan error:", error);
        return sendError(res, error, "Failed to fetch tariff plan");
    }
}
async function updatePlan(req, res) {
    try {
        const { id } = pricing_shared_1.tariffPlanIdParamSchema.parse(req.params);
        const input = pricing_shared_1.updateTariffPlanSchema.parse(req.body);
        const plan = await (0, pricingRepo_1.updateTariffPlan)(id, input);
        return res.json(plan);
    }
    catch (error) {
        console.error("updatePlan error:", error);
        return sendError(res, error, "Failed to update tariff plan");
    }
}
async function quotePlan(req, res) {
    try {
        const parsed = pricing_shared_1.quoteTariffSchema.parse(req.body);
        const input = req.user?.role === "customer"
            ? {
                ...parsed,
                customerEntityId: req.user.customerEntityId ?? null,
            }
            : parsed;
        const quote = await (0, pricingRepo_1.quoteTariff)(input);
        return res.json(quote);
    }
    catch (error) {
        console.error("quotePlan error:", error);
        return sendError(res, error, "Failed to quote tariff plan");
    }
}
