import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";

const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

function resolveKey(): Buffer {
  const seed = (process.env.PAYMENT_CONFIG_MASTER_KEY ?? process.env.AUTH_SECRET ?? "").trim();
  if (!seed) {
    throw new Error("PAYMENT_CONFIG_MASTER_KEY is required for payment secret encryption");
  }
  return createHash("sha256").update(seed).digest().subarray(0, KEY_BYTES);
}

export function maskSecret(raw: string) {
  const value = String(raw ?? "");
  if (!value) return "****";
  const tail = value.slice(-4);
  return `****${tail}`;
}

export function encryptSecret(raw: string): string {
  const key = resolveKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(raw, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString("base64");
}

export function decryptSecret(payload: string): string {
  const data = Buffer.from(payload, "base64");
  if (data.length <= IV_BYTES + TAG_BYTES) {
    throw new Error("Invalid encrypted secret payload");
  }
  const key = resolveKey();
  const iv = data.subarray(0, IV_BYTES);
  const tag = data.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const encrypted = data.subarray(IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
}
