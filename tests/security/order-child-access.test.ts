jest.mock("../../src/config/prismaClient", () => ({ __esModule: true, default: require("./fixtures").database }));
jest.mock("../../src/modules/analytics-core/infrastructure/analyticsOutbox", () => ({ enqueueCargoPilotDomainEventsTx: jest.fn() }));
jest.mock("../../src/modules/labels-core/application/labelService", () => ({ generateLabelPDF: jest.fn(async () => "labels/fixture.pdf") }));
jest.mock("../../src/utils/uploadLabel", () => ({ uploadLabel: jest.fn(async () => ({ key: "labels/fixture.pdf" })) }));
jest.mock("../../src/modules/support-core/application/autoTriage", () => ({ createLabelFailureSupportTicket: jest.fn() }));
jest.mock("../../src/utils/s3Presign", () => ({ presignGetObject: jest.fn(async () => "https://example.test/synthetic-label") }));
import { getOrderLabelUrls } from "../../src/modules/labels-core/application/labelAccess";
import { presignGetObject } from "../../src/utils/s3Presign";
import { database as db } from "./fixtures";
import { requireAuthorizedOrder } from "../../src/modules/orders-core/domain/order-access";
import { applyCarrierIntegrationEvent } from "../../src/modules/orders-legs/carrier-events";
import { listOrderLegs, upsertOrderLeg } from "../../src/modules/orders-legs/legs";
import { bookCarrierForOrderLeg } from "../../src/modules/orders-legs/carrier-booking";
import { generateAndAttachParcelLabelsForOrder, enqueueOrderLabelJob, runOrderLabelQueueTick } from "../../src/modules/orders-core/label/order-label";
import { generateLabelPDF } from "../../src/modules/labels-core/application/labelService";
import { uploadLabel } from "../../src/utils/uploadLabel";
const actor: any = { id: "user-a", tenantId: "tenant-a", tenantMembershipId: "tm-a", companyId: "company-a", membershipId: "cm-a", companyMembershipId: "cm-a" };
const permissions = ["shipment.view", "shipment.update", "shipment.create", "shipment.bookCarrier"];
let parent: any;
function matches(row: any, where: any): boolean {
 if (where.AND) return where.AND.every((part: any) => matches(row, part));
 if (where.OR) return where.OR.some((part: any) => matches(row, part));
 return Object.entries(where).every(([key, value]: any) => value && typeof value === "object" && value.in ? value.in.includes(row[key]) : row[key] === value);
}
beforeEach(() => {
 jest.clearAllMocks();
 db.$queryRaw.mockResolvedValue([]);
 parent = { id: "order-a", tenantId: "tenant-a", ownerOrgId: "company-a", assignedOrgId: null, assignedDriverId: "user-a" };
 db.companyMembership.findFirst.mockResolvedValue({ id: "cm-a", status: "active", companyId: "company-a", tenantId: "tenant-a", tenantMembershipId: "tm-a", tenant: { id: "tenant-a", status: "active" }, tenantMembership: { id: "tm-a", userId: "user-a", tenantId: "tenant-a", status: "active" }, company: { id: "company-a", tenantId: "tenant-a", isActive: true }, user: { id: "user-a", name: "Synthetic", email: "synthetic@example.test" }, scopes: [{ scopeType: "company", scopeRefId: "company-a" }], roles: [{ role: { code: "operator", rolePermissions: permissions.map(key => ({ permission: { key } })) } }] });
 db.order.findFirst.mockImplementation(async ({ where, select }: any) => matches(parent, where) ? (select.parcels ? { ...parent, parcels: [{ id: "parcel-a", orderId: "order-a", parcelCode: "demo", pieceNo: 1, pieceTotal: 1 }], pickupAddress: "Demo pickup", dropoffAddress: "Demo destination", createdAt: new Date() } : parent) : null);
 db.order.findUnique.mockResolvedValue({ ...parent, tenant: { id: actor.tenantId, status: "active" }, ownerOrg: { id: actor.companyId, tenantId: actor.tenantId, type: "company", isActive: true }, parcels: [{ id: "parcel-a", parcelCode: "demo", pieceNo: 1, pieceTotal: 1 }], pickupAddress: "Demo pickup", dropoffAddress: "Demo destination", createdAt: new Date() });
 db.orderLeg.findMany.mockResolvedValue([{ id: "leg-a", orderId: "order-a" }]);
 db.integrationOutbox.findUnique.mockResolvedValue(null);
 db.orderLabelJob.upsert.mockResolvedValue({ id: "job-a", orderId: "order-a" });
 db.parcel.updateMany.mockResolvedValue({ count: 1 });
 db.$transaction.mockImplementation(async (work: any) => Array.isArray(work) ? Promise.all(work) : work(db));
});
function noEffects() { expect(generateLabelPDF).not.toHaveBeenCalled(); expect(uploadLabel).not.toHaveBeenCalled(); expect(db.orderLabelJob.upsert).not.toHaveBeenCalled(); expect(db.integrationOutbox.upsert).not.toHaveBeenCalled(); expect(db.orderLeg.create).not.toHaveBeenCalled(); expect(db.orderLeg.update).not.toHaveBeenCalled(); expect(presignGetObject).not.toHaveBeenCalled(); }
it("allows authorized parent and leg listing", async () => { await expect(requireAuthorizedOrder(actor, "order-a", "shipment.view")).resolves.toMatchObject({ id: "order-a" }); await expect(listOrderLegs("order-a", actor)).resolves.toHaveLength(1); });
it("allows authorized label generation and job creation", async () => { await expect(generateAndAttachParcelLabelsForOrder("order-a", actor)).resolves.toBe(1); await enqueueOrderLabelJob("order-a", actor); expect(uploadLabel).toHaveBeenCalledTimes(1); expect(db.orderLabelJob.upsert).toHaveBeenCalledTimes(1); });
it.each(["foreign-tenant", "foreign-company", "tenant-null", "missing-context", "missing-permission"])("denies %s before protected content or effects", async kind => {
 let caller = actor;
 if (kind === "foreign-tenant") parent.tenantId = "tenant-b";
 if (kind === "foreign-company") parent.ownerOrgId = "company-b";
 if (kind === "tenant-null") parent.tenantId = null;
 if (kind === "missing-context") caller = { id: "user-a" };
 if (kind === "missing-permission") { const record = await db.companyMembership.findFirst(); record.roles = []; db.companyMembership.findFirst.mockResolvedValue(record); }
 await expect(listOrderLegs("order-a", caller)).rejects.toBeDefined();
 await expect(getOrderLabelUrls(caller, "order-a")).rejects.toBeDefined();
 await expect(generateAndAttachParcelLabelsForOrder("order-a", caller)).rejects.toBeDefined();
 await expect(enqueueOrderLabelJob("order-a", caller)).rejects.toBeDefined();
 await expect(bookCarrierForOrderLeg({ orderId: "order-a", legId: "leg-b", providerId: "provider-a", actor: caller })).rejects.toBeDefined();
 expect(db.orderLeg.findMany).not.toHaveBeenCalled(); expect(db.order.findUnique).not.toHaveBeenCalled(); noEffects();
});
it("rejects a child from another order before mutation", async () => { db.orderLeg.findFirst.mockResolvedValue(null); await expect(upsertOrderLeg("order-a", { legId: "foreign-leg" }, actor)).rejects.toMatchObject({ statusCode: 404 }); expect(db.orderLeg.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "foreign-leg", orderId: "order-a" } })); noEffects(); });
it("does not claim legacy unaccepted jobs", async () => { db.orderLabelJob.findMany.mockResolvedValue([]); await expect(runOrderLabelQueueTick({ workerId: "test-worker" })).resolves.toMatchObject({ claimed: 0 }); expect(db.orderLabelJob.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ capability: "label.generate", acceptedAt: { not: null } }) })); noEffects(); });

