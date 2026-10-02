jest.mock("../../src/modules/integrations-core/application/webhook-database", () => ({ getIntegrationWebhookDatabase: () => require("./fixtures").database }));
jest.mock("../../src/modules/payments-core/application/callback-database", () => ({ getPaymentCallbackDatabase: () => require("./fixtures").database }));
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
import { Prisma } from "@prisma/client";
import { invoicePaymentAuthorityDigest } from "../../src/modules/payments-core/application/payment-creation";
import { handleProviderWebhook } from "../../src/modules/payments-core/application/paymentsService";

const uuid = "00000000-0000-4000-8000-000000000001";
const headers = () => ({ Authorization: "Bearer SENSITIVE-CANARY", Cookie: "session=SENSITIVE-CANARY", "X-Api-Key": "SENSITIVE-CANARY",
  "Stripe-Signature": "SENSITIVE-CANARY", "X-Signature": "SENSITIVE-CANARY", "user-agent": "SENSITIVE-CANARY", "x-custom": "SENSITIVE-CANARY",
  "X-Request-ID": uuid, "x-correlation-id": "opaque-fixture-identifier", "Content-Type": 'application/json; secret=SENSITIVE-CANARY' });
beforeEach(() => {
  jest.clearAllMocks();
  db.integrationWebhookEvent.findFirst.mockResolvedValue(null);
  db.integrationWebhookEvent.create.mockResolvedValue({ id: "webhook-a", companyId: "company-a", providerId: "provider-a", domain: "carrier", providerCode: "partner", environment: "sandbox" });
  db.$queryRaw.mockResolvedValue([]); db.$executeRaw.mockResolvedValue(0);
  const owner = { companyId: "company-a", domain: "carrier", providerCode: "partner", environment: "sandbox", status: "active", company: { id: "company-a", isActive: true, type: "company", tenantId: "tenant-a", tenant: { id: "tenant-a", status: "active" } } };
  db.integrationProvider.findUnique.mockResolvedValue(owner);
  db.integrationCanonicalEvent.create.mockResolvedValue({ id: "pending" });
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
  const service = createWebhookGatewayService({ events: webhookEventRepository, providerVerifiers: { resolve: async () => ({ providerId: "provider-a", companyId: "company-a", providerCode: "partner", domain: "carrier", environment: "sandbox", verifier }) } });
  const rawBody = '{ "eventId": "event-a", "eventType": "carrier.status.updated" }\n';
  db.integrationWebhookEvent.findUnique.mockImplementation(async () => { const data = db.integrationWebhookCanonicalEvent.create.mock.calls[0][0].data; return { companyId: "company-a", providerId: "provider-a", domain: "carrier", providerCode: "partner", environment: "sandbox", signatureVerified: true, rawBody, rawBodySha256: createHash("sha256").update(rawBody).digest("hex"), canonicalEvent: data }; });
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
  expect(db.integrationCanonicalEvent.create).toHaveBeenCalledTimes(1);
});
it("rejects a changed signed body before persistence, canonical writes or queue effects", async () => {
  const f = gateway(); await expect(f.service.ingest({ ...f.request, rawBody: f.request.rawBody.replace("event-a", "event-b") })).resolves.toMatchObject({ status: "rejected" });
  expect(db.integrationWebhookEvent.create).not.toHaveBeenCalled(); expect(db.integrationWebhookCanonicalEvent.create).not.toHaveBeenCalled(); expect(f.enqueue).not.toHaveBeenCalled();
});
it("preserves duplicate handling without a new write/enqueue", async () => {
  const f = gateway(); db.integrationWebhookEvent.findFirst.mockResolvedValue({ id: "existing", companyId: "company-a", providerId: "provider-a",
    domain: "carrier", providerCode: "partner", environment: "sandbox", rawBodySha256: createHash("sha256").update(f.request.rawBody).digest("hex"), signatureVerified: true,
    provider: { companyId: "company-a", domain: "carrier", providerCode: "partner", environment: "sandbox", status: "active",
      company: { isActive: true, type: "company", tenantId: "tenant-a", tenant: { id: "tenant-a", status: "active" } } },
    canonicalEvent: { companyId: "company-a", domain: "carrier", providerCode: "partner" }, canonicalEvents: [{ id: "pending" }] });
  await expect(f.service.ingest(f.request)).resolves.toMatchObject({ status: "duplicate" });
  expect(db.integrationWebhookEvent.create).not.toHaveBeenCalled(); expect(f.enqueue).not.toHaveBeenCalled();
});
it("does not acknowledge an unpersisted integration event", async () => {
  const f = gateway(); db.integrationWebhookEvent.create.mockRejectedValueOnce(new Error("persistence unavailable"));
  await expect(f.service.ingest(f.request)).rejects.toThrow("persistence unavailable"); expect(f.enqueue).not.toHaveBeenCalled();
});
it.each([true, false])("payment verification keeps raw input and minimizes confirmed metadata (verified=%s)", async valid => {
  const original=headers(), issuedAt=new Date("2026-01-01");
  const event={id:"evt_a",type:"checkout.session.completed",livemode:false,data:{object:{id:"cs_a",status:"complete",payment_status:"paid",payment_intent:"pi_a",amount_total:100,currency:"usd"}}};
  const rawBody=Buffer.from(JSON.stringify(event));
  const source={id:"intent-a",companyId:"company-a",orderId:"order-a",provider:"STRIPE",environment:"TEST",providerInvoiceId:"cs_a",providerPaymentId:null,providerConfigId:"provider-a",providerConfig:{id:"provider-a",companyId:"company-a",provider:"STRIPE",environment:"TEST",isEnabled:true,secretEncrypted:"fixture",accountId:null},amountMinor:100n,currency:"USD",status:"PENDING",metadataJson:{invoiceId:"invoice-a",legalEntityId:"entity-a",phase0bAuthorityDigest:invoicePaymentAuthorityDigest({companyId:"company-a",orderId:"order-a",invoiceId:"invoice-a",legalEntityId:"entity-a",amountMinor:100n,currency:"USD",issuedAt})}};
  db.paymentIntent.findMany.mockResolvedValue([source]);db.paymentIntent.findUnique.mockResolvedValue(source);
  db.organization.findFirst.mockResolvedValue({tenantId:"tenant-a"});
  db.order.findFirst.mockResolvedValue({id:"order-a",tenantId:"tenant-a",ownerOrgId:"company-a",customerEntityId:null,status:"pending",paymentType:"CARD",paymentState:"PENDING",serviceCharge:0,_count:{cashCollections:0}});
  db.invoice.findUnique.mockResolvedValue({id:"invoice-a",tenantId:"tenant-a",companyId:"company-a",orderId:"order-a",customerEntityId:null,amount:new Prisma.Decimal(1),currency:"USD",issuedAt,issuedByUserId:"issuer",status:"issued"});
  db.financeLegalEntity.findUnique.mockResolvedValue({id:"entity-a",companyId:"company-a",tenantId:"tenant-a",isActive:true});
  db.$executeRaw.mockResolvedValue(0);db.$queryRaw.mockResolvedValue([]);db.paymentWebhookEvent.findUnique.mockResolvedValue(null);db.paymentWebhookEvent.create.mockResolvedValue({id:"receipt"});db.paymentIntent.update.mockResolvedValue({});db.order.updateMany.mockResolvedValue({count:1});db.paymentAttempt.create.mockResolvedValue({});db.paymentLedgerEntry.create.mockResolvedValue({});
  mockVerify.mockResolvedValue({isValid:valid,rawEvent:event});
  const result=handleProviderWebhook({provider:"STRIPE",body:{paymentIntentId:"caller-ignored"},headers:original,rawBody});
  if(valid){await expect(result).resolves.toMatchObject({ok:true});const write=db.paymentWebhookEvent.create.mock.calls[0][0].data;expect(write.headersJson).toMatchObject({payloadSha256:createHash("sha256").update(rawBody).digest("hex"),digestSource:"raw_body",signatureVerified:true});expect(JSON.stringify(write.headersJson)).not.toContain("SENSITIVE-CANARY");expect(write.payloadJson).not.toHaveProperty("data");}
  else{await expect(result).rejects.toMatchObject({statusCode:403});expect(db.paymentWebhookEvent.create).not.toHaveBeenCalled();expect(db.paymentIntent.update).not.toHaveBeenCalled();expect(db.order.updateMany).not.toHaveBeenCalled();}
  expect(mockVerify.mock.calls[0][0].headers).toBe(original);expect(mockVerify.mock.calls[0][0].rawBody).toEqual(rawBody);expect(db.paymentWebhookEvent.upsert).not.toHaveBeenCalled();
});
