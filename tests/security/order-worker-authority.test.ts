jest.mock("../../src/config/prismaClient", () => ({ __esModule: true, default: require("./fixtures").database }));
jest.mock("../../src/modules/labels-core/application/labelService", () => ({ generateLabelPDF: jest.fn(async () => "labels/parcel-a.pdf") }));
jest.mock("../../src/utils/uploadLabel", () => ({ uploadLabel: jest.fn(async (_file, key) => ({ key })) }));
jest.mock("../../src/modules/support-core/application/autoTriage", () => ({ createLabelFailureSupportTicket: jest.fn(), createCarrierFailureSupportTicket: jest.fn() }));
jest.mock("../../src/modules/integrations-core/infrastructure/outbox.repo", () => ({ integrationOutboxRepository: require('./fixtures').database.publisherOutbox }));
jest.mock("../../src/modules/integrations-core/infrastructure/provider-registry.repo", () => ({ providerRegistryService: require('./fixtures').database.registry }));
jest.mock("../../src/modules/integrations-core/infrastructure/canonical-event.repo", () => ({ integrationCanonicalEventRepository: require('./fixtures').database.canonicalRepo }));
jest.mock("../../src/modules/integrations-core/application/canonical-event-processor", () => ({ processIntegrationCanonicalEventsOnce: jest.fn(async () => ({ claimed: 0 })) }));
jest.mock("../../src/config/redis", () => ({ getRedisPrefix: () => "synthetic", getRedisClient: jest.fn(), withRedisTimeout: jest.fn() }));
jest.mock("../../src/modules/integrations-core/config/outbox.logger", () => ({ integrationOutboxLogger: { throttledWarn: jest.fn(), throttledError: jest.fn() } }));
jest.mock("../../src/modules/integrations-core/application/provider-adapters", () => ({
  HttpCarrierAdapter: jest.fn(() => ({ createShipment: require('./fixtures').database.provider.createShipment, track: require('./fixtures').database.provider.track })),
  resolveProviderHttpConfig: jest.fn(() => ({ baseUrl: "https://synthetic.example.test" })),
  toCarrierTrackInput: jest.fn(value => value.input),
  toCarrierCreateShipmentInput: jest.fn(value => value.input),
}));
import { database as db } from "./fixtures";
import { generateLabelPDF } from "../../src/modules/labels-core/application/labelService";
import { uploadLabel } from "../../src/utils/uploadLabel";
import { createLabelFailureSupportTicket, createCarrierFailureSupportTicket } from "../../src/modules/support-core/application/autoTriage";
import { runOrderLabelQueueTick } from "../../src/modules/orders-core/label/order-label";
import { applyCarrierIntegrationEvent } from "../../src/modules/orders-legs/carrier-events";
import { resolveIntegrationOutboxDispatcher } from "../../src/modules/integrations-core/application/outbox-dispatcher";
import { processIntegrationOutboxBatchOnce } from "../../src/modules/integrations-core/infrastructure/integration-outbox.publisher";
let order: any, job: any, leg: any, outbox: any, event: any, provider: any, attempt: any;
beforeEach(() => {
  jest.clearAllMocks();
  order = { id: "order-a", tenantId: "tenant-a", ownerOrgId: "company-a",
    tenant: { id: "tenant-a", status: "active" }, ownerOrg: { id: "company-a", tenantId: "tenant-a", type: "company", isActive: true },
    parcels: [{ id: "parcel-a", orderId: "order-a", parcelCode: "DEMO", labelKey: null }], createdAt: new Date(), pickupAddress: "Synthetic", dropoffAddress: "Synthetic" };
  job = { id: "job-a", orderId: "order-a", ownershipTenantId: "tenant-a", ownershipCompanyId: "company-a", capability: "label.generate", acceptedAt: new Date(), status: "processing", lockedBy: "worker", attempts: 1, maxAttempts: 5 };
  leg = { id: "leg-a", orderId: "order-a", carrierProviderId: "provider-a", carrierCode: "demo", carrierRef: "synthetic-ref", carrierTrackingNumber: "synthetic-track", order };
  provider = { id: "provider-a", companyId: "company-a", domain: "carrier", status: "active", providerCode: "demo", environment: "sandbox" };
  outbox = { id: "outbox-a", companyId: "company-a", ownershipTenantId: "tenant-a", ownershipOrderId: "order-a", acceptedAt: new Date(), domain: "carrier", providerId: "provider-a", providerCode: "demo", environment: "sandbox", aggregateType: "shipment", aggregateId: "leg-a", operation: "track", status: "sent", attemptCount: 1, maxAttempts: 10,
    payload: { eventType: "carrier.command.requested", companyId: "company-a", aggregateType: "shipment", aggregateId: "leg-a", payload: { action: "track", input: { partnerShipmentId: "synthetic-ref", metadata: { orderId: "order-a", orderLegId: "leg-a" } } } } };
  event = { id: "event-a", domain: "carrier", source: "outbound_response", status: "processing", outboxId: "outbox-a", companyId: "company-a", providerId: "provider-a", providerCode: "demo", aggregateType: "shipment", aggregateId: "leg-a", eventType: "carrier.status.updated", payloadJson: { statusCode: "delivered" } };
  attempt = { outcome: "success", finishedAt: new Date(), responseJson: { statusCode: "in_transit" } };
  db.$transaction.mockImplementation(async (work: any) => Array.isArray(work) ? Promise.all(work) : work(db));
  db.$queryRaw.mockResolvedValue([]);
  db.order.findUnique.mockImplementation(async () => order);
  db.order.findFirst.mockImplementation(async () => order);
  db.orderLabelJob.findMany.mockResolvedValue([{ id: "job-a", orderId: "FORGED-QUEUE-ORDER", attempts: 0, maxAttempts: 5 }]);
  db.orderLabelJob.findUnique.mockImplementation(async () => job);
  db.orderLabelJob.updateMany.mockResolvedValue({ count: 1 });
  db.parcel.updateMany.mockResolvedValue({ count: 1 });
  db.integrationCanonicalEvent.findUnique.mockImplementation(async () => event);
  db.integrationCanonicalEvent.update.mockImplementation(async ({ data }: any) => Object.assign(event, data));
  db.integrationOutbox.findUnique.mockImplementation(async () => outbox);
  db.integrationOutbox.updateMany.mockResolvedValue({ count: 1 });
  db.integrationProvider.findUnique.mockImplementation(async () => provider);
  db.integrationDeliveryAttempt.findUnique.mockImplementation(async () => attempt);
  db.orderLeg.findFirst.mockImplementation(async () => leg);
  db.orderLeg.update.mockResolvedValue(leg);
  db.tracking.create.mockResolvedValue({ id: "tracking-a" });
  db.provider.track.mockResolvedValue({ ok: true, data: { status: "in_transit" } });
  db.provider.createShipment.mockResolvedValue({ ok: true, data: { partnerShipmentId: "synthetic-new" } });
});
function noBusinessEffects() {
  expect(generateLabelPDF).not.toHaveBeenCalled(); expect(uploadLabel).not.toHaveBeenCalled();
  expect(db.parcel.updateMany).not.toHaveBeenCalled(); expect(db.orderLeg.update).not.toHaveBeenCalled();
  expect(db.tracking.create).not.toHaveBeenCalled(); expect(db.integrationOutbox.updateMany).not.toHaveBeenCalled();
  expect(db.integrationOutbox.upsert).not.toHaveBeenCalled(); expect(db.provider.track).not.toHaveBeenCalled();
  expect(db.provider.createShipment).not.toHaveBeenCalled();
}
it("executes the accepted label grant, ignoring forged candidate ownership and human login state", async () => {
  await expect(runOrderLabelQueueTick({ workerId: "worker" })).resolves.toMatchObject({ completed: 1 });
  expect(db.companyMembership.findFirst).not.toHaveBeenCalled();
  expect(uploadLabel).toHaveBeenCalledWith("parcel-a.pdf", "labels/tenant-a/company-a/order-a/parcel-a.pdf");
  expect(db.orderLabelJob.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({ where: { id: "job-a", status: "processing", lockedBy: "worker", attempts: 1 } }));
});
it.each(["tenant", "company", "null", "disabled-tenant", "disabled-company", "wrong-child", "unaccepted", "lease"])("rejects label %s before business effects", async kind => {
  if (kind === "tenant") order.tenantId = "tenant-b";
  if (kind === "company") order.ownerOrgId = "company-b";
  if (kind === "null") job.ownershipTenantId = null;
  if (kind === "disabled-tenant") order.tenant.status = "suspended";
  if (kind === "disabled-company") order.ownerOrg.isActive = false;
  if (kind === "wrong-child") order.parcels[0].orderId = "order-b";
  if (kind === "unaccepted") job.acceptedAt = null;
  if (kind === "lease") job.lockedBy = "other-worker";
  await expect(runOrderLabelQueueTick({ workerId: "worker" })).resolves.toMatchObject({ completed: 0 });
  noBusinessEffects();
});
it("skips already-labelled parcels on a retry", async () => {
  order.parcels[0].labelKey = "labels/tenant-a/company-a/order-a/parcel-a.pdf";
  await expect(runOrderLabelQueueTick({ workerId: "worker" })).resolves.toMatchObject({ completed: 1 });
  expect(uploadLabel).not.toHaveBeenCalled(); expect(generateLabelPDF).not.toHaveBeenCalled();
});
it("attributes exhausted label failure only to the reloaded authorized order", async () => {
  job.maxAttempts = 1;
  db.orderLabelJob.findMany.mockResolvedValue([{ id: "job-a", orderId: "FORGED-QUEUE-ORDER", attempts: 0, maxAttempts: 1 }]);
  (generateLabelPDF as jest.Mock).mockRejectedValueOnce(new Error("Synthetic failure"));
  (createLabelFailureSupportTicket as jest.Mock).mockResolvedValueOnce(undefined);
  await expect(runOrderLabelQueueTick({ workerId: "worker" })).resolves.toMatchObject({ failed: 1 });
  expect(createLabelFailureSupportTicket).toHaveBeenCalledWith(expect.objectContaining({ orderId: "order-a" }));
  expect(uploadLabel).not.toHaveBeenCalled();
});
it("applies only the durable delivery response and commits its receipt; duplicate signals do nothing", async () => {
  await expect(applyCarrierIntegrationEvent({ id: "event-a", companyId: "FORGED", payloadJson: { status: "delivered" } } as any)).resolves.toEqual({ applied: true });
  expect(db.orderLeg.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "in_transit" }) }));
  await applyCarrierIntegrationEvent({ id: "event-a" } as any);
  expect(db.orderLeg.update).toHaveBeenCalledTimes(1); expect(db.tracking.create).toHaveBeenCalledTimes(1);
});
it("does not launch a carrier failure ticket when receipt persistence rejects", async () => {
  attempt.responseJson = { statusCode: "failed" };
  db.integrationCanonicalEvent.update.mockRejectedValueOnce(new Error("Synthetic receipt failure"));
  await expect(applyCarrierIntegrationEvent({ id: "event-a" } as any)).rejects.toThrow("Synthetic receipt failure");
  expect(createCarrierFailureSupportTicket).not.toHaveBeenCalled();
});
it.each(["tenant", "company", "wrong-child", "disabled", "provider", "unaccepted", "event-child", "unpersisted", "webhook"])("rejects canonical %s without business effects", async kind => {
  if (kind === "tenant") order.tenantId = "tenant-b";
  if (kind === "company") outbox.companyId = "company-b";
  if (kind === "wrong-child") leg.orderId = "order-b";
  if (kind === "disabled") order.tenant.status = "suspended";
  if (kind === "provider") provider.environment = "production";
  if (kind === "unaccepted") outbox.acceptedAt = null;
  if (kind === "event-child") event.aggregateId = "leg-b";
  if (kind === "unpersisted") attempt = null;
  if (kind === "webhook") event.source = "inbound_webhook";
  await expect(applyCarrierIntegrationEvent({ id: "event-a" } as any)).rejects.toBeDefined(); noBusinessEffects();
  expect(db.integrationCanonicalEvent.update).not.toHaveBeenCalled();
});
it("dispatches authorized tracking from reloaded data, ignoring forged payload/provider", async () => {
  outbox.status = "processing";
  const dispatcher = resolveIntegrationOutboxDispatcher({ id: "outbox-a", domain: "carrier", payload: { unsafe: true } } as any, provider);
  await expect(dispatcher.dispatch({ record: { id: "outbox-a", payload: {} } as any, provider: { ...provider, companyId: "FORGED" }, timeoutMs: 1000 })).resolves.toMatchObject({ sent: true });
  expect(db.provider.track).toHaveBeenCalledWith(outbox.payload.payload.input, expect.objectContaining({ companyId: "company-a" }));
});
it.each(["foreign", "wrong-child", "disabled", "inactive-provider", "duplicate", "uncertain"])("denies outbound %s without provider/storage/outbox effects", async kind => {
  outbox.status = "processing";
  if (kind === "foreign") outbox.companyId = "company-b";
  if (kind === "wrong-child") outbox.payload.payload.input.metadata.orderLegId = "leg-b";
  if (kind === "disabled") order.tenant.status = "suspended";
  if (kind === "inactive-provider") provider.status = "paused";
  if (kind === "duplicate") outbox.status = "sent";
  if (kind === "uncertain") { outbox.operation = "create_shipment"; outbox.payload.payload.action = "create_shipment"; outbox.executionStartedAt = new Date(); }
  const dispatcher = resolveIntegrationOutboxDispatcher(outbox, provider);
  await expect(dispatcher.dispatch({ record: outbox, provider, timeoutMs: 1000 })).resolves.toMatchObject({ sent: false, retryable: false }); noBusinessEffects();
});
it("admits one authorized carrier mutation and prevents duplicate provider execution", async () => {
  outbox.status = "processing"; outbox.operation = "create_shipment"; outbox.payload.payload.action = "create_shipment";
  outbox.attemptCount = 0;
  db.integrationOutbox.updateMany.mockImplementation(async () => { outbox.executionStartedAt = new Date(); return { count: 1 }; });
  const dispatcher = resolveIntegrationOutboxDispatcher(outbox, provider);
  await expect(dispatcher.dispatch({ record: outbox, provider, timeoutMs: 1000 })).resolves.toMatchObject({ sent: true });
  await expect(dispatcher.dispatch({ record: outbox, provider, timeoutMs: 1000 })).resolves.toMatchObject({ sent: false, requiresRecovery: true });
  expect(db.provider.createShipment).toHaveBeenCalledTimes(1); expect(db.integrationOutbox.updateMany).toHaveBeenCalledTimes(1);
});
it("holds an unsuccessful admitted mutation without treating it as a proven failure or safe replay", async () => {
  outbox.status = "processing"; outbox.operation = "create_shipment"; outbox.payload.payload.action = "create_shipment"; outbox.attemptCount = 0;
  db.provider.createShipment.mockResolvedValue({ ok: false, retryable: true, message: "Synthetic uncertain response" });
  await expect(resolveIntegrationOutboxDispatcher(outbox, provider).dispatch({ record: outbox, provider, timeoutMs: 1000 })).resolves.toMatchObject({ sent: false, requiresRecovery: true });
});
it("publisher does not turn authority denial into outbox attempts or canonical business events", async () => {
  outbox.status = "processing"; order.tenant.status = "suspended";
  db.publisherOutbox.claimBatch.mockResolvedValue([outbox]); db.registry.resolveProvider.mockResolvedValue(provider);
  await processIntegrationOutboxBatchOnce();
  noBusinessEffects();
  expect(db.publisherOutbox.markDeadLetter).not.toHaveBeenCalled(); expect(db.publisherOutbox.markRetry).not.toHaveBeenCalled();
  expect(db.publisherOutbox.markSent).not.toHaveBeenCalled(); expect(db.canonicalRepo.enqueue).not.toHaveBeenCalled();
});
