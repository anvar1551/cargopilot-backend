import { webhookHeadersForStorage } from "../../../utils/webhookMetadata";
import { createHash } from "crypto";
import { authorityError } from "../../orders-core/domain/creation-authority";
import type {
  WebhookEventRepository,
  VerifiedWebhookIngress,
  VerifiedWebhookData,
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

const verified = new WeakMap<VerifiedWebhookIngress, VerifiedWebhookData>();
/** Does not issue evidence. Forged fields, copies and queue payloads cannot mint it. */
export function readVerifiedWebhookIngress(evidence: VerifiedWebhookIngress): VerifiedWebhookData {
  const data = evidence && verified.get(evidence);
  if (!data) throw authorityError("Verified webhook ingress required", 403);
  // Return a detached copy so a persistence consumer cannot change later retries.
  return JSON.parse(JSON.stringify(data)) as VerifiedWebhookData;
}

export function createWebhookGatewayService(args: {
  events: WebhookEventRepository;
  providerVerifiers: WebhookProviderVerifierResolver;
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

      const evidence = Object.freeze({}) as VerifiedWebhookIngress;
      verified.set(evidence, JSON.parse(JSON.stringify({
        provider: { providerId: providerVerifier.providerId, companyId: providerVerifier.companyId,
          providerCode: providerVerifier.providerCode, domain: providerVerifier.domain, environment: providerVerifier.environment },
        canonical: { ...canonical, companyId: providerVerifier.companyId, providerCode: providerVerifier.providerCode,
          eventId: providerEventId, signatureVerified: true, rawBodySha256: createHash("sha256").update(rawBody).digest("hex") },
        rawBody, headersJson: webhookHeadersForStorage(input.headers), ipAddress: normalizeString(input.ipAddress),
        receivedAt: new Date().toISOString(),
      })));
      const status = await args.events.persistVerified(evidence);
      return { status, eventId: providerEventId };
    },
  };
}
