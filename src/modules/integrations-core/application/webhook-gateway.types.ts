import type { CanonicalWebhookEvent, WebhookVerifier } from "../domain/ports";

/** Opaque process-local verification evidence; only the gateway can issue it. */
export type VerifiedWebhookIngress = { readonly verifiedIngress: unique symbol };
export type VerifiedWebhookData = {
  provider: Omit<ResolvedWebhookProviderVerifier, "verifier">;
  canonical: CanonicalWebhookEvent;
  rawBody: string;
  headersJson: Record<string, string | string[] | undefined>;
  ipAddress: string | null;
  receivedAt: string;
};

export type WebhookProcessStatus = "accepted" | "duplicate" | "rejected";

export type WebhookIngressInput = {
  providerCode: string;
  headers: Record<string, string | string[] | undefined>;
  rawBody: string;
  ipAddress?: string | null;
  userAgent?: string | null;
  companyHintId?: string | null;
};

export type WebhookIngressResult = {
  status: WebhookProcessStatus;
  eventId?: string;
  message?: string;
};

export interface WebhookEventRepository {
  hasProcessed(args: {
    providerId: string;
    providerEventId: string;
    companyId: string;
    providerCode: string;
    domain: "carrier" | "sms" | "payment" | "webhook_sink";
    environment: "sandbox" | "production";
    rawBodySha256: string;
  }): Promise<boolean>;
  persistVerified(evidence: VerifiedWebhookIngress): Promise<"accepted" | "duplicate">;
}

export interface WebhookVerifierRegistry {
  get(providerCode: string): WebhookVerifier | null;
}

export type ResolvedWebhookProviderVerifier = {
  providerId: string;
  companyId: string;
  providerCode: string;
  domain: "carrier" | "sms" | "payment" | "webhook_sink";
  environment: "sandbox" | "production";
  verifier: WebhookVerifier;
};

export interface WebhookProviderVerifierResolver {
  resolve(args: {
    providerIdentifier: string;
    companyHintId?: string | null;
  }): Promise<ResolvedWebhookProviderVerifier | null>;
}

export interface WebhookGatewayService {
  ingest(input: WebhookIngressInput): Promise<WebhookIngressResult>;
}
