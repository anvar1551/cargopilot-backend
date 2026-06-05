import type { IntegrationRequestContext, IntegrationResult } from "./types";

export type CarrierTransportMode =
  | "road"
  | "air"
  | "rail"
  | "sea"
  | "multimodal";

export type CarrierCreateShipmentInput = {
  externalOrderId: string;
  sender: { name: string; phone: string; address: string; lat?: number; lng?: number };
  receiver: { name: string; phone: string; address: string; lat?: number; lng?: number };
  parcels: Array<{ weightKg: number; quantity?: number; description?: string }>;
  declaredValueMinor?: bigint;
  currency?: string;
  transportMode?: CarrierTransportMode;
  serviceCode?: string;
  metadata?: Record<string, unknown>;
};

export type CarrierCreateShipmentResult = IntegrationResult<{
  partnerShipmentId: string;
  trackingNumber?: string;
  labelUrl?: string;
  rawResponse?: Record<string, unknown>;
}>;

export type CarrierTrackInput = {
  partnerShipmentId?: string;
  trackingNumber?: string;
};

export type CarrierTrackResult = IntegrationResult<{
  statusCode: string;
  statusLabel: string;
  happenedAt?: string;
  location?: string;
  rawResponse?: Record<string, unknown>;
}>;

export interface CarrierAdapter {
  readonly providerCode: string;
  readonly supportedModes: CarrierTransportMode[];
  createShipment(
    input: CarrierCreateShipmentInput,
    context: IntegrationRequestContext,
  ): Promise<CarrierCreateShipmentResult>;
  cancelShipment(
    input: { partnerShipmentId: string; reason?: string },
    context: IntegrationRequestContext,
  ): Promise<IntegrationResult>;
  track(input: CarrierTrackInput, context: IntegrationRequestContext): Promise<CarrierTrackResult>;
}

export type SmsSendInput = {
  to: string;
  text: string;
  templateCode?: string;
  metadata?: Record<string, unknown>;
};

export type SmsSendResult = IntegrationResult<{
  messageId: string;
  acceptedAt?: string;
  rawResponse?: Record<string, unknown>;
}>;

export interface SmsAdapter {
  readonly providerCode: string;
  send(input: SmsSendInput, context: IntegrationRequestContext): Promise<SmsSendResult>;
  getDeliveryStatus(
    input: { messageId: string },
    context: IntegrationRequestContext,
  ): Promise<IntegrationResult<{ status: string; deliveredAt?: string; rawResponse?: Record<string, unknown> }>>;
}

export type CanonicalWebhookEvent = {
  providerCode: string;
  eventId: string;
  eventType: string;
  occurredAt: string;
  companyId?: string | null;
  aggregateType?: string | null;
  aggregateId?: string | null;
  payload: Record<string, unknown>;
  signatureVerified: boolean;
  rawBodySha256: string;
};

export interface WebhookVerifier {
  readonly providerCode: string;
  verifyAndNormalize(input: {
    headers: Record<string, string | string[] | undefined>;
    rawBody: string;
    companyHintId?: string | null;
  }): Promise<IntegrationResult<CanonicalWebhookEvent>>;
}