it("blocks context-free canonical carrier application without business writes", async () => { await expect(applyCarrierIntegrationEvent({ domain: "carrier", eventType: "carrier.shipment.created", aggregateId: "leg-a" } as any)).rejects.toMatchObject({ statusCode: 503 }); expect(db.orderLeg.findFirst).not.toHaveBeenCalled(); noEffects(); });

it("signs only labels belonging to the authorized parent", async () => {
 db.order.findFirst.mockImplementation(async ({ where, select }: any) => select.parcels ? { labelKey: null, parcels: [
  { id: "parcel-a", orderId: "order-a", labelKey: "labels/owned.pdf", parcelCode: "DEMO", pieceNo: 1, pieceTotal: 1 },
  { id: "parcel-b", orderId: "order-b", labelKey: "labels/foreign.pdf" },
 ] } : matches(parent, where) ? parent : null);
 const result = await getOrderLabelUrls(actor, "order-a");
 expect(result).toMatchObject({ urls: [{ parcelId: "parcel-a" }] });
 expect(presignGetObject).toHaveBeenCalledTimes(1);
 expect(presignGetObject).toHaveBeenCalledWith("labels/owned.pdf", 300);
});
it("allows an authorized leg creation and skips an already-booked carrier", async () => {
 db.orderLeg.create.mockResolvedValue({ id: "leg-a", orderId: "order-a", sequence: 1, status: "planned", mode: "road" });
 db.orderLeg.findFirst.mockResolvedValue({ id: "leg-a", carrierBookingStatus: "booked" });
 await expect(upsertOrderLeg("order-a", { sequence: 1 }, actor)).resolves.toMatchObject({ id: "leg-a" });
 expect(db.orderLeg.create).toHaveBeenCalledTimes(1);
 expect(db.integrationOutbox.upsert).not.toHaveBeenCalled();
});

