import { Prisma } from "@prisma/client";
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
        companyHintId: normalizeString(input.companyHintId) ?? providerVerifier.companyId,
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

      const duplicate = await args.events.hasProcessed({
        providerId: providerVerifier.providerId,
        providerEventId,
      });
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
          headersJson: input.headers,
          ipAddress: normalizeString(input.ipAddress),
          userAgent: normalizeString(input.userAgent),
          receivedAt: new Date().toISOString(),
          signatureVerified: true,
        });

        await args.events.saveCanonicalEvent({
          webhookEventId: rawRecord.webhookEventId,
          canonical: {
            ...canonical,
            providerCode: providerVerifier.providerCode,
            eventId: providerEventId,
            companyId: canonical.companyId ?? providerVerifier.companyId,
          },
        });

        await args.canonicalEvents?.enqueue({
          source: "inbound_webhook",
          companyId: canonical.companyId ?? providerVerifier.companyId,
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
