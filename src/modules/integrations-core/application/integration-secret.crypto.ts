import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";

const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

function resolveKey(): Buffer {
  const seed = String(
    process.env.INTEGRATION_CONFIG_MASTER_KEY ||
      process.env.PAYMENT_CONFIG_MASTER_KEY ||
      process.env.AUTH_SECRET ||
      "",
  ).trim();
  if (!seed) {
    throw new Error(
      "INTEGRATION_CONFIG_MASTER_KEY is required for integration secret encryption",
    );
  }
  return createHash("sha256").update(seed).digest().subarray(0, KEY_BYTES);
}

export function maskSecret(raw: string) {
  const value = String(raw || "");
  if (!value) return "****";
  return `****${value.slice(-4)}`;
}

export function encryptIntegrationSecret(raw: string): string {
  const key = resolveKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(raw, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString("base64");
}

export function decryptIntegrationSecret(encrypted: string): string {
  const key = resolveKey();
  const payload = Buffer.from(String(encrypted || ""), "base64");
  if (payload.length <= IV_BYTES + TAG_BYTES) {
    throw new Error("Encrypted integration secret payload is invalid");
  }

  const iv = payload.subarray(0, IV_BYTES);
  const tag = payload.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const encryptedBody = payload.subarray(IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encryptedBody), decipher.final()]).toString("utf8");
}

export function summarizeSecretPayload(payload: unknown) {
  if (typeof payload === "string") {
    return maskSecret(payload);
  }
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const keys = Object.keys(payload as Record<string, unknown>).slice(0, 8);
    return `{keys:${keys.join(",")}}`;
  }
  return "****";
}

export function secretPayloadToString(payload: unknown) {
  if (typeof payload === "string") return payload;
  return JSON.stringify(payload ?? {});
}
