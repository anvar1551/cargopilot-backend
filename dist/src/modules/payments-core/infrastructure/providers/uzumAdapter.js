"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.UzumProviderAdapter = void 0;
const client_1 = require("@prisma/client");
const money_1 = require("../../shared/money");
function parseRecord(input) {
    if (!input)
        return {};
    if (typeof input === "string") {
        try {
            return JSON.parse(input);
        }
        catch {
            return {};
        }
    }
    if (typeof input === "object")
        return input;
    return {};
}
function readString(record, key) {
    const value = record[key];
    if (typeof value === "string")
        return value;
    if (typeof value === "number" || typeof value === "bigint")
        return String(value);
    return "";
}
function readNumber(record, key) {
    const text = readString(record, key);
    if (!text)
        return null;
    const parsed = Number(text);
    return Number.isFinite(parsed) ? parsed : null;
}
function verifyBasicAuth(headers, config) {
    const headerValue = headers.authorization ?? headers.Authorization;
    const auth = Array.isArray(headerValue) ? (headerValue[0] ?? "") : (headerValue ?? "");
    if (!auth.toLowerCase().startsWith("basic "))
        return false;
    try {
        const decoded = Buffer.from(auth.slice(6).trim(), "base64").toString("utf8");
        const [username, password] = decoded.split(":");
        if (!username || !password)
            return false;
        if (password !== config.secretPlain)
            return false;
        const allowedUsernames = [config.accountId, config.merchantId].filter(Boolean);
        if (allowedUsernames.length === 0)
            return true;
        return allowedUsernames.includes(username);
    }
    catch {
        return false;
    }
}
function detectStage(payload) {
    const explicit = readString(payload, "status").toUpperCase();
    if (explicit === "CREATED")
        return "CREATED";
    if (explicit === "CONFIRMED")
        return "CONFIRMED";
    if (explicit === "FAILED")
        return "FAILED";
    if (explicit === "CANCELED")
        return "CANCELED";
    // Fallback by payload shape from Merchant API:
    // confirm webhook contains paymentSource; create has params+amount.
    if (readString(payload, "paymentSource"))
        return "CONFIRMED";
    if (payload.params && readNumber(payload, "amount") !== null)
        return "CREATED";
    return "FAILED";
}
function mapStageToCanonical(stage) {
    switch (stage) {
        case "CONFIRMED":
            return "succeeded";
        case "CANCELED":
            return "canceled";
        case "FAILED":
            return "failed";
        case "CREATED":
        default:
            return "processing";
    }
}
function responseForStage(payload, stage) {
    const serviceId = readNumber(payload, "serviceId");
    const transId = readString(payload, "transId");
    const amount = readNumber(payload, "amount");
    const now = Date.now();
    if (stage === "CONFIRMED") {
        return {
            serviceId,
            transId,
            status: "CONFIRMED",
            confirmTime: now,
            amount,
        };
    }
    if (stage === "CREATED") {
        return {
            serviceId,
            transId,
            status: "CREATED",
            transTime: now,
            amount,
        };
    }
    return {
        serviceId,
        transId,
        status: stage,
        amount,
    };
}
class UzumProviderAdapter {
    constructor() {
        this.provider = client_1.PaymentProvider.UZUM;
    }
    async createPayment(input) {
        // Merchant API integration is callback-driven: bank app triggers partner webhooks.
        // We pre-create providerPaymentId for correlation and keep intent processing.
        return {
            providerPaymentId: input.intent.id,
            rawResponse: {
                mode: "merchant_webhook",
                provider: "uzum",
                note: "Awaiting Uzum callback flow",
                serviceId: input.config.serviceId,
                expectedAmountMinor: (0, money_1.formatProviderAmount)(input.intent.amountMinor, input.intent.currency, "UZUM"),
            },
        };
    }
    async getStatus(_input) {
        return {
            status: "pending",
            rawResponse: { reason: "uzum_status_pull_not_configured_use_webhook" },
        };
    }
    async refund(_input) {
        return {
            status: "failed",
            rawResponse: { reason: "uzum_refund_not_implemented" },
        };
    }
    async verifyWebhook(input) {
        const payload = parseRecord(input.body);
        const authOk = verifyBasicAuth(input.headers, input.config);
        const serviceId = readString(payload, "serviceId");
        const transId = readString(payload, "transId");
        const stage = detectStage(payload);
        const mappedStatus = authOk ? mapStageToCanonical(stage) : undefined;
        const idempotencyKey = transId || `${input.provider}:${Date.now()}`;
        const serviceMatch = !input.config.serviceId || !serviceId || input.config.serviceId === serviceId;
        const isValid = authOk && serviceMatch;
        return {
            isValid,
            idempotencyKey,
            mappedStatus,
            providerPaymentId: transId || undefined,
            externalEventId: transId || undefined,
            rawEvent: payload,
            responsePayload: isValid
                ? responseForStage(payload, stage)
                : { error: "Unauthorized or invalid service identifier" },
        };
    }
}
exports.UzumProviderAdapter = UzumProviderAdapter;
