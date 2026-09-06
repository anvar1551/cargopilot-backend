jest.mock("../../src/config/prismaClient", () => ({ __esModule: true, default: require("./fixtures").database }));
const mockVerify = jest.fn();
jest.mock("../../src/modules/payments-core/infrastructure/providers/providerAdapter", () => ({ getPaymentProviderAdapter: () => ({ verifyWebhook: mockVerify }), parsePaymentEnvironment: () => "TEST" }));
jest.mock("../../src/modules/payments-core/application/paymentCrypto", () => ({ decryptSecret: () => "fixture-only", encryptSecret: jest.fn(), maskSecret: jest.fn() }));
jest.mock("../../src/modules/identity-access", () => ({ authorize: jest.fn() }));
jest.mock("../../src/modules/support-core/application/autoTriage", () => ({ createPaymentWebhookSupportTicket: jest.fn(async () => undefined), createPaymentFailureSupportTicket: jest.fn(async () => undefined) }));
jest.mock("../../src/modules/analytics-core/infrastructure/analyticsOutbox", () => ({ enqueueCargoPilotDomainEventTx: jest.fn() }));

import { createHash, createHmac } from "crypto";
import { database as db } from "./fixtures";
import { webhookHeadersForStorage, paymentWebhookMetadata } from "../../src/utils/webhookMetadata";
import { createWebhookGatewayService } from "../../src/modules/integrations-core/application/webhook-gateway.service";
import { webhookEventRepository } from "../../src/modules/integrations-core/infrastructure/webhook-events.repo";
import { createHmacWebhookVerifier } from "../../src/modules/integrations-core/infrastructure/verifiers/hmac-webhook.verifier";
import { handleProviderWebhook } from "../../src/modules/payments-core/application/paymentsService";

const uuid = "00000000-0000-4000-8000-000000000001";
const headers = () => ({ Authorization: "Bearer SENSITIVE-CANARY", Cookie: "session=SENSITIVE-CANARY", "X-Api-Key": "SENSITIVE-CANARY",
  "Stripe-Signature": "SENSITIVE-CANARY", "X-Signature": "SENSITIVE-CANARY", "user-agent": "SENSITIVE-CANARY", "x-custom": "SENSITIVE-CANARY",
  "X-Request-ID": uuid, "x-correlation-id": "opaque-fixture-identifier", "Content-Type": 'application/json; secret=SENSITIVE-CANARY' });
beforeEach(() => {
  jest.clearAllMocks();
  db.integrationWebhookEvent.findFirst.mockResolvedValue(null);
  db.integrationWebhookEvent.create.mockResolvedValue({ id: "webhook-a" });
  db.integrationWebhookEvent.update.mockResolvedValue({});
  db.integrationWebhookCanonicalEvent.create.mockResolvedValue({});
  db.paymentIntent.findUnique.mockResolvedValue({ id: "intent-a", companyId: "company-a", providerConfig: { id: "provider-a", companyId: "company-a", provider: "STRIPE", environment: "TEST", isEnabled: true, secretEncrypted: "fixture" } });
  db.paymentWebhookEvent.upsert.mockResolvedValue({ id: "payment-event-a" });
  db.$transaction.mockImplementation(async (work: any) => work(db));
  mockVerify.mockResolvedValue({ isValid: true, idempotencyKey: "event-a", externalEventId: "event-a", responsePayload: { accepted: true } });
});

it("stores only explicit normalized headers and non-reusable opaque correlation digests", () => {
  const stored = webhookHeadersForStorage(headers());
  expect(stored).toEqual({ "content-type": "application/json", "x-request-id": uuid,
    "x-correlation-id": `sha256:${createHash("sha256").update("opaque-fixture-identifier").digest("hex")}` });
  expect(JSON.stringify(stored)).not.toContain("SENSITIVE-CANARY");
  expect(webhookHeadersForStorage(stored)).toEqual(stored);
});
it("drops repeated, oversized and control-bearing header values", () => {
  expect(webhookHeadersForStorage({ "x-event-id": ["a", "b"], "x-request-id": "x".repeat(257), "x-correlation-id": "one\r\ntwo" })).toEqual({});
});
it("distinguishes exact raw body digests from parsed-JSON fallback", () => {
  const raw = Buffer.from('{ "a": 1 }\n');
  expect(paymentWebhookMetadata(headers(), raw, { a: 1 }, true)).toMatchObject({ digestSource: "raw_body", payloadSha256: createHash("sha256").update(raw).digest("hex"), signatureVerified: true });
  expect(paymentWebhookMetadata(headers(), undefined, { a: 1 }, false)).toMatchObject({ digestSource: "parsed_json", signatureVerified: false });
});

