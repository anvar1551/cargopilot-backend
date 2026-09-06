jest.mock("../../src/config/prismaClient", () => ({ __esModule: true, default: require("../security/fixtures").database }));
jest.mock("../../src/modules/integrations-core/application/integration-http-client", () => ({
  ...jest.requireActual("../../src/modules/integrations-core/application/integration-http-client"),
  integrationHttpJson: jest.fn(),
}));
import { integrationHttpJson } from "../../src/modules/integrations-core/application/integration-http-client";
import type { IntegrationOutboxRecord } from "../../src/modules/integrations-core/application/outbox.types";
import type { IntegrationProviderRef } from "../../src/modules/integrations-core/domain/types";

it.each([["ECAPACITY", true], ["EDESTINATION", false], ["ELIMIT", false], ["EREDIRECT", false]])("preserves %s retryability with the real classifier and no immediate replay", async (code, retryable) => {
  const { resolveIntegrationOutboxDispatcher } = await import("../../src/modules/integrations-core/application/outbox-dispatcher");
  const record = outboxRecord(); record.domain = "webhook_sink";
  record.payload = { endpointUrl: "https://sink.example.test", body: {} } as any;
  const configured = provider("active"); configured.domain = "webhook_sink";
  const transport = integrationHttpJson as jest.Mock;
  // Explicit permanent codes take precedence over legacy message-based timeout matching.
  transport.mockReset().mockRejectedValue(Object.assign(new Error("timeout-like diagnostic"), { code }));
  const result = await resolveIntegrationOutboxDispatcher(record, configured).dispatch({ record, provider: configured, timeoutMs: 1000 });
  expect(result).toMatchObject({ sent: false, retryable, statusCode: null });
  expect(transport).toHaveBeenCalledTimes(1);
});

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

it("passes webhook-sink requests through the guarded transport using the resolved provider identity", async () => {
  const { resolveIntegrationOutboxDispatcher } = await import("../../src/modules/integrations-core/application/outbox-dispatcher");
  const record = outboxRecord(); record.domain = "webhook_sink"; record.payload = { endpointUrl: "https://sink.example.test/path?private=value", body: {} } as any;
  const configured = provider("active"); configured.domain = "webhook_sink";
  (integrationHttpJson as jest.Mock).mockResolvedValue({ statusCode: 200, body: { ok: true } });
  const result = await resolveIntegrationOutboxDispatcher(record, configured).dispatch({ record, provider: configured, timeoutMs: 1000 });
  expect(integrationHttpJson).toHaveBeenCalledWith(expect.objectContaining({ providerCode: configured.providerCode }));
  expect(result.sent).toBe(true); expect(result.requestJson).toEqual({ url: "https://sink.example.test", method: "POST" });
});
