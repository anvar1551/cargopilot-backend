"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.maskSecret = maskSecret;
exports.encryptIntegrationSecret = encryptIntegrationSecret;
exports.decryptIntegrationSecret = decryptIntegrationSecret;
exports.summarizeSecretPayload = summarizeSecretPayload;
exports.secretPayloadToString = secretPayloadToString;
const crypto_1 = require("crypto");
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
function resolveKey() {
    const seed = String(process.env.INTEGRATION_CONFIG_MASTER_KEY ||
        process.env.PAYMENT_CONFIG_MASTER_KEY ||
        process.env.AUTH_SECRET ||
        "").trim();
    if (!seed) {
        throw new Error("INTEGRATION_CONFIG_MASTER_KEY is required for integration secret encryption");
    }
    return (0, crypto_1.createHash)("sha256").update(seed).digest().subarray(0, KEY_BYTES);
}
function maskSecret(raw) {
    const value = String(raw || "");
    if (!value)
        return "****";
    return `****${value.slice(-4)}`;
}
function encryptIntegrationSecret(raw) {
    const key = resolveKey();
    const iv = (0, crypto_1.randomBytes)(IV_BYTES);
    const cipher = (0, crypto_1.createCipheriv)("aes-256-gcm", key, iv);
    const encrypted = Buffer.concat([cipher.update(raw, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, encrypted]).toString("base64");
}
function decryptIntegrationSecret(encrypted) {
    const key = resolveKey();
    const payload = Buffer.from(String(encrypted || ""), "base64");
    if (payload.length <= IV_BYTES + TAG_BYTES) {
        throw new Error("Encrypted integration secret payload is invalid");
    }
    const iv = payload.subarray(0, IV_BYTES);
    const tag = payload.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
    const encryptedBody = payload.subarray(IV_BYTES + TAG_BYTES);
    const decipher = (0, crypto_1.createDecipheriv)("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(encryptedBody), decipher.final()]).toString("utf8");
}
function summarizeSecretPayload(payload) {
    if (typeof payload === "string") {
        return maskSecret(payload);
    }
    if (payload && typeof payload === "object" && !Array.isArray(payload)) {
        const keys = Object.keys(payload).slice(0, 8);
        return `{keys:${keys.join(",")}}`;
    }
    return "****";
}
function secretPayloadToString(payload) {
    if (typeof payload === "string")
        return payload;
    return JSON.stringify(payload ?? {});
}
