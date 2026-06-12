"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.autoBookCarrierForOrderLeg = autoBookCarrierForOrderLeg;
exports.autoBookCarrierForOrder = autoBookCarrierForOrder;
const prismaClient_1 = __importDefault(require("../../config/prismaClient"));
const carrier_routing_service_1 = require("../integrations-core/application/carrier-routing.service");
const carrier_booking_1 = require("./carrier-booking");
const db = prismaClient_1.default;
async function autoBookCarrierForOrderLeg(args) {
    const actor = args.actor ?? null;
    const companyId = String(args.actor?.companyId || "").trim();
    if (!actor || !companyId) {
        return { matched: false, booked: false, skippedReason: "company context missing" };
    }
    const leg = await db.orderLeg.findFirst({
        where: { id: args.legId, orderId: args.orderId },
        select: {
            id: true,
            carrierBookingStatus: true,
            carrierProviderId: true,
        },
    });
    if (!leg) {
        return { matched: false, booked: false, skippedReason: "leg not found" };
    }
    if (leg.carrierBookingStatus !== "not_requested") {
        return {
            matched: false,
            booked: false,
            skippedReason: `carrier booking already ${leg.carrierBookingStatus}`,
        };
    }
    const rule = await (0, carrier_routing_service_1.resolveCarrierRoutingRuleForOrderLeg)({
        companyId,
        orderId: args.orderId,
        legId: args.legId,
    });
    if (!rule) {
        return { matched: false, booked: false, skippedReason: "no active carrier routing rule matched" };
    }
    const ruleSummary = {
        id: rule.id,
        name: rule.name,
        providerId: rule.providerId,
        providerCode: rule.providerCode,
    };
    if (!rule.autoBook) {
        return {
            matched: true,
            booked: false,
            skippedReason: "matched rule has autoBook disabled",
            rule: ruleSummary,
        };
    }
    const booking = await (0, carrier_booking_1.bookCarrierForOrderLeg)({
        orderId: args.orderId,
        legId: args.legId,
        providerId: rule.providerId,
        actor,
    });
    return {
        matched: true,
        booked: true,
        rule: ruleSummary,
        booking,
    };
}
async function autoBookCarrierForOrder(args) {
    const legs = await db.orderLeg.findMany({
        where: { orderId: args.orderId },
        orderBy: [{ sequence: "asc" }, { createdAt: "asc" }],
        select: { id: true },
    });
    const results = [];
    for (const leg of legs) {
        results.push(await autoBookCarrierForOrderLeg({
            orderId: args.orderId,
            legId: leg.id,
            actor: args.actor,
        }));
    }
    return results;
}
