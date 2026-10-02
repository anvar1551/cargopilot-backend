import { createHash } from "crypto";
import { deriveCanonicalSource } from "../../src/modules/integrations-core/application/canonical-source";
jest.mock("../../src/modules/orders-legs/carrier-worker-authority", () => ({ loadAcceptedCarrierOperation: jest.fn() }));
import { loadAcceptedCarrierOperation } from "../../src/modules/orders-legs/carrier-worker-authority";
const when = new Date("2026-10-03T00:00:00Z"), payload = { statusCode: "in_transit" }, rawBody = JSON.stringify(payload);
const provider = { companyId: "ca", domain: "carrier", providerCode: "sandbox", environment: "sandbox", status: "active",
  company: { id: "ca", tenantId: "ta", type: "company", isActive: true, tenant: { id: "ta", status: "active" } } };
const normalized = { companyId: "ca", domain: "carrier", providerCode: "sandbox", eventType: "carrier.status.updated",
  aggregateType: null, aggregateId: null, occurredAt: when, payloadJson: payload };
const raw = { companyId: "ca", providerId: "pa", domain: "carrier", providerCode: "sandbox", environment: "sandbox", signatureVerified: true,
  rawBody, rawBodySha256: createHash("sha256").update(rawBody).digest("hex"), canonicalEvent: normalized };
const input: any = { source: "inbound_webhook", webhookEventId: "raw", companyId: "ca", providerId: "pa", domain: "carrier",
  providerCode: "sandbox", eventType: normalized.eventType, occurredAt: when.toISOString(), payloadJson: payload };
let tx: any;
beforeEach(() => { jest.clearAllMocks(); tx = { $queryRaw: jest.fn().mockResolvedValue([]),
  integrationWebhookEvent: { findUnique: jest.fn().mockResolvedValue(raw) },
  integrationProvider: { findUnique: jest.fn().mockResolvedValue(provider) },
  integrationDeliveryAttempt: { findFirst: jest.fn() }, integrationCanonicalEvent: { create: jest.fn() } };
});
afterEach(() => expect(tx.integrationCanonicalEvent.create).not.toHaveBeenCalled());
it("verified persisted ingress derives its provider tuple and payload without a human membership", async () => {
  expect(await deriveCanonicalSource(tx, input)).toMatchObject({ source: "inbound_webhook", companyId: "ca", providerId: "pa",
    webhookEventId: "raw", outboxId: null, payloadJson: payload, occurredAt: when });
});
it.each([{ companyId: "cb" }, { providerId: "pb" }, { domain: "payment" }, { providerCode: "foreign" },
  { payloadJson: { statusCode: "delivered" } }, { eventType: "forged" }, { aggregateId: "other" },
  { occurredAt: "bad-time" }, { outboxId: "both" }, { webhookEventId: null }])("caller conflict rejects before persistence", async change => {
  await expect(deriveCanonicalSource(tx, { ...input, ...change })).rejects.toMatchObject({ statusCode: 409 });
});
it.each([null, { ...raw, signatureVerified: false }, { ...raw, rawBodySha256: "bad" }, { ...raw, canonicalEvent: null },
  { ...raw, canonicalEvent: { ...normalized, companyId: "other" } }])("missing/forged persisted ingress is insufficient", async value => {
  tx.integrationWebhookEvent.findUnique.mockResolvedValue(value); await expect(deriveCanonicalSource(tx, input)).rejects.toThrow();
});
it.each([null, { ...provider, companyId: "cb" }, { ...provider, domain: "payment" }, { ...provider, environment: "production" },
  { ...provider, status: "disabled" }, { ...provider, company: { ...provider.company, tenantId: null } },
  { ...provider, company: { ...provider.company, tenant: { id: "ta", status: "suspended" } } }])("provider/tenant configuration inconsistency rejects", async value => {
  tx.integrationProvider.findUnique.mockResolvedValue(value); await expect(deriveCanonicalSource(tx, input)).rejects.toThrow();
});
it.each(["create_shipment", "track", "cancel_shipment"])("%s output comes from accepted capability and persisted attempt", async operation => {
  const row = { companyId: "ca", providerId: "pa", domain: "carrier", providerCode: "sandbox", environment: "sandbox", id: "outbox", operation, status: "sent", attemptCount: 1 };
  jest.mocked(loadAcceptedCarrierOperation).mockResolvedValue({ row, leg: { id: "leg" }, provider } as any);
  tx.integrationDeliveryAttempt.findFirst.mockResolvedValue({ attemptNo: 1, outcome: "success", finishedAt: when, requestJson: {}, responseJson: payload, providerRequestId: null, statusCode: 200 });
  const output = operation === "create_shipment" ? { requestJson: {}, responseJson: payload, providerRequestId: null, statusCode: 200 }
    : { ...payload, providerRequestId: null, providerHttpStatusCode: 200, ...(operation === "cancel_shipment" ? { statusCode: "cancelled", statusLabel: "Cancelled" } : {}) };
  const data = await deriveCanonicalSource(tx, { ...input, source: "outbound_response", webhookEventId: undefined, outboxId: "outbox", aggregateType: "shipment", aggregateId: "leg",
    eventType: operation === "create_shipment" ? "carrier.shipment.created" : "carrier.status.updated", payloadJson: output });
  expect(data.payloadJson).toEqual(output); expect(loadAcceptedCarrierOperation).toHaveBeenCalledWith(tx, "outbox");
});
it("missing attempt or nonterminal retry is not durable output acceptance", async () => {
  const row = { id: "outbox", companyId: "ca", providerId: "pa", domain: "carrier", providerCode: "sandbox", environment: "sandbox", operation: "track", status: "failed", attemptCount: 1 };
  jest.mocked(loadAcceptedCarrierOperation).mockResolvedValue({ row, leg: { id: "leg" } } as any);
  for (const attempt of [null, { attemptNo: 1, outcome: "retry", finishedAt: when }]) {
    tx.integrationDeliveryAttempt.findFirst.mockResolvedValue(attempt);
    await expect(deriveCanonicalSource(tx, { ...input, source: "outbound_response", webhookEventId: undefined, outboxId: "outbox" })).rejects.toThrow();
  }
});
it("terminal create failure preserves recorded diagnostics without synthesizing a success", async () => {
  const row = { id: "outbox", companyId: "ca", providerId: "pa", domain: "carrier", providerCode: "sandbox", environment: "sandbox",
    operation: "create_shipment", status: "dead_letter", attemptCount: 1 };
  jest.mocked(loadAcceptedCarrierOperation).mockResolvedValue({ row, leg: { id: "leg" } } as any);
  tx.integrationDeliveryAttempt.findFirst.mockResolvedValue({ attemptNo: 1, outcome: "dead_letter", finishedAt: when,
    requestJson: {}, responseJson: null, providerRequestId: null, statusCode: 400, errorMessage: "bounded-synthetic" });
  const output = { requestJson: {}, responseJson: null, providerRequestId: null, statusCode: 400, message: "bounded-synthetic" };
  expect(await deriveCanonicalSource(tx, { ...input, source: "outbound_response", webhookEventId: undefined, outboxId: "outbox",
    eventType: "carrier.shipment.failed", aggregateType: "shipment", aggregateId: "leg", payloadJson: output })).toMatchObject({ payloadJson: output });
});
