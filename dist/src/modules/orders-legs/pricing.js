"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.listPricingComponents = listPricingComponents;
exports.createPricingComponent = createPricingComponent;
exports.seedInitialServiceChargePricing = seedInitialServiceChargePricing;
exports.resolvePayableTotalFromPricing = resolvePayableTotalFromPricing;
const client_1 = require("@prisma/client");
const prismaClient_1 = __importDefault(require("../../config/prismaClient"));
const analyticsOutbox_1 = require("../analytics-core/infrastructure/analyticsOutbox");
const shared_1 = require("../orders-core/shared");
const shared_2 = require("./shared");
const SUPPORTED_CURRENCY_CODES = new Set(["UZS", "USD", "CNY"]);
const SERVICE_CHARGE_REF_KEY = "system:service_charge";
const SERVICE_CHARGE_REF_KEY_PREFIX = `${SERVICE_CHARGE_REF_KEY}:leg:`;
async function listPricingComponents(orderId) {
    await (0, shared_2.ensureOrderExists)(orderId);
    return prismaClient_1.default.pricingComponent.findMany({
        where: { orderId },
        orderBy: [{ createdAt: "desc" }],
    });
}
async function createPricingComponent(orderId, input, actor) {
    await (0, shared_2.ensureOrderExists)(orderId);
    if (!Number.isFinite(input.amount)) {
        throw (0, shared_1.orderError)("amount must be a finite number", 400);
    }
    if (!input.currency || !input.currency.trim()) {
        throw (0, shared_1.orderError)("currency is required", 400);
    }
    const normalizedCurrency = input.currency.trim().toUpperCase();
    if (!SUPPORTED_CURRENCY_CODES.has(normalizedCurrency)) {
        throw (0, shared_1.orderError)("currency must be one of: UZS, USD, CNY", 400);
    }
    return prismaClient_1.default.$transaction(async (tx) => {
        if (input.orderLegId) {
            const leg = await tx.orderLeg.findFirst({
                where: { id: input.orderLegId, orderId },
                select: { id: true },
            });
            if (!leg) {
                throw (0, shared_1.orderError)("orderLegId is invalid for this order", 400);
            }
        }
        const created = await tx.pricingComponent.create({
            data: {
                orderId,
                orderLegId: input.orderLegId ?? null,
                componentType: input.componentType,
                source: input.source ?? client_1.PricingComponentSource.manual,
                description: input.description ?? null,
                amount: input.amount,
                currency: normalizedCurrency,
                fxRateSnapshot: input.fxRateSnapshot ?? null,
                baseCurrency: input.baseCurrency?.trim().toUpperCase() ?? null,
                baseAmount: input.baseAmount ?? null,
                referenceKey: input.referenceKey ?? null,
            },
        });
        await (0, analyticsOutbox_1.enqueueCargoPilotDomainEventsTx)(tx, [
            {
                type: "order_status_changed",
                tenantScope: (0, shared_2.resolveActorTenantScope)(actor),
                entityId: orderId,
                payload: {
                    source: "pricing_component_create",
                    pricingComponentId: created.id,
                    componentType: created.componentType,
                    currency: created.currency,
                    amount: String(created.amount),
                    actorId: actor?.id ?? null,
                    actorRole: null,
                },
            },
        ]);
        return created;
    });
}
function decimalToNumber(value) {
    if (value == null)
        return 0;
    if (typeof value === "number")
        return value;
    if (typeof value === "string") {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : 0;
    }
    const asString = typeof value.toString === "function"
        ? value.toString()
        : "";
    const parsed = Number(asString);
    return Number.isFinite(parsed) ? parsed : 0;
}
function roundTo2(value) {
    return Math.round((value + Number.EPSILON) * 100) / 100;
}
function toMinorUnits(amount) {
    return Math.round((amount + Number.EPSILON) * 100);
}
function toMajorUnits(minor) {
    return roundTo2(minor / 100);
}
function buildSystemLegTemplates(serviceType, route) {
    const originCountry = route?.originCountryCode ?? null;
    const destinationCountry = route?.destinationCountryCode ?? null;
    const linehaulMode = route?.linehaulMode ?? client_1.TransportMode.road;
    const pickup = {
        kind: "pickup",
        sequence: 1,
        mode: client_1.TransportMode.road,
        fromCountry: originCountry,
        toCountry: originCountry,
        componentType: client_1.PricingComponentType.handling,
        description: "Pickup leg service charge allocation",
    };
    const linehaul = {
        kind: "linehaul",
        sequence: 2,
        mode: linehaulMode,
        fromCountry: originCountry,
        toCountry: destinationCountry,
        componentType: client_1.PricingComponentType.linehaul,
        description: "Linehaul leg service charge allocation",
    };
    const lastMile = {
        kind: "last_mile",
        sequence: 3,
        mode: client_1.TransportMode.road,
        fromCountry: destinationCountry,
        toCountry: destinationCountry,
        componentType: client_1.PricingComponentType.local_delivery,
        description: "Last-mile leg service charge allocation",
    };
    if (serviceType === client_1.ServiceType.DOOR_TO_POINT) {
        return [pickup, { ...linehaul, sequence: 2 }];
    }
    if (serviceType === client_1.ServiceType.POINT_TO_DOOR) {
        return [{ ...linehaul, sequence: 1 }, { ...lastMile, sequence: 2 }];
    }
    if (serviceType === client_1.ServiceType.POINT_TO_POINT) {
        return [{ ...linehaul, sequence: 1 }];
    }
    return [pickup, linehaul, lastMile];
}
function componentTypeForRouteTemplateLeg(leg) {
    const key = `${leg.legCode ?? ""} ${leg.label ?? ""}`.toLowerCase();
    if (key.includes("pickup"))
        return client_1.PricingComponentType.handling;
    if (key.includes("last") || key.includes("delivery")) {
        return client_1.PricingComponentType.local_delivery;
    }
    return client_1.PricingComponentType.linehaul;
}
async function loadRouteTemplateLegTemplates(tx, routeTemplateId) {
    if (!routeTemplateId)
        return null;
    const routeTemplate = await tx.routeTemplate.findFirst({
        where: {
            id: routeTemplateId,
            isActive: true,
        },
        include: {
            legs: {
                orderBy: [{ sequence: "asc" }, { createdAt: "asc" }],
            },
        },
    });
    if (!routeTemplate) {
        throw (0, shared_1.orderError)("routeTemplateId not found or inactive", 400);
    }
    if (!Array.isArray(routeTemplate.legs) || routeTemplate.legs.length === 0) {
        throw (0, shared_1.orderError)("route template has no legs", 400);
    }
    return routeTemplate.legs.map((leg) => ({
        kind: "route_template",
        sequence: leg.sequence,
        mode: leg.mode,
        routeTemplateId: routeTemplate.id,
        routeTemplateLegId: leg.id,
        legCode: leg.legCode,
        fromCountry: leg.originCountryCode ?? null,
        toCountry: leg.destinationCountryCode ?? null,
        componentType: componentTypeForRouteTemplateLeg(leg),
        description: `Route leg ${leg.sequence}: ${leg.label || leg.legCode}`,
    }));
}
function weightForLegKind(kind) {
    if (kind === "pickup")
        return 0.2;
    if (kind === "linehaul")
        return 0.5;
    if (kind === "route_template")
        return 1;
    return 0.3;
}
function splitMinorByWeights(totalMinor, weights) {
    if (weights.length === 0)
        return [];
    const safeWeights = weights.map((w) => (Number.isFinite(w) && w > 0 ? w : 0));
    const sum = safeWeights.reduce((acc, w) => acc + w, 0);
    if (sum <= 0) {
        const base = Math.floor(totalMinor / weights.length);
        const remainder = totalMinor - base * weights.length;
        return weights.map((_, idx) => base + (idx < remainder ? 1 : 0));
    }
    const raw = safeWeights.map((w) => (totalMinor * w) / sum);
    const floors = raw.map((v) => Math.floor(v));
    let remainder = totalMinor - floors.reduce((acc, v) => acc + v, 0);
    const fractions = raw
        .map((v, idx) => ({ idx, frac: v - floors[idx] }))
        .sort((a, b) => b.frac - a.frac);
    for (let i = 0; i < fractions.length && remainder > 0; i += 1) {
        floors[fractions[i].idx] += 1;
        remainder -= 1;
    }
    return floors;
}
async function seedInitialServiceChargePricing(orderId, input, actor) {
    await (0, shared_2.ensureOrderExists)(orderId);
    const amount = Number(input.serviceCharge ?? 0);
    if (!Number.isFinite(amount) || amount <= 0)
        return null;
    const normalizedCurrency = String(input.currency ?? "")
        .trim()
        .toUpperCase();
    if (!normalizedCurrency || !SUPPORTED_CURRENCY_CODES.has(normalizedCurrency)) {
        throw (0, shared_1.orderError)("currency must be one of: UZS, USD, CNY", 400);
    }
    return prismaClient_1.default.$transaction(async (tx) => {
        let legs = await tx.orderLeg.findMany({
            where: { orderId },
            orderBy: [{ sequence: "asc" }, { createdAt: "asc" }],
            select: {
                id: true,
                sequence: true,
                metadata: true,
            },
        });
        const templates = (await loadRouteTemplateLegTemplates(tx, input.routeTemplateId ?? null)) ??
            buildSystemLegTemplates(input.serviceType, {
                originCountryCode: input.originCountryCode ?? null,
                destinationCountryCode: input.destinationCountryCode ?? null,
                linehaulMode: input.linehaulMode ?? null,
            });
        if (legs.length === 0) {
            const created = await Promise.all(templates.map((template) => tx.orderLeg.create({
                data: {
                    orderId,
                    sequence: template.sequence,
                    mode: template.mode,
                    status: client_1.OrderLegStatus.planned,
                    routeTemplateId: template.routeTemplateId ?? null,
                    routeTemplateLegId: template.routeTemplateLegId ?? null,
                    fromCountry: template.fromCountry ?? null,
                    toCountry: template.toCountry ?? null,
                    notes: template.kind === "route_template"
                        ? `Route template leg: ${template.legCode ?? template.sequence}`
                        : `System leg: ${template.kind}`,
                    metadata: {
                        systemGenerated: true,
                        legKind: template.kind,
                        ...(template.routeTemplateId
                            ? { routeTemplateId: template.routeTemplateId }
                            : {}),
                        ...(template.routeTemplateLegId
                            ? { routeTemplateLegId: template.routeTemplateLegId }
                            : {}),
                        ...(template.legCode ? { legCode: template.legCode } : {}),
                    },
                },
                select: { id: true, sequence: true, metadata: true },
            })));
            legs = created.sort((a, b) => a.sequence - b.sequence);
        }
        const kindBySequence = new Map(templates.map((template) => [template.sequence, template]));
        const selectedLegs = legs
            .map((leg) => {
            const template = kindBySequence.get(leg.sequence);
            if (!template)
                return null;
            return { leg, template };
        })
            .filter((value) => Boolean(value));
        if (selectedLegs.length === 0) {
            throw (0, shared_1.orderError)("Unable to map order legs for pricing component generation", 400);
        }
        const totalMinor = toMinorUnits(amount);
        const candidateRuleAmounts = Array.isArray(input.perLegRuleAmountsMajor)
            ? input.perLegRuleAmountsMajor
            : [];
        const canUseRuleAmounts = candidateRuleAmounts.length === selectedLegs.length &&
            candidateRuleAmounts.every((value) => Number.isFinite(value) && value > 0);
        const weights = canUseRuleAmounts
            ? candidateRuleAmounts
            : selectedLegs.map((entry) => weightForLegKind(entry.template.kind));
        const splitMinor = splitMinorByWeights(totalMinor, weights);
        const pricingComponents = [];
        for (let i = 0; i < selectedLegs.length; i += 1) {
            const entry = selectedLegs[i];
            const legAmountMajor = toMajorUnits(splitMinor[i] ?? 0);
            const refKey = `${SERVICE_CHARGE_REF_KEY_PREFIX}${entry.leg.id}`;
            const existing = await tx.pricingComponent.findFirst({
                where: {
                    orderId,
                    referenceKey: refKey,
                    source: client_1.PricingComponentSource.rule,
                },
                select: { id: true },
            });
            const component = existing
                ? await tx.pricingComponent.update({
                    where: { id: existing.id },
                    data: {
                        orderLegId: entry.leg.id,
                        componentType: entry.template.componentType,
                        source: client_1.PricingComponentSource.rule,
                        description: entry.template.description,
                        amount: legAmountMajor,
                        currency: normalizedCurrency,
                        referenceKey: refKey,
                    },
                })
                : await tx.pricingComponent.create({
                    data: {
                        orderId,
                        orderLegId: entry.leg.id,
                        componentType: entry.template.componentType,
                        source: client_1.PricingComponentSource.rule,
                        description: entry.template.description,
                        amount: legAmountMajor,
                        currency: normalizedCurrency,
                        referenceKey: refKey,
                    },
                });
            pricingComponents.push(component);
        }
        await (0, analyticsOutbox_1.enqueueCargoPilotDomainEventsTx)(tx, [
            {
                type: "order_status_changed",
                tenantScope: (0, shared_2.resolveActorTenantScope)(actor),
                entityId: orderId,
                payload: {
                    source: "pricing_component_seed",
                    pricingComponentIds: pricingComponents.map((item) => item.id),
                    actorId: actor?.id ?? null,
                    actorRole: null,
                },
            },
        ]);
        return pricingComponents;
    });
}
async function resolvePayableTotalFromPricing(orderId) {
    await (0, shared_2.ensureOrderExists)(orderId);
    const items = await prismaClient_1.default.pricingComponent.findMany({
        where: { orderId },
        select: {
            amount: true,
            currency: true,
            baseAmount: true,
            baseCurrency: true,
        },
    });
    if (items.length === 0) {
        return null;
    }
    const originalCurrencies = new Set();
    const baseCurrencies = new Set();
    let originalTotal = 0;
    let baseTotal = 0;
    let hasBaseForAll = true;
    for (const item of items) {
        const originalCurrency = String(item.currency ?? "")
            .trim()
            .toUpperCase();
        if (!SUPPORTED_CURRENCY_CODES.has(originalCurrency)) {
            throw (0, shared_1.orderError)("Pricing component currency is not supported", 400);
        }
        originalCurrencies.add(originalCurrency);
        originalTotal += decimalToNumber(item.amount);
        const baseCurrency = String(item.baseCurrency ?? "")
            .trim()
            .toUpperCase();
        if (!item.baseAmount || !baseCurrency) {
            hasBaseForAll = false;
            continue;
        }
        if (!SUPPORTED_CURRENCY_CODES.has(baseCurrency)) {
            throw (0, shared_1.orderError)("Pricing component baseCurrency is not supported", 400);
        }
        baseCurrencies.add(baseCurrency);
        baseTotal += decimalToNumber(item.baseAmount);
    }
    if (originalCurrencies.size === 1) {
        const currency = Array.from(originalCurrencies)[0];
        const amountMajor = roundTo2(originalTotal);
        if (amountMajor <= 0) {
            throw (0, shared_1.orderError)("Calculated payable amount must be greater than zero", 400);
        }
        return {
            amountMajor,
            currency,
            source: "original",
            componentCount: items.length,
        };
    }
    if (hasBaseForAll && baseCurrencies.size === 1) {
        const currency = Array.from(baseCurrencies)[0];
        const amountMajor = roundTo2(baseTotal);
        if (amountMajor <= 0) {
            throw (0, shared_1.orderError)("Calculated payable amount must be greater than zero", 400);
        }
        return {
            amountMajor,
            currency,
            source: "base",
            componentCount: items.length,
        };
    }
    throw (0, shared_1.orderError)("Pricing components use mixed currencies without a single base currency snapshot", 400);
}
