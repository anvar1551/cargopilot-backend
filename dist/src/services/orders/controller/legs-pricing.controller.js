"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.listLegs = listLegs;
exports.upsertLeg = upsertLeg;
exports.listPricing = listPricing;
exports.createPricing = createPricing;
exports.listDocuments = listDocuments;
const client_1 = require("@prisma/client");
const prismaClient_1 = __importDefault(require("../../../config/prismaClient"));
const identity_access_1 = require("../../../modules/identity-access");
const orders_legs_1 = require("../../../modules/orders-legs");
const orderService_shared_1 = require("../orderService.shared");
function asEnumValue(value, allowed, fieldName) {
    if (value == null || value === "")
        return undefined;
    const asText = String(value).trim();
    if (allowed.includes(asText)) {
        return asText;
    }
    throw (0, orderService_shared_1.orderError)(`Invalid ${fieldName}: ${asText}`, 400);
}
function parseNumber(value, fieldName, required = false) {
    if (value == null || value === "") {
        if (required)
            throw (0, orderService_shared_1.orderError)(`${fieldName} is required`, 400);
        return undefined;
    }
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
        throw (0, orderService_shared_1.orderError)(`${fieldName} must be a number`, 400);
    }
    return parsed;
}
async function ensureManagerOrderReadAccess(req) {
    if (req.user?.role !== client_1.AppRole.manager)
        return null;
    const canReadOrders = await (0, identity_access_1.hasPermission)(req.user, "orders.read");
    if (!canReadOrders) {
        throw (0, orderService_shared_1.orderError)("Forbidden", 403);
    }
    return (0, identity_access_1.buildOrderScopeWhere)(req.user);
}
async function assertOrderInScope(req, orderId) {
    const scopeWhere = await ensureManagerOrderReadAccess(req);
    if (!scopeWhere)
        return;
    const order = await prismaClient_1.default.order.findFirst({
        where: { AND: [{ id: orderId }, scopeWhere] },
        select: { id: true },
    });
    if (!order) {
        throw (0, orderService_shared_1.orderError)("Order not found", 404);
    }
}
/** Lists multimodal legs for one order. */
async function listLegs(req, res) {
    try {
        if (req.user?.role !== client_1.AppRole.manager) {
            return res.status(403).json({ error: "Forbidden" });
        }
        await assertOrderInScope(req, req.params.id);
        const legs = await (0, orders_legs_1.listOrderLegs)(req.params.id);
        return res.json({ legs });
    }
    catch (err) {
        return res.status(err.statusCode ?? 500).json({ error: err.message ?? "Failed" });
    }
}
/** Creates a new leg or updates existing leg for one order. */
async function upsertLeg(req, res) {
    try {
        if (req.user?.role !== client_1.AppRole.manager) {
            return res.status(403).json({ error: "Forbidden" });
        }
        await assertOrderInScope(req, req.params.id);
        const actor = (0, orderService_shared_1.requireOrderActor)(req.user);
        const leg = await (0, orders_legs_1.upsertOrderLeg)(req.params.id, {
            legId: req.params.legId ?? req.body?.legId ?? null,
            sequence: parseNumber(req.body?.sequence, "sequence"),
            mode: asEnumValue(req.body?.mode, Object.values(client_1.TransportMode), "mode"),
            status: asEnumValue(req.body?.status, Object.values(client_1.OrderLegStatus), "status"),
            fromCountry: req.body?.fromCountry ?? undefined,
            toCountry: req.body?.toCountry ?? undefined,
            transitRoute: req.body?.transitRoute,
            fromWarehouseId: req.body?.fromWarehouseId ?? undefined,
            toWarehouseId: req.body?.toWarehouseId ?? undefined,
            carrierCode: req.body?.carrierCode ?? undefined,
            carrierRef: req.body?.carrierRef ?? undefined,
            vehicleRef: req.body?.vehicleRef ?? undefined,
            plannedDepartureAt: req.body?.plannedDepartureAt ?? undefined,
            plannedArrivalAt: req.body?.plannedArrivalAt ?? undefined,
            actualDepartureAt: req.body?.actualDepartureAt ?? undefined,
            actualArrivalAt: req.body?.actualArrivalAt ?? undefined,
            notes: req.body?.notes ?? undefined,
            metadata: req.body?.metadata,
        }, actor);
        return res.json({ leg });
    }
    catch (err) {
        return res.status(err.statusCode ?? 500).json({ error: err.message ?? "Failed" });
    }
}
/** Lists order pricing components (multi-currency ledger-style lines). */
async function listPricing(req, res) {
    try {
        if (req.user?.role !== client_1.AppRole.manager) {
            return res.status(403).json({ error: "Forbidden" });
        }
        await assertOrderInScope(req, req.params.id);
        const items = await (0, orders_legs_1.listPricingComponents)(req.params.id);
        return res.json({ items });
    }
    catch (err) {
        return res.status(err.statusCode ?? 500).json({ error: err.message ?? "Failed" });
    }
}
/** Creates one pricing component line for an order/leg. */
async function createPricing(req, res) {
    try {
        if (req.user?.role !== client_1.AppRole.manager) {
            return res.status(403).json({ error: "Forbidden" });
        }
        await assertOrderInScope(req, req.params.id);
        const actor = (0, orderService_shared_1.requireOrderActor)(req.user);
        const item = await (0, orders_legs_1.createPricingComponent)(req.params.id, {
            orderLegId: req.body?.orderLegId ?? undefined,
            componentType: asEnumValue(req.body?.componentType, Object.values(client_1.PricingComponentType), "componentType"),
            source: asEnumValue(req.body?.source, Object.values(client_1.PricingComponentSource), "source"),
            description: req.body?.description ?? undefined,
            amount: parseNumber(req.body?.amount, "amount", true),
            currency: String(req.body?.currency ?? "").trim(),
            fxRateSnapshot: parseNumber(req.body?.fxRateSnapshot, "fxRateSnapshot"),
            baseCurrency: req.body?.baseCurrency != null
                ? String(req.body.baseCurrency).trim()
                : undefined,
            baseAmount: parseNumber(req.body?.baseAmount, "baseAmount"),
            referenceKey: req.body?.referenceKey ?? undefined,
        }, actor);
        return res.status(201).json({ item });
    }
    catch (err) {
        return res.status(err.statusCode ?? 500).json({ error: err.message ?? "Failed" });
    }
}
/** Lists generated order documents (labels/manifests/route sheets/etc). */
async function listDocuments(req, res) {
    try {
        if (req.user?.role !== client_1.AppRole.manager) {
            return res.status(403).json({ error: "Forbidden" });
        }
        await assertOrderInScope(req, req.params.id);
        const type = asEnumValue(req.query?.type, Object.values(client_1.OrderDocumentType), "type");
        const limit = parseNumber(req.query?.limit, "limit");
        const items = await (0, orders_legs_1.listOrderDocuments)(req.params.id, {
            type: type ?? null,
            limit: limit ?? undefined,
        });
        return res.json({ items });
    }
    catch (err) {
        return res.status(err.statusCode ?? 500).json({ error: err.message ?? "Failed" });
    }
}
