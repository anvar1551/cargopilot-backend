"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.webhookEventRepository = void 0;
exports.buildCanonicalWebhookEvent = buildCanonicalWebhookEvent;
const crypto_1 = require("crypto");
const prismaClient_1 = __importDefault(require("../../../config/prismaClient"));
const db = prismaClient_1.default;
function toDate(value) {
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime()))
        return new Date();
    return parsed;
}
function inferDomain(eventType) {
    const normalized = String(eventType || "").toLowerCase();
    if (normalized.startsWith("carrier."))
        return "carrier";
    if (normalized.startsWith("sms."))
        return "sms";
    if (normalized.startsWith("payment."))
        return "payment";
    return "webhook_sink";
}
function sha256(input) {
    return (0, crypto_1.createHash)("sha256").update(input).digest("hex");
}
exports.webhookEventRepository = {
    async hasProcessed(args) {
        const existing = await db.integrationWebhookEvent.findFirst({
            where: {
                providerId: String(args.providerId || "").trim(),
                providerEventId: String(args.providerEventId || "").trim(),
            },
            select: { id: true },
        });
        return Boolean(existing?.id);
    },
    async saveRawEvent(args) {
        const row = await db.integrationWebhookEvent.create({
            data: {
                providerCode: String(args.providerCode || "").trim(),
                companyId: args.companyId,
                providerId: args.providerId,
                domain: args.domain,
                environment: args.environment,
                providerEventId: String(args.providerEventId || "").trim(),
                rawBody: args.rawBody,
                rawBodySha256: sha256(args.rawBody),
                headersJson: args.headersJson,
                ipAddress: args.ipAddress ?? null,
                userAgent: args.userAgent ?? null,
                receivedAt: toDate(args.receivedAt),
                signatureVerified: args.signatureVerified,
            },
        });
        return { webhookEventId: row.id };
    },
    async saveCanonicalEvent(args) {
        await db.integrationWebhookCanonicalEvent.create({
            data: {
                webhookEventId: args.webhookEventId,
                providerCode: args.canonical.providerCode,
                domain: inferDomain(args.canonical.eventType),
                eventType: args.canonical.eventType,
                occurredAt: toDate(args.canonical.occurredAt),
                companyId: args.canonical.companyId ?? null,
                aggregateType: args.canonical.aggregateType ?? null,
                aggregateId: args.canonical.aggregateId ?? null,
                payloadJson: args.canonical.payload,
            },
        });
        await db.integrationWebhookEvent.update({
            where: { id: args.webhookEventId },
            data: {
                processedAt: new Date(),
            },
        });
    },
};
function buildCanonicalWebhookEvent(input) {
    return {
        providerCode: input.providerCode,
        eventId: input.eventId,
        eventType: input.eventType,
        occurredAt: input.occurredAt,
        companyId: input.companyId ?? null,
        aggregateType: input.aggregateType ?? null,
        aggregateId: input.aggregateId ?? null,
        payload: input.payload,
        signatureVerified: Boolean(input.signatureVerified),
        rawBodySha256: input.rawBodySha256,
    };
}