function gateway() {
  const enqueue = jest.fn(async () => undefined);
  const verifier = createHmacWebhookVerifier({ providerCode: "partner", secret: "fixture-hmac", maxSkewSeconds: 300 });
  const service = createWebhookGatewayService({ events: webhookEventRepository, canonicalEvents: { enqueue }, providerVerifiers: { resolve: async () => ({ providerId: "provider-a", companyId: "company-a", providerCode: "partner", domain: "carrier", environment: "sandbox", verifier }) } });
  const rawBody = '{ "eventId": "event-a", "eventType": "carrier.status.updated" }\n';
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac("sha256", "fixture-hmac").update(`${timestamp}.${rawBody}`).digest("hex");
  const request = { providerCode: "partner", rawBody, userAgent: "SENSITIVE-CANARY", headers: { ...headers(), "x-signature": signature, "x-signature-timestamp": timestamp } };
  return { service, request, enqueue, signature };
}
it("keeps original raw-body verification and accepted processing while storing minimized integration metadata", async () => {
  const f = gateway(); await expect(f.service.ingest(f.request)).resolves.toMatchObject({ status: "accepted", eventId: "event-a" });
  const data = db.integrationWebhookEvent.create.mock.calls[0][0].data;
  expect(data).toMatchObject({ rawBody: f.request.rawBody, rawBodySha256: createHash("sha256").update(f.request.rawBody).digest("hex"), signatureVerified: true, userAgent: null, providerEventId: "event-a" });
  expect(JSON.stringify(data.headersJson)).not.toContain("SENSITIVE-CANARY"); expect(JSON.stringify(data.headersJson)).not.toContain(f.signature);
  expect(f.enqueue).toHaveBeenCalledTimes(1);
});
it("rejects a changed signed body before persistence, canonical writes or queue effects", async () => {
  const f = gateway(); await expect(f.service.ingest({ ...f.request, rawBody: f.request.rawBody.replace("event-a", "event-b") })).resolves.toMatchObject({ status: "rejected" });
  expect(db.integrationWebhookEvent.create).not.toHaveBeenCalled(); expect(db.integrationWebhookCanonicalEvent.create).not.toHaveBeenCalled(); expect(f.enqueue).not.toHaveBeenCalled();
});
it("preserves duplicate handling without a new write/enqueue", async () => {
  const f = gateway(); db.integrationWebhookEvent.findFirst.mockResolvedValue({ id: "existing" });
  await expect(f.service.ingest(f.request)).resolves.toMatchObject({ status: "duplicate" });
  expect(db.integrationWebhookEvent.create).not.toHaveBeenCalled(); expect(f.enqueue).not.toHaveBeenCalled();
});
it("does not acknowledge an unpersisted integration event", async () => {
  const f = gateway(); db.integrationWebhookEvent.create.mockRejectedValueOnce(new Error("persistence unavailable"));
  await expect(f.service.ingest(f.request)).rejects.toThrow("persistence unavailable"); expect(f.enqueue).not.toHaveBeenCalled();
});
it.each([true, false])("preserves payment verifier inputs/results and minimizes both upsert branches (verified=%s)", async (valid) => {
  const original = headers(); const rawBody = Buffer.from('{ "paymentIntentId": "intent-a" }\n');
  mockVerify.mockResolvedValue({ isValid: valid, idempotencyKey: "event-a", externalEventId: "event-a", responsePayload: { accepted: valid } });
  await expect(handleProviderWebhook({ provider: "STRIPE", body: { paymentIntentId: "intent-a" }, headers: original, rawBody })).resolves.toEqual({ accepted: valid });
  expect(mockVerify.mock.calls[0][0].headers).toBe(original); expect(mockVerify.mock.calls[0][0].rawBody).toBe(rawBody);
  const write = db.paymentWebhookEvent.upsert.mock.calls[0][0];
  for (const branch of [write.create, write.update]) {
    expect(branch.headersJson).toMatchObject({ payloadSha256: createHash("sha256").update(rawBody).digest("hex"), digestSource: "raw_body", signatureVerified: valid });
    expect(JSON.stringify(branch.headersJson)).not.toContain("SENSITIVE-CANARY");
  }
  expect(db.order.update).not.toHaveBeenCalled(); expect(db.paymentIntent.update).not.toHaveBeenCalled();
});
