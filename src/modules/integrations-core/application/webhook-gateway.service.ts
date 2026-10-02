import { webhookHeadersForStorage } from "../../../utils/webhookMetadata";
import { Prisma } from "@prisma/client";
import { createHash } from "crypto";
import { authorityError } from "../../orders-core/domain/creation-authority";
import type {
  EnqueueIntegrationCanonicalEventInput,
} from "./canonical-event.types";
import type {
  WebhookEventRepository,
  WebhookGatewayService,
  WebhookIngressInput,
  WebhookIngressResult,
  WebhookProviderVerifierResolver,
} from "./webhook-gateway.types";

function normalizeProviderCode(value: string) {
  return String(value || "").trim().toLowerCase();
}

function normalizeString(value: string | null | undefined) {
  const normalized = String(value || "").trim();
  return normalized.length > 0 ? normalized : null;
}

function isDuplicateWebhookError(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

export function createWebhookGatewayService(args: {
  events: WebhookEventRepository;
  providerVerifiers: WebhookProviderVerifierResolver;
  canonicalEvents?: {
    enqueue(input: EnqueueIntegrationCanonicalEventInput): Promise<unknown>;
  };
}): WebhookGatewayService {
  return {
    async ingest(input: WebhookIngressInput): Promise<WebhookIngressResult> {
      const providerIdentifier = normalizeProviderCode(input.providerCode);
      if (!providerIdentifier) {
        return {
          status: "rejected",
          message: "providerCode is required",
        };
      }

      const rawBody = String(input.rawBody || "");
      if (!rawBody.trim()) {
        return {
          status: "rejected",
          message: "rawBody is required",
        };
      }

      const providerVerifier = await args.providerVerifiers.resolve({
        providerIdentifier,
        companyHintId: normalizeString(input.companyHintId),
      });
      if (!providerVerifier) {
        return {
          status: "rejected",
          message: `No active provider webhook secret configured for '${providerIdentifier}'`,
        };
      }

      const verification = await providerVerifier.verifier.verifyAndNormalize({
        headers: input.headers,
        rawBody,
        companyHintId: providerVerifier.companyId,
      });

      if (!verification.ok || !verification.data) {
        return {
          status: "rejected",
          message: verification.message ?? "Webhook signature verification failed",
        };
      }

      const canonical = verification.data;
      const providerEventId = normalizeString(canonical.eventId);
      if (!providerEventId) {
        return {
          status: "rejected",
          message: "Webhook eventId is required",
        };
      }

      if (!args.canonicalEvents) throw Object.assign(authorityError("Webhook processing persistence unavailable", 503), { code: "WEBHOOK_INGRESS_INCOMPLETE" });
      const identity = {
        providerId: providerVerifier.providerId,
        providerEventId,
        companyId: providerVerifier.companyId, providerCode: providerVerifier.providerCode,
        domain: providerVerifier.domain, environment: providerVerifier.environment,
        rawBodySha256: createHash("sha256").update(rawBody).digest("hex"),
      };
      const duplicate = await args.events.hasProcessed(identity);
      if (duplicate) {
        return {
          status: "duplicate",
          eventId: providerEventId,
        };
      }

      try {
        const rawRecord = await args.events.saveRawEvent({
          companyId: providerVerifier.companyId,
          providerId: providerVerifier.providerId,
          providerCode: providerVerifier.providerCode,
          domain: providerVerifier.domain,
          environment: providerVerifier.environment,
          providerEventId,
          rawBody,
          headersJson: webhookHeadersForStorage(input.headers),
          ipAddress: normalizeString(input.ipAddress),
          userAgent: null,
          receivedAt: new Date().toISOString(),
          signatureVerified: true,
        });

        await args.events.saveCanonicalEvent({
          webhookEventId: rawRecord.webhookEventId,
          canonical: {
            ...canonical,
            providerCode: providerVerifier.providerCode,
            eventId: providerEventId,
            companyId: providerVerifier.companyId,
          },
        });

        await args.canonicalEvents.enqueue({
          source: "inbound_webhook",
          companyId: providerVerifier.companyId,
          providerId: providerVerifier.providerId,
          webhookEventId: rawRecord.webhookEventId,
          domain: providerVerifier.domain,
          providerCode: providerVerifier.providerCode,
          eventType: canonical.eventType,
          aggregateType: canonical.aggregateType ?? null,
          aggregateId: canonical.aggregateId ?? null,
          payloadJson: canonical.payload,
          occurredAt: canonical.occurredAt,
        });
      } catch (error) {
        if (isDuplicateWebhookError(error)) {
          // A racing raw insert may commit before normalization/pending persistence.
          // Never acknowledge that intermediate state as a successfully accepted event.
          if (!await args.events.hasProcessed(identity))
            throw Object.assign(authorityError("Webhook processing persistence incomplete", 503), { code: "WEBHOOK_INGRESS_INCOMPLETE" });
          return {
            status: "duplicate",
            eventId: providerEventId,
          };
        }
        throw error;
      }

      return {
        status: "accepted",
        eventId: providerEventId,
      };
    },
  };
}
