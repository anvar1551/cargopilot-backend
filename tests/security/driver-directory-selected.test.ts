jest.mock("../../src/config/prismaClient", () => ({ __esModule: true, default: require("./fixtures").database }));
jest.mock("../../src/modules/identity-access/access-control", () => ({ loadAccessSnapshot: jest.fn(async () => ({ permissionCodes: ["drivers.manage"] })) }));
jest.mock("../../src/modules/orders-core/domain/company-authority", () => ({ requireTenantBoundOrderCompanyAuthority: jest.fn(), hasCompanyScope: (m: any) => m.scopes.some((s: any) => s.scopeType === "company" && s.scopeRefId === m.companyId) }));
import { database as db } from "./fixtures";
import { loadAccessSnapshot } from "../../src/modules/identity-access/access-control";
import { requireTenantBoundOrderCompanyAuthority } from "../../src/modules/orders-core/domain/company-authority";
import { listDriversView, updateDriverProfileById } from "../../src/modules/driver-core/application/driverProfileService";
import { listAllDrivers } from "../../src/modules/driver-core/application/driverRepo";
const actor: any = { id: "same-user", tenantId: "tenant-a", companyId: "company-a", tenantMembershipId: "tm-a", companyMembershipId: "cm-a", membershipId: "cm-a" };
const membership = { companyId: actor.companyId, tenantId: actor.tenantId, scopes: [{ scopeType: "company", scopeRefId: actor.companyId }] };
const row = { id: "00000000-0000-4000-8000-000000000001", userId: "selected-driver", driverEligibility: { driverType: "linehaul" }, tenantMembership: { userId: "selected-driver" }, user: { id: "selected-driver", name: "Synthetic driver", email: "synthetic@example.test", passwordHash: "PRIVATE-CANARY", warehouseId: "foreign", driverType: "local" } };
beforeEach(() => { jest.clearAllMocks(); (requireTenantBoundOrderCompanyAuthority as jest.Mock).mockReset().mockResolvedValue(membership); db.companyMembership.findMany.mockReset().mockResolvedValue([row]); db.companyMembership.findFirst.mockReset().mockResolvedValue({ id: row.id }); });
afterEach(() => { expect(db.user.findMany).not.toHaveBeenCalled(); expect(db.user.findUnique).not.toHaveBeenCalled(); expect(db.user.update).not.toHaveBeenCalled(); expect(db.$transaction).not.toHaveBeenCalled(); });
it("eligible selected membership query is bounded and retains only safe shared identity", async () => {
  const result = await listDriversView(actor);
  const authorityArgs = (requireTenantBoundOrderCompanyAuthority as jest.Mock).mock.calls[0];
  expect(authorityArgs[0] === db).toBe(true); expect(authorityArgs[1]).toBe(actor); expect(authorityArgs[2]).toBe("drivers.manage");
  const query = db.companyMembership.findMany.mock.calls[0][0];
  expect(query).toMatchObject({ take: 50, orderBy: { id: "asc" }, where: { AND: [{ tenantId: actor.tenantId, companyId: actor.companyId, status: "active", tenantMembershipId: { not: null }, tenant: { status: "active" }, company: { tenantId: actor.tenantId, isActive: true }, tenantMembership: { tenantId: actor.tenantId, status: "active" }, roles: { some: { role: { OR: [{ companyId: actor.companyId }, { companyId: null, isSystem: true }], rolePermissions: { some: { permission: { key: "drivers.telemetry" } } } } } } }] } });
  expect(query.select.user.select).toEqual({ id: true, name: true, email: true });
  expect(result).toEqual([{ id: row.userId, companyMembershipId: row.id, name: row.user.name, email: row.user.email, role: "driver", warehouseId: null, warehouseIds: [], driverType: "linehaul", isPartial: false }]);
  expect(JSON.stringify(result)).not.toContain("PRIVATE-CANARY");
});
it("same user's alternate company/tenant never reuses a global driver query", async () => {
  for (const [companyId, tenantId] of [["company-a", "tenant-a"], ["company-b", "tenant-a"], ["company-c", "tenant-b"]]) {
    (requireTenantBoundOrderCompanyAuthority as jest.Mock).mockResolvedValue({ ...membership, companyId, tenantId, scopes: [{ scopeType: "company", scopeRefId: companyId }] });
    await listAllDrivers({ ...actor, companyId, tenantId });
    expect(db.companyMembership.findMany.mock.calls.at(-1)![0].where.AND[0]).toMatchObject({ companyId, tenantId });
  }
});
it.each([null, { ...membership, scopes: [] }, { ...membership, scopes: [{ scopeType: "company", scopeRefId: "other" }] }])("revoked or missing selected company scope denies before directory queries", async value => {
  if (value) (requireTenantBoundOrderCompanyAuthority as jest.Mock).mockResolvedValue(value);
  else (requireTenantBoundOrderCompanyAuthority as jest.Mock).mockRejectedValue(Object.assign(new Error("Forbidden"), { statusCode: 403 }));
  await expect(listDriversView(actor)).rejects.toMatchObject({ statusCode: 403 }); expect(db.companyMembership.findMany).not.toHaveBeenCalled();
});
it("compound user mismatch is suppressed even if an inconsistent target is returned", async () => {
  db.companyMembership.findMany.mockResolvedValue([{ ...row, tenantMembership: { userId: "foreign-user" } }]);
  expect(await listDriversView(actor)).toEqual([]);
});
it("fresh branch/context eligibility failure denies before directory queries", async () => {
  (loadAccessSnapshot as jest.Mock).mockResolvedValueOnce(null);
  await expect(listDriversView(actor)).rejects.toMatchObject({ statusCode: 403 });
  expect(db.companyMembership.findMany).not.toHaveBeenCalled();
});
it("foreign/ineligible cursor fails before listing", async () => {
  db.companyMembership.findFirst.mockResolvedValue(null);
  await expect(listDriversView(actor, { cursor: row.id })).rejects.toMatchObject({ statusCode: 404 });
  expect(db.companyMembership.findFirst.mock.calls[0][0].where.AND[0]).toMatchObject({ tenantId: actor.tenantId, companyId: actor.companyId }); expect(db.companyMembership.findMany).not.toHaveBeenCalled();
});
it("owned cursor retains exact scope in the actual list query", async () => {
  await listDriversView(actor, { cursor: row.id, limit: 1 });
  expect(db.companyMembership.findMany.mock.calls[0][0]).toMatchObject({ take: 1, where: { AND: [expect.objectContaining({ tenantId: actor.tenantId, companyId: actor.companyId }), { id: { gt: row.id } }] } });
});
it.each([{ limit: 101 }, { limit: 0 }, { tenantId: "foreign" }, { cursor: "bad" }])("invalid filters cannot broaden the directory", async query => {
  await expect(listDriversView(actor, query)).rejects.toThrow(); expect(db.companyMembership.findMany).not.toHaveBeenCalled();
});
it.each([{ driverType: "linehaul" }, {}, { tenantId: "foreign" }])("user-global profile mutation is unavailable even to an authorized company manager", async body => {
  await expect(updateDriverProfileById(row.userId, body, actor)).rejects.toMatchObject({ statusCode: 409 }); expect(db.companyMembership.findMany).not.toHaveBeenCalled();
});
it.each([{ warehouseIds: [] }, { primaryWarehouseId: "foreign" }])("preserves warehouse assignment containment", async body => {
  await expect(updateDriverProfileById(row.userId, body, actor)).rejects.toMatchObject({ statusCode: 403 });
});
it("missing context is passed to deny-by-default authority, never a global fallback", async () => {
  (requireTenantBoundOrderCompanyAuthority as jest.Mock).mockRejectedValue(Object.assign(new Error("Forbidden"), { statusCode: 403 }));
  await expect(updateDriverProfileById(row.userId, {}, undefined)).rejects.toMatchObject({ statusCode: 403 }); expect(db.companyMembership.findMany).not.toHaveBeenCalled();
});
