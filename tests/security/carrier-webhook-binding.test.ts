jest.mock("../../src/config/prismaClient", () => ({ __esModule: true, default: require("./fixtures").database }));
jest.mock("../../src/modules/support-core/application/autoTriage", () => ({ createCarrierFailureSupportTicket: jest.fn() }));
jest.mock("../../src/modules/integrations-core/application/integration-secret.crypto", () => ({ decryptIntegrationSecret: jest.fn(() => JSON.stringify({ webhookSecret: "synthetic-unit-secret" })) }));
import { createHash, createHmac } from "crypto";
import { database as db } from "./fixtures";
import { applyCarrierIntegrationEvent } from "../../src/modules/orders-legs/carrier-events";
import { createHmacWebhookVerifier } from "../../src/modules/integrations-core/infrastructure/verifiers/hmac-webhook.verifier";
import { createWebhookGatewayService } from "../../src/modules/integrations-core/application/webhook-gateway.service";
import { providerWebhookVerifierResolver } from "../../src/modules/integrations-core/infrastructure/provider-webhook-verifier.resolver";
import { createCarrierFailureSupportTicket } from "../../src/modules/support-core/application/autoTriage";
let payload: any, raw: any, event: any, order: any, provider: any, booking: any, leg: any, attempt: any;
function synchronize() {
  raw.rawBody = JSON.stringify(payload); raw.rawBodySha256 = createHash("sha256").update(raw.rawBody).digest("hex");
  raw.canonicalEvent.payloadJson = { ...payload }; event.payloadJson = { ...payload };
}
beforeEach(() => {
  jest.clearAllMocks();
  provider = { id: "provider-a", companyId: "company-a", providerCode: "fake_carrier", environment: "sandbox", domain: "carrier", status: "active", secretRef: "secret-a" };
  order = { id: "order-a", tenantId: "tenant-a", ownerOrgId: "company-a", tenant: { id: "tenant-a", status: "active" }, ownerOrg: { id: "company-a", tenantId: "tenant-a", type: "company", isActive: true } };
  leg = { id: "leg-a", orderId: "order-a", order, status: "booked", carrierProviderId: "provider-a", carrierCode: "fake_carrier", carrierRef: "booking-a", carrierBookingStatus: "booked" };
  booking = { id: "outbox-a", acceptedAt: new Date(), ownershipTenantId: "tenant-a", ownershipOrderId: "order-a", companyId: "company-a", domain: "carrier", providerId: "provider-a", providerCode: "fake_carrier", environment: "sandbox", aggregateType: "shipment", aggregateId: "leg-a", operation: "create_shipment", status: "sent", attemptCount: 1,
    payload: { companyId: "company-a", aggregateType: "shipment", aggregateId: "leg-a", payload: { action: "create_shipment", input: { metadata: { orderId: "order-a", orderLegId: "leg-a" } } } } };
  event = { id: "event-a", source: "inbound_webhook", status: "processing", companyId: "company-a", providerId: "provider-a", providerCode: "fake_carrier", domain: "carrier", eventType: "carrier.status.updated", webhookEventId: "raw-a", outboxId: null };
  payload = { eventId: "external-event-a", eventType: "carrier.status.updated", partnerShipmentId: "booking-a", statusCode: "in_transit" };
  raw = { id: "raw-a", signatureVerified: true, companyId: "company-a", providerId: "provider-a", providerCode: "fake_carrier", domain: "carrier", environment: "sandbox", canonicalEvent: { companyId: "company-a", providerCode: "fake_carrier", domain: "carrier", eventType: "carrier.status.updated", occurredAt: new Date() } };
  synchronize(); attempt = { outcome: "success", responseJson: { partnerShipmentId: "booking-a" } };
  db.$queryRaw.mockResolvedValue([]); db.$transaction.mockImplementation(async (work: any) => work(db));
  db.integrationCanonicalEvent.findUnique.mockImplementation(async () => event);
  db.integrationCanonicalEvent.update.mockImplementation(async ({ data }: any) => Object.assign(event, data));
  db.integrationWebhookEvent.findUnique.mockImplementation(async () => raw);
  db.integrationProvider.findUnique.mockImplementation(async () => provider);
  db.integrationProvider.findMany.mockImplementation(async () => [provider]);
  db.integrationProviderSecret.findUnique.mockResolvedValue({ encryptedSecretJson: "synthetic-encrypted", providerId: "provider-a" });
  db.orderLeg.findMany.mockResolvedValue([{ id: "leg-a", orderId: "order-a" }]);
  db.orderLeg.findFirst.mockImplementation(async () => leg);
  db.integrationOutbox.findMany.mockResolvedValue([{ id: "outbox-a" }]);
  db.integrationOutbox.findUnique.mockImplementation(async () => booking);
  db.integrationDeliveryAttempt.findUnique.mockImplementation(async () => attempt);
  db.order.findUnique.mockImplementation(async () => order);
  db.orderLeg.update.mockImplementation(async ({ data }: any) => Object.assign(leg, data));
  db.tracking.create.mockResolvedValue({ id: "tracking-a" });
});
function noEffects() {
  expect(db.orderLeg.update).not.toHaveBeenCalled(); expect(db.tracking.create).not.toHaveBeenCalled();
  expect(db.integrationOutbox.create).not.toHaveBeenCalled(); expect(db.integrationOutbox.updateMany).not.toHaveBeenCalled();
  expect(createCarrierFailureSupportTicket).not.toHaveBeenCalled(); expect(db.integrationCanonicalEvent.update).not.toHaveBeenCalled();
}
it("binds a verified webhook to a confirmed provider booking and ignores queue claims", async () => {
  await expect(applyCarrierIntegrationEvent({ id: "event-a", companyId: "forged", aggregateId: "foreign-leg" } as any)).resolves.toEqual({ applied: true });
  expect(db.orderLeg.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { carrierProviderId: "provider-a", carrierRef: "booking-a" }, take: 2 }));
  expect(db.orderLeg.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "leg-a" }, data: expect.objectContaining({ status: "in_transit" }) }));
  await applyCarrierIntegrationEvent({ id: "event-a" } as any);
  expect(db.tracking.create).toHaveBeenCalledTimes(1);
});
it.each(["unverified", "digest", "unbound", "ambiguous-leg", "ambiguous-booking", "foreign-tenant", "foreign-company", "wrong-provider", "wrong-booking", "wrong-leg", "unaccepted", "disabled", "unsupported", "invalid-transition", "arrival-regression", "unknown-status", "conflicting-status", "conflicting-booking", "tampered-canonical"])("quarantines %s without business effects", async kind => {
  if (kind === "unverified") raw.signatureVerified = false;
  if (kind === "digest") raw.rawBodySha256 = "bad";
  if (kind === "unbound") db.orderLeg.findMany.mockResolvedValue([]);
  if (kind === "ambiguous-leg") db.orderLeg.findMany.mockResolvedValue([{ id: "leg-a", orderId: "order-a" }, { id: "leg-b", orderId: "order-b" }]);
  if (kind === "ambiguous-booking") db.integrationOutbox.findMany.mockResolvedValue([{ id: "outbox-a" }, { id: "outbox-b" }]);
  if (kind === "foreign-tenant") { payload.tenantId = "tenant-b"; synchronize(); }
  if (kind === "foreign-company") { payload.companyId = "company-b"; synchronize(); }
  if (kind === "wrong-provider") provider.companyId = "company-b";
  if (kind === "wrong-booking") attempt.responseJson.partnerShipmentId = "booking-b";
  if (kind === "wrong-leg") { payload.metadata = { orderLegId: "leg-b" }; synchronize(); }
  if (kind === "unaccepted") booking.acceptedAt = null;
  if (kind === "disabled") order.tenant.status = "suspended";
  if (kind === "unsupported") provider.providerCode = "unknown_vendor";
  if (kind === "invalid-transition") leg.status = "completed";
  if (kind === "arrival-regression") leg.status = "arrived";
  if (kind === "unknown-status") { payload.statusCode = "customs_magic"; synchronize(); }
  if (kind === "conflicting-status") { payload.status = "delivered"; synchronize(); }
  if (kind === "conflicting-booking") { payload.carrierRef = "booking-b"; synchronize(); }
  if (kind === "tampered-canonical") event.payloadJson = { ...payload, statusCode: "delivered" };
  await expect(applyCarrierIntegrationEvent({ id: "event-a" } as any)).rejects.toBeDefined(); noEffects();
});
it("rejects an invalid HMAC before any persisted event or business write", async () => {
  const events = { hasProcessed: jest.fn(), saveRawEvent: jest.fn(), saveCanonicalEvent: jest.fn() };
  const verifier = createHmacWebhookVerifier({ providerCode: "fake_carrier", secret: "synthetic-unit-secret" });
  const gateway = createWebhookGatewayService({ events, providerVerifiers: { resolve: async () => ({ ...provider, providerId: provider.id, verifier }) } });
  await expect(gateway.ingest({ providerCode: "fake_carrier", rawBody: JSON.stringify(payload), headers: { "x-signature": "invalid" } })).resolves.toMatchObject({ status: "rejected" });
  expect(events.hasProcessed).not.toHaveBeenCalled(); expect(events.saveRawEvent).not.toHaveBeenCalled(); noEffects();
});
it("persists configured company identity after real HMAC verification, retaining hostile payload claims for binding rejection", async () => {
  payload.companyId = "company-b"; const rawBody = JSON.stringify(payload);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const events = { hasProcessed: jest.fn(async () => false), saveRawEvent: jest.fn(async () => ({ webhookEventId: "raw-a" })), saveCanonicalEvent: jest.fn() };
  const enqueue = jest.fn(); const verifier = createHmacWebhookVerifier({ providerCode: "fake_carrier", secret: "synthetic-unit-secret" });
  const gateway = createWebhookGatewayService({ events, canonicalEvents: { enqueue }, providerVerifiers: { resolve: async () => ({ ...provider, providerId: provider.id, verifier }) } });
  await expect(gateway.ingest({ providerCode: "fake_carrier", companyHintId: "company-b", rawBody, headers: {
    "x-signature-timestamp": timestamp, "x-signature": createHmac("sha256", "synthetic-unit-secret").update(`${timestamp}.${rawBody}`).digest("hex"),
  } })).resolves.toMatchObject({ status: "accepted" });
  expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ companyId: "company-a", payloadJson: expect.objectContaining({ companyId: "company-b" }) }));
});
it("resolves UUID v7 integrations without selecting a first provider and rejects secret ownership mismatch", async () => {
  provider.id = "019b3000-0000-7000-8b00-000000000001";
  db.integrationProviderSecret.findUnique.mockResolvedValue({ providerId: provider.id, encryptedSecretJson: "synthetic-encrypted" });
  await expect(providerWebhookVerifierResolver.resolve({ providerIdentifier: provider.id })).resolves.toMatchObject({ providerId: provider.id });
  db.integrationProvider.findMany.mockResolvedValue([provider, { ...provider, id: "other" }]);
  await expect(providerWebhookVerifierResolver.resolve({ providerIdentifier: "fake_carrier", companyHintId: "company-a" })).resolves.toBeNull();
  db.integrationProvider.findMany.mockResolvedValue([provider]);
  db.integrationProviderSecret.findUnique.mockResolvedValue({ providerId: "other", encryptedSecretJson: "synthetic-encrypted" });
  await expect(providerWebhookVerifierResolver.resolve({ providerIdentifier: provider.id })).resolves.toBeNull();
});
