jest.mock("../../src/modules/identity-access/application/driver-eligibility", () => ({ requireAcceptedDriver: jest.fn() }));
jest.mock("../../src/modules/orders-core/domain/custody-access", () => ({ requireCustodyReadActor: jest.fn(async(a:any)=>a), loadCustodySource: jest.fn(), authorizeCustodyRead: jest.fn() }));
import { requireAcceptedDriver } from "../../src/modules/identity-access/application/driver-eligibility";
import { loadCustodySource, authorizeCustodyRead } from "../../src/modules/orders-core/domain/custody-access";
jest.mock("../../src/config/prismaClient", () => ({ __esModule: true, default: require("./fixtures").database }));
jest.mock("../../src/modules/identity-access/access-control", () => ({ loadAccessSnapshot: jest.fn() }));
jest.mock("../../src/modules/orders-core/domain/order-access", () => ({ requireAuthorizedOrder: jest.fn() }));
jest.mock("../../src/modules/orders-core/domain/company-authority", () => ({ requireTenantBoundOrderCompanyAuthority: jest.fn() }));
jest.mock("../../src/modules/live-map-core/infrastructure/selectedTelemetryStore", () => ({
  readSelectedPresence: jest.fn(), readSelectedTelemetry: jest.fn(), writeSelectedPresence: jest.fn(), writeSelectedTelemetry: jest.fn(),
}));
jest.mock("../../src/modules/live-map-core/infrastructure/liveMapStore", () => ({ publishLiveMapEvent: jest.fn() }));
import { loadAccessSnapshot } from "../../src/modules/identity-access/access-control";
import { requireAuthorizedOrder } from "../../src/modules/orders-core/domain/order-access";
import { requireTenantBoundOrderCompanyAuthority } from "../../src/modules/orders-core/domain/company-authority";
import { getDriverPresence, setDriverPresence, ingestDriverLocation, ingestDriverTelemetry, heartbeatDriverPresence } from "../../src/modules/live-map-core/application/liveMapService";
import * as store from "../../src/modules/live-map-core/infrastructure/selectedTelemetryStore";
import { publishLiveMapEvent } from "../../src/modules/live-map-core/infrastructure/liveMapStore";
import { expectNoDatabaseCalls } from "./fixtures";
const actor = (company = "a", tenant = "a"): any => ({ id: "00000000-0000-4000-8000-000000000001", tenantId: "tenant-" + tenant, companyId: "company-" + company, tenantMembershipId: "tm-" + tenant, membershipId: "cm-" + company, companyMembershipId: "cm-" + company, permissionCodes: ["drivers.manage"] });
const context = (user = actor()) => ({ userId: user.id, tenantId: user.tenantId, tenantMembershipId: user.tenantMembershipId, companyId: user.companyId, companyMembershipId: user.companyMembershipId });
const orderId = "00000000-0000-4000-8000-000000000002";
beforeEach(() => {
  jest.clearAllMocks();
  (requireAcceptedDriver as jest.Mock).mockImplementation((_db:any,c:any)=>({userId:actor().id,tenantMembershipId:c.tenantMembershipId}));
  (loadCustodySource as jest.Mock).mockResolvedValue({order:{ownerOrgId:"company-a",assignedDriverId:actor().id}});
  (authorizeCustodyRead as jest.Mock).mockResolvedValue(undefined);
  (loadAccessSnapshot as jest.Mock).mockResolvedValue({ permissionCodes: ["drivers.telemetry"] });
  (requireTenantBoundOrderCompanyAuthority as jest.Mock).mockResolvedValue({ companyId: "company-a" });
  (store.readSelectedPresence as jest.Mock).mockResolvedValue({ enabled: true, updatedAt: "2026-01-01T00:00:00.000Z" });
  (store.readSelectedTelemetry as jest.Mock).mockResolvedValue(null);
  (requireAuthorizedOrder as jest.Mock).mockResolvedValue({ ownerOrgId: "company-a", assignedDriverId: actor().id });
});
afterEach(() => { expectNoDatabaseCalls(); expect(publishLiveMapEvent).not.toHaveBeenCalled(); });
function noStorage() { [store.readSelectedPresence, store.readSelectedTelemetry, store.writeSelectedPresence, store.writeSelectedTelemetry].forEach(fn => expect(fn).not.toHaveBeenCalled()); }
it("authorized self location uses fresh selected context, server receipt time, and no global delivery", async () => {
  const user = actor(); const capturedAt = "2099-01-01T00:00:00Z";
  const result = await ingestDriverLocation({ actor: user, body: { context: context(user), lat: 53, lng: 8, orderId, recordedAt: capturedAt } });
  expect(loadAccessSnapshot).toHaveBeenCalledWith({ ...context(user), membershipId: user.membershipId, requireFresh: true });
  expect(requireTenantBoundOrderCompanyAuthority).toHaveBeenCalledWith(expect.anything(), user, "drivers.telemetry");
  expect(authorizeCustodyRead).toHaveBeenCalled();
  expect(result).toMatchObject({ ok: true, broadcasted: false, clientCapturedAt: capturedAt, location: { warehouseId: null, orderId } });
  expect(result.location!.recordedAt).not.toBe(capturedAt);
  expect(store.writeSelectedTelemetry).toHaveBeenCalledWith(context(user), expect.objectContaining({ receivedAt: result.location!.recordedAt, clientCapturedAt: capturedAt }));
});
it("same user reads only each explicit company/tenant partition", async () => {
  for (const user of [actor(), actor("b"), actor("c", "b")]) {
    await getDriverPresence({ actor: user, query: { context: JSON.stringify(context(user)) } });
    expect(store.readSelectedPresence).toHaveBeenLastCalledWith(context(user));
  }
  expect(loadAccessSnapshot).toHaveBeenCalledTimes(3);
});
it.each(["tenantId", "tenantMembershipId", "companyId", "companyMembershipId"])("missing actor %s rejects without storage", async field => {
  await expect(ingestDriverTelemetry({ actor: { ...actor(), [field]: null }, body: { context: context(), lat: 53, lng: 8 } })).rejects.toMatchObject({ statusCode: 403 });
  expect(loadAccessSnapshot).not.toHaveBeenCalled(); noStorage();
});
it.each(["userId", "tenantId", "tenantMembershipId", "companyId", "companyMembershipId"])("queued foreign %s cannot be relabelled to the current selection", async field => {
  await expect(setDriverPresence({ actor: actor(), body: { context: { ...context(), [field]: "foreign" }, enabled: true } })).rejects.toMatchObject({ statusCode: 403 });
  expect(loadAccessSnapshot).not.toHaveBeenCalled(); noStorage();
});
it("legacy unbound queue and arbitrary ownership fields are rejected", async () => {
  await expect(heartbeatDriverPresence({ actor: actor(), body: {} })).rejects.toThrow();
  await expect(setDriverPresence({ actor: actor(), body: { context: context(), enabled: true, tenantId: "foreign" } })).rejects.toThrow();
  expect(loadAccessSnapshot).not.toHaveBeenCalled(); noStorage();
});
it.each([null, { permissionCodes: ["drivers.manage"] }])("revoked context or manager-only claims grant no telemetry permission", async snapshot => {
  (loadAccessSnapshot as jest.Mock).mockResolvedValue(snapshot);
  await expect(getDriverPresence({ actor: actor(), query: { context: context() } })).rejects.toMatchObject({ statusCode: 403 }); noStorage();
});
it("manager cannot act on a different driver", async () => {
  await expect(setDriverPresence({ actor: actor(), body: { context: context(), enabled: true, driverId: orderId } })).rejects.toMatchObject({ statusCode: 403 }); noStorage();
});
it.each([{ ownerOrgId: "company-b", assignedDriverId: actor().id }, { ownerOrgId: "company-a", assignedDriverId: "other" }])("wrong company or assigned actor rejects order telemetry before cache reads or writes", async order => {
  (loadCustodySource as jest.Mock).mockResolvedValue({order});
  await expect(ingestDriverTelemetry({ actor: actor(), body: { context: context(), lat: 53, lng: 8, orderId } })).rejects.toMatchObject({ statusCode: 403 }); noStorage();
});
it("foreign/null/unscoped parent rejection produces no telemetry effect", async () => {
  (loadCustodySource as jest.Mock).mockRejectedValue(Object.assign(new Error("Order not found"), { statusCode: 404 }));
  await expect(ingestDriverTelemetry({ actor: actor(), body: { context: context(), lat: 53, lng: 8, orderId } })).rejects.toMatchObject({ statusCode: 404 }); noStorage();
});
it("each subsequent read revalidates current permission, with no stale fallback", async () => {
  await getDriverPresence({ actor: actor(), query: { context: context() } });
  (loadAccessSnapshot as jest.Mock).mockResolvedValue(null);
  await expect(getDriverPresence({ actor: actor(), query: { context: context() } })).rejects.toMatchObject({ statusCode: 403 });
  expect(store.readSelectedPresence).toHaveBeenCalledTimes(1);
});
it("foreign company role definitions cannot turn snapshot permission claims into telemetry authority", async () => {
  (requireTenantBoundOrderCompanyAuthority as jest.Mock).mockRejectedValue(Object.assign(new Error("Company permission required"), { statusCode: 403 }));
  await expect(setDriverPresence({ actor: actor(), body: { context: context(), enabled: true } })).rejects.toMatchObject({ statusCode: 403 });
  noStorage();
});
it("new context sharing starts disabled and cannot upload coordinates before opt-in", async () => {
  (store.readSelectedPresence as jest.Mock).mockResolvedValue(null);
  expect(await getDriverPresence({ actor: actor(), query: { context: context() } })).toMatchObject({ presence: { enabled: false, updatedAt: null }, status: "offline" });
  await expect(ingestDriverLocation({ actor: actor(), body: { context: context(), lat: 53, lng: 8 } })).rejects.toMatchObject({ statusCode: 409 });
  expect(store.writeSelectedTelemetry).not.toHaveBeenCalled();
});
it("presence toggle and heartbeat are scoped and never update global User state", async () => {
  await setDriverPresence({ actor: actor(), body: { context: context(), enabled: false } });
  expect(store.writeSelectedPresence).toHaveBeenCalledWith(context(), { enabled: false, updatedAt: expect.any(String) });
  expect(await heartbeatDriverPresence({ actor: actor(), body: { context: context() } })).toMatchObject({ ok: true, presence: { driverId: actor().id } });
  expect(store.writeSelectedTelemetry).toHaveBeenCalledWith(context(), expect.objectContaining({ location: null }));
});
it("unavailable storage is never reported as accepted telemetry", async () => {
  (store.writeSelectedTelemetry as jest.Mock).mockRejectedValue(Object.assign(new Error("unavailable"), { statusCode: 503 }));
  await expect(ingestDriverTelemetry({ actor: actor(), body: { context: context(), lat: 53, lng: 8 } })).rejects.toMatchObject({ statusCode: 503 });
});
it.each([{ lat: 91, lng: 8 }, { lat: 53 }, { orderId }, { lat: 53, lng: 8, speedKmh: Infinity }])("invalid input rejects before authorization and storage", async values => {
  await expect(ingestDriverTelemetry({ actor: actor(), body: { context: context(), ...values } })).rejects.toThrow();
  expect(loadAccessSnapshot).not.toHaveBeenCalled(); noStorage();
});
