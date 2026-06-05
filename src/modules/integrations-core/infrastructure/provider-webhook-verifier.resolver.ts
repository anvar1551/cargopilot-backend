import prisma from "../../../config/prismaClient";
import type { WebhookProviderVerifierResolver } from "../application/webhook-gateway.types";
import { decryptIntegrationSecret } from "../application/integration-secret.crypto";
import { createHmacWebhookVerifier } from "./verifiers/hmac-webhook.verifier";

const db = prisma as any;

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}

function toObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function parseSecretPayload(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return { webhookSecret: raw };
  }
}

function pickString(source: unknown, keys: string[]) {
  const object = toObject(source);
  if (!object) return null;
  for (const key of keys) {
    const value = object[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" || typeof value === "bigint") return String(value);
  }
  return null;
}

function pickNumber(source: unknown, keys: string[]) {
  const value = pickString(source, keys);
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : null;
}

async function loadSecretConfig(secretRef: string | null) {
  if (!secretRef) return null;
  const row = await db.integrationProviderSecret.findUnique({
    where: { id: secretRef },
    select: { encryptedSecretJson: true },
  });
  if (!row?.encryptedSecretJson) return null;
  return parseSecretPayload(decryptIntegrationSecret(row.encryptedSecretJson));
}

export const providerWebhookVerifierResolver: WebhookProviderVerifierResolver = {
  async resolve(args) {
    const providerIdentifier = String(args.providerIdentifier || "").trim();
    if (!providerIdentifier) return null;
    if (!isUuid(providerIdentifier) && !String(args.companyHintId || "").trim()) {
      return null;
    }

    const provider = await db.integrationProvider.findFirst({
      where: isUuid(providerIdentifier)
        ? {
            id: providerIdentifier,
            status: "active",
          }
        : {
            providerCode: { equals: providerIdentifier, mode: "insensitive" },
            ...(args.companyHintId ? { companyId: args.companyHintId } : {}),
            status: "active",
          },
      orderBy: [{ updatedAt: "desc" }],
      select: {
        id: true,
        companyId: true,
        domain: true,
        providerCode: true,
        environment: true,
        secretRef: true,
      },
    });
    if (!provider) return null;

    const secretConfig = await loadSecretConfig(provider.secretRef);
    const secret =
      pickString(secretConfig, [
        "webhookSecret",
        "webhookSigningSecret",
        "signingSecret",
        "hmacSecret",
        "secret",
      ]) ?? null;
    if (!secret) return null;

    const verifier = createHmacWebhookVerifier({
      providerCode: provider.providerCode,
      secret,
      signatureHeaderName:
        pickString(secretConfig, ["webhookSignatureHeader", "signatureHeaderName"]) ?? undefined,
      timestampHeaderName:
        pickString(secretConfig, ["webhookTimestampHeader", "timestampHeaderName"]) ?? undefined,
      maxSkewSeconds:
        pickNumber(secretConfig, ["webhookMaxSkewSeconds", "maxSkewSeconds"]) ?? undefined,
    });

    return {
      providerId: provider.id,
      companyId: provider.companyId,
      providerCode: provider.providerCode,
      domain: provider.domain,
      environment: provider.environment,
      verifier,
    };
  },
};
