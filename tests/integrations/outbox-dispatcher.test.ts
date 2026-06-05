import type { IntegrationOutboxRecord } from "../../src/modules/integrations-core/application/outbox.types";
import type { IntegrationProviderRef } from "../../src/modules/integrations-core/domain/types";

function outboxRecord(): IntegrationOutboxRecord {
  const now = new Date().toISOString();
  return {
    id: "outbox_1",
    companyId: "company_1",
    providerId: "provider_1",
    providerCode: "fake_carrier",
    domain: "carrier",
    environment: "sandbox",
    eventType: "shipment.assigned",
    aggregateType: "shipment",
    aggregateId: "leg_1",
    operation: "create_shipment",
    status: "processing",
    maxAttempts: 10,
    attemptCount: 0,
    nextAttemptAt: now,
    lastAttemptAt: null,
    lastError: null,
    idempotencyKey: "carrier:create-shipment:leg_1:provider_1",
    payload: {
      eventId: "carrier:create-shipment:leg_1:provider_1",
      eventType: "shipment.assigned",
      occurredAt: now,
      companyId: "company_1",
      aggregateType: "shipment",
      aggregateId: "leg_1",
      schemaVersion: 1,
      source: "orders-core",
      payload: { action: "create_shipment" },
    },
    createdAt: now,
    updatedAt: now,
  };
}

function provider(status: IntegrationProviderRef["status"]): IntegrationProviderRef {
  const now = new Date().toISOString();
  return {
    providerId: "provider_1",
    companyId: "company_1",
    domain: "carrier",
    providerCode: "fake_carrier",
    status,
    environment: "sandbox",
    capabilities: [],
    rateLimitRps: null,
    timeoutMs: 1000,
    retryPolicyId: null,
    secretRef: null,
    createdAt: now,
    updatedAt: now,
  };
}

describe("integration outbox dispatcher guard", () => {
  beforeAll(() => {
    process.env.DATABASE_URL ||= "postgresql://user:pass@localhost:5432/cargopilot_test";
  });

  it("refuses missing providers", async () => {
    const { resolveIntegrationOutboxDispatcher } = await import(
      "../../src/modules/integrations-core/application/outbox-dispatcher"
    );
    const record = outboxRecord();
    const dispatcher = resolveIntegrationOutboxDispatcher(record, null);

    const result = await dispatcher.dispatch({
      record,
      provider: null,
      timeoutMs: 1000,
    });

    expect(result.sent).toBe(false);
    expect(result.message).toMatch(/provider/i);
  });

  it("refuses inactive providers without provider HTTP calls", async () => {
    const { resolveIntegrationOutboxDispatcher } = await import(
      "../../src/modules/integrations-core/application/outbox-dispatcher"
    );
    const record = outboxRecord();
    const inactive = provider("paused");
    const dispatcher = resolveIntegrationOutboxDispatcher(record, inactive);

    const result = await dispatcher.dispatch({
      record,
      provider: inactive,
      timeoutMs: 1000,
    });

    expect(result.sent).toBe(false);
    expect(result.message).toMatch(/provider/i);
  });
});
