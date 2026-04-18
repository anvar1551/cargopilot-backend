"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildInitialOrderCashCollections = buildInitialOrderCashCollections;
const client_1 = require("@prisma/client");
function isPositiveNumber(value) {
    return typeof value === "number" && Number.isFinite(value) && value > 0;
}
function buildExpectedCollection(kind, amount, currency, actor) {
    return {
        kind,
        expectedAmount: amount,
        currency: currency ?? null,
        events: {
            create: {
                eventType: client_1.CashCollectionEventType.expected,
                amount,
                note: kind === client_1.CashCollectionKind.cod
                    ? "COD expected for this order"
                    : "Service charge expected for this order",
                actorId: actor?.id ?? null,
                actorRole: actor?.role ?? null,
                toHolderType: client_1.CashHolderType.none,
                toHolderName: "Not collected yet",
            },
        },
    };
}
function buildInitialOrderCashCollections(input, actor) {
    const rows = [];
    if (isPositiveNumber(input.codAmount) &&
        input.codPaidStatus !== client_1.PaidStatus.PAID) {
        rows.push(buildExpectedCollection(client_1.CashCollectionKind.cod, input.codAmount, input.currency, actor));
    }
    if (isPositiveNumber(input.serviceCharge) &&
        input.serviceChargePaidStatus !== client_1.PaidStatus.PAID &&
        (input.deliveryChargePaidBy === client_1.PaidBy.SENDER ||
            input.deliveryChargePaidBy === client_1.PaidBy.RECIPIENT)) {
        rows.push(buildExpectedCollection(client_1.CashCollectionKind.service_charge, input.serviceCharge, input.currency, actor));
    }
    return rows;
}
