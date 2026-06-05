import type { WebhookVerifier } from "../domain/ports";
import type { WebhookVerifierRegistry } from "../application/webhook-gateway.types";
import { createHmacWebhookVerifier } from "./verifiers/hmac-webhook.verifier";

const JSON_SECRETS_ENV = "INTEGRATION_WEBHOOK_SECRETS_JSON";
const PROVIDER_SECRET_PREFIX = "INTEGRATION_WEBHOOK_SECRET_";
const SIGNATURE_HEADER_PREFIX = "INTEGRATION_WEBHOOK_SIGNATURE_HEADER_";
const TIMESTAMP_HEADER_PREFIX = "INTEGRATION_WEBHOOK_TIMESTAMP_HEADER_";

function normalizeProviderCode(value: string) {
  return String(value || "").trim().toLowerCase();
}

function toEnvSuffix(providerCode: string) {
  return normalizeProviderCode(providerCode).replace(/[^a-z0-9]/g, "_").toUpperCase();
}

function readJsonSecretsMap() {
  const raw = String(process.env[JSON_SECRETS_ENV] || "").trim();
  if (!raw) return {} as Record<string, string>;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const entries = Object.entries(parsed || {});
    const mapped: Record<string, string> = {};
    for (const [key, value] of entries) {
      const providerCode = normalizeProviderCode(key);
      const secret = String(value || "").trim();
      if (!providerCode || !secret) continue;
      mapped[providerCode] = secret;
    }
    return mapped;
  } catch {
    return {};
  }
}

function resolveProviderSecret(providerCode: string) {
  const suffix = toEnvSuffix(providerCode);
  const direct = String(process.env[`${PROVIDER_SECRET_PREFIX}${suffix}`] || "").trim();
  if (direct) return direct;
  const jsonMap = readJsonSecretsMap();
  return String(jsonMap[normalizeProviderCode(providerCode)] || "").trim() || null;
}

function resolveSignatureHeader(providerCode: string) {
  const suffix = toEnvSuffix(providerCode);
  const providerHeader = String(process.env[`${SIGNATURE_HEADER_PREFIX}${suffix}`] || "").trim();
  if (providerHeader) return providerHeader.toLowerCase();
  return String(process.env.INTEGRATION_WEBHOOK_SIGNATURE_HEADER || "").trim().toLowerCase() || undefined;
}

function resolveTimestampHeader(providerCode: string) {
  const suffix = toEnvSuffix(providerCode);
  const providerHeader = String(process.env[`${TIMESTAMP_HEADER_PREFIX}${suffix}`] || "").trim();
  if (providerHeader) return providerHeader.toLowerCase();
  return String(process.env.INTEGRATION_WEBHOOK_TIMESTAMP_HEADER || "").trim().toLowerCase() || undefined;
}

function resolveMaxSkewSeconds() {
  const value = Number(process.env.INTEGRATION_WEBHOOK_MAX_SKEW_SECONDS);
  if (!Number.isFinite(value) || value <= 0) return 300;
  return Math.round(value);
}

export function createEnvWebhookVerifierRegistry(): WebhookVerifierRegistry {
  const cache = new Map<string, WebhookVerifier | null>();
  const maxSkewSeconds = resolveMaxSkewSeconds();

  return {
    get(providerCode) {
      const normalized = normalizeProviderCode(providerCode);
      if (!normalized) return null;
      if (cache.has(normalized)) {
        return cache.get(normalized) ?? null;
      }

      const secret = resolveProviderSecret(normalized);
      if (!secret) {
        cache.set(normalized, null);
        return null;
      }

      const verifier = createHmacWebhookVerifier({
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

export const envWebhookVerifierRegistry = createEnvWebhookVerifierRegistry();

