import { createHash, createHmac, timingSafeEqual } from "crypto";
import { parse as parseQueryString } from "querystring";
import type { CanonicalWebhookEvent, WebhookVerifier } from "../../domain/ports";
import type { IntegrationResult } from "../../domain/types";

function normalizeProviderCode(value: string) {
  return String(value || "").trim().toLowerCase();
}

function pickHeader(
  headers: Record<string, string | string[] | undefined>,
  candidates: string[],
): string | null {
  for (const name of candidates) {
    const headerValue = headers[name];
    if (Array.isArray(headerValue)) {
      const first = headerValue.find((value) => String(value || "").trim().length > 0);
      if (first) return String(first).trim();
      continue;
    }
    if (typeof headerValue === "string" && headerValue.trim()) return headerValue.trim();
  }
  return null;
}

function parsePayload(rawBody: string): Record<string, unknown> {
  const trimmed = rawBody.trim();
  if (!trimmed) return {};
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    const parsed = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    return parsed as Record<string, unknown>;
  }
  return parseQueryString(trimmed) as Record<string, unknown>;
}

function pickString(
  payload: Record<string, unknown>,
  keys: string[],
): string | null {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" || typeof value === "bigint") return String(value);
  }
  return null;
}

function toIsoOrNow(value: string | null) {
  if (!value) return new Date().toISOString();
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return new Date().toISOString();
  return parsed.toISOString();
}

function normalizeProvidedSignature(rawSignature: string) {
  const trimmed = rawSignature.trim();
  if (!trimmed) return "";
  const v1Token = trimmed
    .split(",")
    .map((item) => item.trim())
    .find((item) => item.startsWith("v1="));
  if (v1Token) return v1Token.slice(3).trim();
  if (trimmed.startsWith("sha256=")) return trimmed.slice("sha256=".length).trim();
  return trimmed;
}

function signaturesEqual(expectedHex: string, providedSignature: string) {
  const normalized = normalizeProvidedSignature(providedSignature);
  if (!normalized) return false;

  const hexPattern = /^[a-fA-F0-9]+$/;
  if (hexPattern.test(normalized) && normalized.length === expectedHex.length) {
    const expected = Buffer.from(expectedHex.toLowerCase(), "hex");
    const provided = Buffer.from(normalized.toLowerCase(), "hex");
    if (expected.length !== provided.length) return false;
    return timingSafeEqual(expected, provided);
  }

  const expectedBase64 = Buffer.from(expectedHex, "hex").toString("base64");
  const expected = Buffer.from(expectedBase64, "utf8");
  const provided = Buffer.from(normalized, "utf8");
  if (expected.length !== provided.length) return false;
  return timingSafeEqual(expected, provided);
}

function buildSignedPayload(rawBody: string, timestamp: string | null) {
  if (!timestamp) return rawBody;
  return `${timestamp}.${rawBody}`;
}

export function createHmacWebhookVerifier(args: {
  providerCode: string;
  secret: string;
  signatureHeaderName?: string;
  timestampHeaderName?: string;
  maxSkewSeconds?: number;
}): WebhookVerifier {
  const providerCode = normalizeProviderCode(args.providerCode);
  const secret = String(args.secret || "");
  const signatureHeaderName =
    String(args.signatureHeaderName || "").trim().toLowerCase() || "x-signature";
  const timestampHeaderName =
    String(args.timestampHeaderName || "").trim().toLowerCase() || "x-signature-timestamp";
  const maxSkewSeconds = Number.isFinite(args.maxSkewSeconds)
    ? Math.max(1, Number(args.maxSkewSeconds))
    : 300;

  return {
    providerCode,
    async verifyAndNormalize(
      input,
    ): Promise<IntegrationResult<CanonicalWebhookEvent>> {
      if (!secret.trim()) {
        return {
          ok: false,
          retryable: false,
          message: "Webhook secret is not configured",
        };
      }

      const signature = pickHeader(input.headers, [
        signatureHeaderName,
        "x-webhook-signature",
        `${providerCode}-signature`,
      ]);
      if (!signature) {
        return {
          ok: false,
          retryable: false,
          message: "Signature header is missing",
        };
      }

      const timestamp = pickHeader(input.headers, [timestampHeaderName, "x-timestamp"]);
      if (timestamp) {
        const epoch = Number(timestamp);
        if (Number.isFinite(epoch)) {
          const eventMs = epoch > 1_000_000_000_000 ? epoch : epoch * 1000;
          const skewSeconds = Math.abs(Date.now() - eventMs) / 1000;
          if (skewSeconds > maxSkewSeconds) {
            return {
              ok: false,
              retryable: false,
              message: "Webhook timestamp is outside allowed drift window",
            };
          }
        }
      }

      const signedPayload = buildSignedPayload(input.rawBody, timestamp);
      const expectedHex = createHmac("sha256", secret).update(signedPayload).digest("hex");
      if (!signaturesEqual(expectedHex, signature)) {
        return {
          ok: false,
          retryable: false,
          message: "Webhook signature mismatch",
        };
      }

      let payload: Record<string, unknown>;
      try {
        payload = parsePayload(input.rawBody);
      } catch {
        return {
          ok: false,
          retryable: false,
          message: "Webhook payload is not valid JSON/form data",
        };
      }

      const eventId =
        pickString(payload, ["eventId", "event_id", "id", "webhookEventId"]) ??
        createHash("sha256").update(input.rawBody).digest("hex");
      const eventType =
        pickString(payload, ["eventType", "event_type", "type"]) ??
        `${providerCode}.event`;
      const occurredAt = toIsoOrNow(
        pickString(payload, ["occurredAt", "occurred_at", "createdAt", "timestamp"]),
      );
      const companyId =
        input.companyHintId ??
        pickString(payload, ["companyId", "company_id", "orgId", "organizationId"]);

      return {
        ok: true,
        retryable: false,
        data: {
          providerCode,
          eventId,
          eventType,
          occurredAt,
          companyId: companyId ?? null,
          aggregateType:
            pickString(payload, ["aggregateType", "aggregate_type", "resource", "entity"]) ??
            null,
          aggregateId:
            pickString(payload, [
              "aggregateId",
              "aggregate_id",
              "resourceId",
              "resource_id",
              "entityId",
              "entity_id",
              "orderId",
              "order_id",
              "shipmentId",
              "shipment_id",
              "paymentIntentId",
              "payment_intent_id",
            ]) ?? null,
          payload,
          signatureVerified: true,
          rawBodySha256: createHash("sha256").update(input.rawBody).digest("hex"),
        },
      };
    },
  };
}
