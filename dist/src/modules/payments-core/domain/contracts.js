"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.toCanonicalStatus = toCanonicalStatus;
const client_1 = require("@prisma/client");
function toCanonicalStatus(status) {
    switch (status) {
        case client_1.PaymentIntentStatus.REQUIRES_ACTION:
            return "requires_action";
        case client_1.PaymentIntentStatus.PROCESSING:
            return "processing";
        case client_1.PaymentIntentStatus.SUCCEEDED:
            return "succeeded";
        case client_1.PaymentIntentStatus.FAILED:
            return "failed";
        case client_1.PaymentIntentStatus.CANCELED:
            return "canceled";
        case client_1.PaymentIntentStatus.REFUNDED:
            return "refunded";
        case client_1.PaymentIntentStatus.PARTIALLY_REFUNDED:
            return "partially_refunded";
        case client_1.PaymentIntentStatus.PENDING:
        default:
            return "pending";
    }
}
