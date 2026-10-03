import { persistDispatchNotification, withDispatchNotifications, committedDispatchNotifications } from "../../src/modules/orders-core/domain/dispatch-notification";
const order = { id: "order-a", tenantId: "tenant-a", ownerOrgId: "company-a", assignedDriverId: "driver-a", orderNumber: "SYNTHETIC", status: "assigned" };
const membership = () => ({ id: "member-a", userId: "driver-a", companyId: "company-a", tenantId: "tenant-a", tenantMembershipId: "tm-a", status: "active",
  tenant: { id: "tenant-a", status: "active" }, company: { id: "company-a", tenantId: "tenant-a", isActive: true }, branch: null,
  tenantMembership: { id: "tm-a", userId: "driver-a", tenantId: "tenant-a", status: "active" },
  roles: [{ role: { companyId: "company-a", isSystem: false, rolePermissions: [{ permission: { key: "drivers.telemetry" } }] } }],
});
const db = { tracking: { findUnique: jest.fn() }, companyMembership: { findUnique: jest.fn() }, userNotification: { findUnique: jest.fn(), create: jest.fn() } };
beforeEach(() => { jest.resetAllMocks(); db.tracking.findUnique.mockResolvedValue({ id: "tracking-a", orderId: order.id, order }); db.companyMembership.findUnique.mockResolvedValue(membership()); db.userNotification.findUnique.mockResolvedValue(null); db.userNotification.create.mockResolvedValue({ id: "notification-a" }); });
it("derives exact source/recipient ownership and fixed content inside supplied transaction", async () => {
  expect(await persistDispatchNotification(db as any, "tracking-a", "assignment")).toBe("notification-a");
  expect(db.userNotification.create).toHaveBeenCalledWith({ data: { dispatchTrackingId: "tracking-a", orderId: order.id, tenantId: "tenant-a", companyId: "company-a", userId: "driver-a", companyMembershipId: "member-a", type: "order", title: "Order SYNTHETIC assigned", body: "Current status: Assigned" }, select: { id: true } });
});
it.each(["null-owner", "foreign-tenant", "wrong-user", "wrong-company", "unbound", "suspended", "tenant-disabled", "permission", "foreign-role", "branch"])("%s safely suppresses recipient without a write", async kind => {
  const member: any = membership();
  if (kind === "null-owner") db.tracking.findUnique.mockResolvedValue({ id: "tracking-a", order: { ...order, tenantId: null } });
  if (kind === "foreign-tenant") member.tenantId = "tenant-b";
  if (kind === "wrong-user") member.tenantMembership.userId = "other";
  if (kind === "wrong-company") member.company.id = "company-b";
  if (kind === "unbound") member.tenantMembershipId = null;
  if (kind === "suspended") member.status = "suspended";
  if (kind === "tenant-disabled") member.tenant.status = "suspended";
  if (kind === "permission") member.roles = [];
  if (kind === "foreign-role") member.roles[0].role.companyId = "company-b";
  if (kind === "branch") member.branch = { tenantId: "tenant-b", isActive: true };
  db.companyMembership.findUnique.mockResolvedValue(member);
  expect(await persistDispatchNotification(db as any, "tracking-a", "status")).toBeNull(); expect(db.userNotification.create).not.toHaveBeenCalled();
});
it("matching source returns original ID without another write", async () => { db.userNotification.findUnique.mockResolvedValue({ id: "original" }); expect(await persistDispatchNotification(db as any, "tracking-a", "status")).toBe("original"); expect(db.userNotification.create).not.toHaveBeenCalled(); });
it("persistence errors are not suppressed inside business transaction", async () => { db.userNotification.create.mockRejectedValue(Error("synthetic persistence failure")); await expect(persistDispatchNotification(db as any, "tracking-a", "status")).rejects.toThrow("persistence failure"); });
it("delivery bookkeeping is absent by default and never serialized", () => { expect(committedDispatchNotifications({})).toEqual([]); const result = withDispatchNotifications({ id: "order-a" }, ["notification-a"]); expect(committedDispatchNotifications(result)).toEqual(["notification-a"]); expect(JSON.stringify(result)).toBe('{"id":"order-a"}'); });
