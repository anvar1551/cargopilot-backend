"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.envWebhookVerifierRegistry = void 0;
exports.createEnvWebhookVerifierRegistry = createEnvWebhookVerifierRegistry;
const hmac_webhook_verifier_1 = require("./verifiers/hmac-webhook.verifier");
const JSON_SECRETS_ENV = "INTEGRATION_WEBHOOK_SECRETS_JSON";
const PROVIDER_SECRET_PREFIX = "INTEGRATION_WEBHOOK_SECRET_";
const SIGNATURE_HEADER_PREFIX = "INTEGRATION_WEBHOOK_SIGNATURE_HEADER_";
const TIMESTAMP_HEADER_PREFIX = "INTEGRATION_WEBHOOK_TIMESTAMP_HEADER_";
function normalizeProviderCode(value) {
    return String(value || "").trim().toLowerCase();
}
function toEnvSuffix(providerCode) {
    return normalizeProviderCode(providerCode).replace(/[^a-z0-9]/g, "_").toUpperCase();
}
function readJsonSecretsMap() {
    const raw = String(process.env[JSON_SECRETS_ENV] || "").trim();
    if (!raw)
        return {};
    try {
        const parsed = JSON.parse(raw);
        const entries = Object.entries(parsed || {});
        const mapped = {};
        for (const [key, value] of entries) {
            const providerCode = normalizeProviderCode(key);
            const secret = String(value || "").trim();
            if (!providerCode || !secret)
                continue;
            mapped[providerCode] = secret;
        }
        return mapped;
    }
    catch {
        return {};
    }
}
function resolveProviderSecret(providerCode) {
    const suffix = toEnvSuffix(providerCode);
    const direct = String(process.env[`${PROVIDER_SECRET_PREFIX}${suffix}`] || "").trim();
    if (direct)
        return direct;
    const jsonMap = readJsonSecretsMap();
    return String(jsonMap[normalizeProviderCode(providerCode)] || "").trim() || null;
}
function resolveSignatureHeader(providerCode) {
    const suffix = toEnvSuffix(providerCode);
    const providerHeader = String(process.env[`${SIGNATURE_HEADER_PREFIX}${suffix}`] || "").trim();
    if (providerHeader)
        return providerHeader.toLowerCase();
    return String(process.env.INTEGRATION_WEBHOOK_SIGNATURE_HEADER || "").trim().toLowerCase() || undefined;
}
function resolveTimestampHeader(providerCode) {
    const suffix = toEnvSuffix(providerCode);
    const providerHeader = String(process.env[`${TIMESTAMP_HEADER_PREFIX}${suffix}`] || "").trim();
    if (providerHeader)
        return providerHeader.toLowerCase();
    return String(process.env.INTEGRATION_WEBHOOK_TIMESTAMP_HEADER || "").trim().toLowerCase() || undefined;
}
function resolveMaxSkewSeconds() {
    const value = Number(process.env.INTEGRATION_WEBHOOK_MAX_SKEW_SECONDS);
    if (!Number.isFinite(value) || value <= 0)
        return 300;
    return Math.round(value);
}
function createEnvWebhookVerifierRegistry() {
    const cache = new Map();
    const maxSkewSeconds = resolveMaxSkewSeconds();
    return {
        get(providerCode) {
            const normalized = normalizeProviderCode(providerCode);
            if (!normalized)
                return null;
            if (cache.has(normalized)) {
                return cache.get(normalized) ?? null;
            }
            const secret = resolveProviderSecret(normalized);
            if (!secret) {
                cache.set(normalized, null);
                return null;
            }
            const verifier = (0, hmac_webhook_verifier_1.createHmacWebhookVerifier)({
                providerCode: normalized,
                secret,
                signatureHeaderName: resolveSignatureHeader(normalized),
                timestampHeaderName: resolveTimestampHeader(normalized),
                maxSkewSeconds,
            });
            cache.set(normalized, verifier);
            return verifier;
        },
    };
}
exports.envWebhookVerifierRegistry = createEnvWebhookVerifierRegistry();
