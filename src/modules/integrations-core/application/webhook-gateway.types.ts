import type { CanonicalWebhookEvent, WebhookVerifier } from "../domain/ports";

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
  }): Promise<boolean>;
  saveRawEvent(args: {
    companyId: string;
    providerId: string;
    providerCode: string;
    domain: "carrier" | "sms" | "payment" | "webhook_sink";
    environment: "sandbox" | "production";
    providerEventId: string;
    rawBody: string;
    headersJson: Record<string, string | string[] | undefined>;
    ipAddress?: string | null;
    userAgent?: string | null;
    receivedAt: string;
    signatureVerified: boolean;
  }): Promise<{ webhookEventId: string }>;
  saveCanonicalEvent(args: {
    webhookEventId: string;
    canonical: CanonicalWebhookEvent;
  }): Promise<void>;
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
