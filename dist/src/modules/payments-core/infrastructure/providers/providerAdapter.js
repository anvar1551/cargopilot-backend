"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getPaymentProviderAdapter = getPaymentProviderAdapter;
exports.parsePaymentEnvironment = parsePaymentEnvironment;
const client_1 = require("@prisma/client");
const clickAdapter_1 = require("./clickAdapter");
const paymeAdapter_1 = require("./paymeAdapter");
const uzumAdapter_1 = require("./uzumAdapter");
class NotImplementedProviderAdapter {
    constructor(provider) {
        this.provider = provider;
    }
    async createPayment(_input) {
        return {
            rawResponse: { reason: `${this.provider} adapter is not implemented yet` },
        };
    }
    async getStatus(_input) {
        return { status: "pending", rawResponse: { reason: "not_implemented" } };
    }
    async refund(_input) {
        return {
            status: "failed",
            rawResponse: { reason: `${this.provider} adapter refund is not implemented yet` },
        };
    }
    async verifyWebhook(input) {
        const idempotencyKey = (typeof input.headers["x-idempotency-key"] === "string"
            ? input.headers["x-idempotency-key"]
            : undefined) ?? `${input.provider}:${Date.now()}`;
        return {
            isValid: false,
            idempotencyKey,
            rawEvent: input.body,
        };
    }
}
const adapters = new Map([
    [client_1.PaymentProvider.CLICK, new clickAdapter_1.ClickProviderAdapter()],
    [client_1.PaymentProvider.PAYME, new paymeAdapter_1.PaymeProviderAdapter()],
    [client_1.PaymentProvider.UZUM, new uzumAdapter_1.UzumProviderAdapter()],
    [client_1.PaymentProvider.STRIPE, new NotImplementedProviderAdapter(client_1.PaymentProvider.STRIPE)],
]);
function getPaymentProviderAdapter(provider) {
    return adapters.get(provider) ?? new NotImplementedProviderAdapter(provider);
}
function parsePaymentEnvironment(raw) {
    const text = String(raw ?? "").trim().toUpperCase();
    if (text === "PRODUCTION")
        return client_1.PaymentEnvironment.PRODUCTION;
    return client_1.PaymentEnvironment.TEST;
}