function carrierFixture() {
 db.integrationProvider.findFirst.mockResolvedValue({ id: "provider-a", companyId: "company-a", providerCode: "synthetic", environment: "sandbox" });
 db.orderLeg.findFirst.mockResolvedValue({ id: "leg-a", orderId: "order-a", sequence: 1, mode: "road", order: { ...parent,
  orderNumber: "DEMO-1", senderName: "Demo sender", senderPhone: "+49111", pickupAddress: "Demo pickup",
  receiverName: "Demo recipient", receiverPhone: "+49222", dropoffAddress: "Demo destination",
  parcels: [{ weightKg: 1, parcelCode: "DEMO" }],
 } });
 db.orderLeg.update.mockResolvedValue({ id: "leg-a" });
 db.integrationOutbox.upsert.mockResolvedValue({ id: "outbox-a", status: "pending", providerId: "provider-a" });
}
it("queues an authorized carrier request from the authorized parent and child", async () => {
 carrierFixture();
 const result = await bookCarrierForOrderLeg({ orderId: "order-a", legId: "leg-a", providerId: "provider-a", actor });
 expect(result).toMatchObject({ outbox: { id: "outbox-a", status: "pending" } });
 expect(db.orderLeg.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "leg-a", orderId: "order-a" } }));
 expect(db.integrationOutbox.upsert).toHaveBeenCalledTimes(1);
});
it("rejects a foreign carrier child before any outbox or business mutation", async () => {
 carrierFixture(); db.orderLeg.findFirst.mockResolvedValue(null);
 await expect(bookCarrierForOrderLeg({ orderId: "order-a", legId: "foreign-leg", providerId: "provider-a", actor })).rejects.toMatchObject({ statusCode: 404 });
 noEffects();
});

it("ignores forged caller warehouse scopes and rejects before leg writes", async () => {
 const forged = { ...actor, scopes: [{ scopeType: "warehouse", scopeRefId: "warehouse-b" }] };
 await expect(upsertOrderLeg("order-a", { sequence: 1, fromWarehouseId: "warehouse-b" }, forged)).rejects.toMatchObject({ statusCode: 403 });
 expect(db.warehouse.findFirst).not.toHaveBeenCalled(); noEffects();
});
it("allows a warehouse only with current membership scope and authoritative tenant ownership", async () => {
 const record = await db.companyMembership.findFirst(); record.scopes.push({ scopeType: "warehouse", scopeRefId: "warehouse-a" });
 db.companyMembership.findFirst.mockResolvedValue(record);
 db.warehouse.findFirst.mockResolvedValue({ id: "warehouse-a" });
 db.orderLeg.create.mockResolvedValue({ id: "leg-a", sequence: 1, status: "planned", mode: "road" });
 db.orderLeg.findFirst.mockResolvedValue({ id: "leg-a", carrierBookingStatus: "booked" });
 await expect(upsertOrderLeg("order-a", { sequence: 1, fromWarehouseId: "warehouse-a" }, actor)).resolves.toMatchObject({ id: "leg-a" });
 expect(db.warehouse.findFirst).toHaveBeenCalledWith({ where: { id: "warehouse-a", tenantId: "tenant-a" }, select: { id: true } });
});
