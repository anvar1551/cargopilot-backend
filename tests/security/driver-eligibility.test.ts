jest.mock("../../src/config/prismaClient", () => ({ __esModule: true, default: require("./fixtures").database }));
import { database as db } from "./fixtures";
import { requireAcceptedDriver } from "../../src/modules/identity-access/application/driver-eligibility";
import { DRIVER_PROFILES } from "../../src/modules/identity-access/application/driver-profiles";
import { loadAccessSnapshot, clearIdentityAccessCacheForUser } from "../../src/modules/identity-access/access-control";
const context = { tenantId: "tenant-a", companyId: "company-a" };
function record(profile: keyof typeof DRIVER_PROFILES = "local-driver.v1"): any {
  return { id: "cm-a", userId: "user-a", tenantId: "tenant-a", companyId: "company-a", status: "active", tenantMembershipId: "tm-a",
    tenant: { id: "tenant-a", status: "active" }, company: { id: "company-a", tenantId: "tenant-a", isActive: true }, branch: null,
    tenantMembership: { id: "tm-a", tenantId: "tenant-a", userId: "user-a", status: "active" },
    user: { id: "user-a", name: "Synthetic driver", email: "synthetic@example.invalid", warehouseId: "untrusted-global", customerEntityId: "untrusted-global" },
    driverEligibility: { membershipId: "cm-a", userId: "user-a", tenantId: "tenant-a", companyId: "company-a", tenantMembershipId: "tm-a",
      enabled: true, roleId: "driver-role", driverType: profile === "local-driver.v1" ? "local" : "linehaul", profileRevision: profile,
      acceptedAction: { action: "grant", result: { companyMembershipId: "cm-a", profileRevision: profile } } },
    scopes: [], roles: [{ role: { id: "driver-role", companyId: "company-a", code: profile, isSystem: false, isOwnerRole: false,
      rolePermissions: DRIVER_PROFILES[profile].map(key => ({ permission: { key } })) } }] };
}
beforeEach(() => { jest.clearAllMocks(); clearIdentityAccessCacheForUser("user-a"); db.$queryRaw.mockResolvedValue([]); db.companyMembership.findFirst.mockResolvedValue(record()); });
it.each(["local-driver.v1", "linehaul-driver.v1"] as const)("%s resolves accepted membership classification with a transaction-held shared lock", async profile => {
  db.companyMembership.findFirst.mockResolvedValue(record(profile));
  expect(await requireAcceptedDriver(db as any, context, "cm-a")).toMatchObject({ id: "cm-a", userId: "user-a", profileRevision: profile });
  expect(db.$queryRaw.mock.calls[0][0].join("?")).toContain("FOR SHARE");
  expect(db.companyMembership.findFirst.mock.calls[0][0].where).toMatchObject({ id: "cm-a", ...context, status: "active", company: { type: "company", tenantId: "tenant-a", isActive: true } });
});
it.each(["revoked", "foreign-tenant", "foreign-company", "wrong-user", "wrong-bridge", "wrong-type", "unaccepted", "wrong-acceptance", "extra-role", "forbidden-key", "company-scope", "system-role"])("%s fails closed without business effects", async kind => {
  const m = record(), e = m.driverEligibility;
  if (kind === "revoked") e.enabled = false;
  if (kind === "foreign-tenant") e.tenantId = "tenant-b";
  if (kind === "foreign-company") e.companyId = "company-b";
  if (kind === "wrong-user") e.userId = "other";
  if (kind === "wrong-bridge") m.tenantMembership.userId = "other";
  if (kind === "wrong-type") e.driverType = "linehaul";
  if (kind === "unaccepted") e.acceptedAction.action = "revoke";
  if (kind === "wrong-acceptance") e.acceptedAction.result.companyMembershipId = "other";
  if (kind === "extra-role") m.roles.push(m.roles[0]);
  if (kind === "forbidden-key") m.roles[0].role.rolePermissions.push({ permission: { key: "shipment.update" } });
  if (kind === "company-scope") m.scopes.push({ scopeType: "company", scopeRefId: "company-a" });
  if (kind === "system-role") m.roles[0].role.isSystem = true;
  db.companyMembership.findFirst.mockResolvedValue(m);
  await expect(requireAcceptedDriver(db as any, context, "cm-a")).rejects.toMatchObject({ statusCode: 403 });
  expect(db.companyMembership.update).not.toHaveBeenCalled(); expect(db.$executeRaw).not.toHaveBeenCalled();
});
it("managed driver access never inherits implicit company or user-global resource scopes", async () => {
  const snapshot = await loadAccessSnapshot({ userId: "user-a", membershipId: "cm-a", companyMembershipId: "cm-a", ...context, tenantMembershipId: "tm-a", requireFresh: true });
  expect(snapshot).toMatchObject({ scopes: [], warehouseId: null, customerEntityId: null });
});
it("classification replacement between reads cannot mix old permissions with new accepted authority", async () => {
  db.companyMembership.findFirst.mockResolvedValueOnce(record()).mockResolvedValueOnce(record("linehaul-driver.v1"));
  expect(await loadAccessSnapshot({ userId: "user-a", membershipId: "cm-a", companyMembershipId: "cm-a", ...context, tenantMembershipId: "tm-a", requireFresh: true })).toBeNull();
});
