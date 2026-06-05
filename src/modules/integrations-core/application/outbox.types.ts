import type { IntegrationAttempt } from "../domain/types";
import type { IntegrationEventEnvelope } from "./integration-event.types";

export type OutboxStatus = "pending" | "processing" | "sent" | "failed" | "dead_letter";

export type IntegrationOutboxRecord = {
  id: string;
  companyId: string;
  providerId: string | null;
  providerCode: string;
  domain: "carrier" | "sms" | "payment" | "webhook_sink";
  environment: "sandbox" | "production";
  eventType: IntegrationEventEnvelope["eventType"];
  aggregateType: string | null;
  aggregateId: string | null;
  operation: string | null;
  status: OutboxStatus;
  maxAttempts: number;
  attemptCount: number;
  nextAttemptAt: string;
  lastAttemptAt: string | null;
  lastError: string | null;
  idempotencyKey: string;
  payload: IntegrationEventEnvelope;
  createdAt: string;
  updatedAt: string;
};

export type OutboxDispatchResult = {
  sent: boolean;
  retryable: boolean;
  providerRequestId?: string | null;
  statusCode?: number | null;
  message?: string;
  requestJson?: Record<string, unknown> | null;
  responseJson?: Record<string, unknown> | null;
};

export interface IntegrationOutboxRepository {
  enqueue(record: Omit<IntegrationOutboxRecord, "id" | "createdAt" | "updatedAt">): Promise<IntegrationOutboxRecord>;
  claimBatch(args: {
    limit: number;
    nowIso: string;
    staleProcessingBeforeIso?: string | null;
  }): Promise<IntegrationOutboxRecord[]>;
  markSent(id: string, attempt: IntegrationAttempt): Promise<void>;
  markRetry(id: string, attempt: IntegrationAttempt, nextAttemptAt: string): Promise<void>;
  markDeadLetter(id: string, attempt: IntegrationAttempt): Promise<void>;
}
