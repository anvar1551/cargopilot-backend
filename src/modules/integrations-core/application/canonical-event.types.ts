import type { IntegrationDomain } from "../domain/types";

export type IntegrationCanonicalEventSource = "outbound_response" | "inbound_webhook";
export type IntegrationCanonicalEventStatus =
  | "pending"
  | "processing"
  | "processed"
  | "failed"
  | "ignored";

export type IntegrationCanonicalEventRecord = {
  id: string;
  source: IntegrationCanonicalEventSource;
  status: IntegrationCanonicalEventStatus;
  companyId: string | null;
  providerId: string | null;
  webhookEventId: string | null;
  outboxId: string | null;
  domain: IntegrationDomain;
  providerCode: string;
  eventType: string;
  aggregateType: string | null;
  aggregateId: string | null;
  payloadJson: Record<string, unknown>;
  occurredAt: string;
  processAttempts: number;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
};

export type EnqueueIntegrationCanonicalEventInput = {
  source: IntegrationCanonicalEventSource;
  companyId?: string | null;
  providerId?: string | null;
  webhookEventId?: string | null;
  outboxId?: string | null;
  domain: IntegrationDomain;
  providerCode: string;
  eventType: string;
  aggregateType?: string | null;
  aggregateId?: string | null;
  payloadJson: Record<string, unknown>;
  occurredAt: string;
};

export interface IntegrationCanonicalEventRepository {
  enqueue(input: EnqueueIntegrationCanonicalEventInput): Promise<IntegrationCanonicalEventRecord>;
  claimBatch(args: { limit: number; staleProcessingBeforeIso?: string | null }): Promise<IntegrationCanonicalEventRecord[]>;
  markProcessed(id: string): Promise<void>;
  markIgnored(id: string, message?: string | null): Promise<void>;
  markFailed(id: string, message: string): Promise<void>;
}
