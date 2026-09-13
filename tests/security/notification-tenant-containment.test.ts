jest.mock("../../src/config/prismaClient", () => ({
  __esModule: true,
  default: require("./fixtures").database,
}));

import { NotificationType } from "@prisma/client";
import { database } from "./fixtures";
import { clearIdentityAccessCacheForUser } from "../../src/modules/identity-access/access-control";
import {
  countUnreadUserNotifications,
  createUserNotification,
  getUserNotification,
  listUserNotifications,
  markAllUserNotificationsRead,
  markUserNotificationRead,
  type NotificationAccessContext,
} from "../../src/modules/notifications-core/application/notificationService";

const ids = {
  user: "10000000-0000-4000-8000-000000000001",
  otherUser: "10000000-0000-4000-8000-000000000002",
  tenantA: "20000000-0000-4000-8000-000000000001",
  tenantB: "20000000-0000-4000-8000-000000000002",
  tenantMembershipA: "30000000-0000-4000-8000-000000000001",
  tenantMembershipB: "30000000-0000-4000-8000-000000000002",
  tenantMembershipCompanyTwo: "30000000-0000-4000-8000-000000000003",
  membershipA: "40000000-0000-4000-8000-000000000001",
  membershipB: "40000000-0000-4000-8000-000000000002",
  membershipCompanyTwo: "40000000-0000-4000-8000-000000000003",
  companyA: "50000000-0000-4000-8000-000000000001",
  companyB: "50000000-0000-4000-8000-000000000002",
  companyTwo: "50000000-0000-4000-8000-000000000003",
  orderA: "60000000-0000-4000-8000-000000000001",
  notificationA: "70000000-0000-4000-8000-000000000001",
};

function context(overrides: Partial<NotificationAccessContext> = {}): NotificationAccessContext {
  return {
    id: ids.user,
    membershipId: ids.membershipA,
    companyMembershipId: ids.membershipA,
    companyId: ids.companyA,
    tenantId: ids.tenantA,
    tenantMembershipId: ids.tenantMembershipA,
    ...overrides,
  };
}

function accessRecord(input: NotificationAccessContext, permissions = ["drivers.telemetry"]) {
  return {
    id: input.companyMembershipId,
    userId: input.id,
    companyId: input.companyId,
    branchId: null,
    status: "active",
    tenantId: input.tenantId,
    tenantMembershipId: input.tenantMembershipId,
    tenant: { id: input.tenantId, status: "active" },
    tenantMembership: {
      id: input.tenantMembershipId,
      tenantId: input.tenantId,
      userId: input.id,
      status: "active",
    },
    company: { id: input.companyId, tenantId: input.tenantId, isActive: true },
    branch: null,
    user: { id: input.id, name: "Synthetic User", email: "user@example.test",
      warehouseId: null, customerEntityId: null },
    scopes: [{ scopeType: "company", scopeRefId: input.companyId }],
    roles: [{ role: { code: "driver", rolePermissions: permissions.map((key) => ({ permission: { key } })) } }],
  };
}

function notificationRow(overrides: Record<string, unknown> = {}) {
  return {
    id: ids.notificationA,
    userId: ids.user,
    tenantId: ids.tenantA,
    companyId: ids.companyA,
    companyMembershipId: ids.membershipA,
    type: NotificationType.order,
    title: "Order updated",
    body: "Current status: Assigned",
    orderId: ids.orderA,
    data: null,
    createdAt: new Date("2026-09-13T12:00:00.000Z"),
    readAt: null,
    ...overrides,
  };
}

function resetMocks() {
  [database.companyMembership.findFirst, database.companyMembership.findUnique,
    database.order.findUnique, database.supportTicket.findUnique,
    database.userNotification.create, database.userNotification.findMany,
    database.userNotification.findFirst, database.userNotification.updateMany,
    database.userNotification.count].forEach((mock) => mock.mockReset());
  clearIdentityAccessCacheForUser(ids.user);
}

describe("notification tenant containment (mocked repository evidence)", () => {
  beforeEach(resetMocks);

  it("scopes one user's Tenant A and Tenant B lists to the exact selected memberships", async () => {
    const tenantA = context();
    const tenantB = context({ membershipId: ids.membershipB, companyMembershipId: ids.membershipB,
      companyId: ids.companyB, tenantId: ids.tenantB, tenantMembershipId: ids.tenantMembershipB });
    database.companyMembership.findFirst
      .mockResolvedValueOnce(accessRecord(tenantA))
      .mockResolvedValueOnce(accessRecord(tenantB));
    database.userNotification.findMany.mockResolvedValue([]);

    await listUserNotifications(tenantA);
    await listUserNotifications(tenantB);

    expect(database.userNotification.findMany.mock.calls[0][0].where).toMatchObject({
      userId: ids.user, tenantId: ids.tenantA, companyId: ids.companyA,
      companyMembershipId: ids.membershipA,
    });
    expect(database.userNotification.findMany.mock.calls[1][0].where).toMatchObject({
      userId: ids.user, tenantId: ids.tenantB, companyId: ids.companyB,
      companyMembershipId: ids.membershipB,
    });
  });

  it("keeps company-specific notifications separate inside one tenant", async () => {
    const companyTwo = context({ membershipId: ids.membershipCompanyTwo,
      companyMembershipId: ids.membershipCompanyTwo, companyId: ids.companyTwo,
      tenantMembershipId: ids.tenantMembershipCompanyTwo });
    database.companyMembership.findFirst.mockResolvedValue(accessRecord(companyTwo));
    database.userNotification.count.mockResolvedValue(2);

    await expect(countUnreadUserNotifications(companyTwo)).resolves.toBe(2);
    expect(database.userNotification.count).toHaveBeenCalledWith({ where: expect.objectContaining({
      userId: ids.user, tenantId: ids.tenantA, companyId: ids.companyTwo,
      companyMembershipId: ids.membershipCompanyTwo, readAt: null,
    }) });
  });

  it("does not expose or mutate another recipient's notification", async () => {
    database.companyMembership.findFirst.mockResolvedValue(accessRecord(context()));
    database.userNotification.findFirst.mockResolvedValue(null);

    await expect(getUserNotification(context(), ids.notificationA)).resolves.toBeNull();
    await expect(markUserNotificationRead(context(), ids.notificationA)).resolves.toBeNull();

    for (const call of database.userNotification.findFirst.mock.calls) {
      expect(call[0].where).toMatchObject({ id: ids.notificationA, userId: ids.user,
        tenantId: ids.tenantA, companyId: ids.companyA, companyMembershipId: ids.membershipA });
    }
    expect(database.userNotification.updateMany).not.toHaveBeenCalled();
  });

  it("keeps unowned legacy rows inaccessible to selected tenant queries", async () => {
    database.companyMembership.findFirst.mockResolvedValue(accessRecord(context()));
    database.userNotification.findMany.mockResolvedValue([]);

    const result = await listUserNotifications(context());

    expect(result.items).toEqual([]);
    expect(database.userNotification.findMany.mock.calls[0][0].where).toMatchObject({
      tenantId: ids.tenantA, companyId: ids.companyA, companyMembershipId: ids.membershipA,
    });
  });

  it("creates an owned order notification only from the authoritative assigned order", async () => {
    database.order.findUnique.mockResolvedValue({ id: ids.orderA, tenantId: ids.tenantA,
      ownerOrgId: ids.companyA, assignedDriverId: ids.user });
    database.companyMembership.findUnique.mockResolvedValue({ id: ids.membershipA,
      tenantMembershipId: ids.tenantMembershipA });
    database.companyMembership.findFirst.mockResolvedValue(accessRecord(context()));
    database.userNotification.create.mockResolvedValue(notificationRow());

    await expect(createUserNotification({ userId: ids.user, type: NotificationType.order,
      title: "Order updated", body: "Current status: Assigned",
      source: { kind: "order", orderId: ids.orderA } })).resolves.toMatchObject({ id: ids.notificationA });

    expect(database.userNotification.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      userId: ids.user, tenantId: ids.tenantA, companyId: ids.companyA,
      companyMembershipId: ids.membershipA, orderId: ids.orderA,
    }) });
  });

  it("does not create a notification when source ownership or recipient assignment is absent", async () => {
    database.order.findUnique.mockResolvedValue({ id: ids.orderA, tenantId: null,
      ownerOrgId: null, assignedDriverId: ids.otherUser });

    await expect(createUserNotification({ userId: ids.user, type: NotificationType.order,
      title: "Order updated", body: "Current status: Assigned",
      source: { kind: "order", orderId: ids.orderA } })).resolves.toBeNull();

    expect(database.companyMembership.findUnique).not.toHaveBeenCalled();
    expect(database.userNotification.create).not.toHaveBeenCalled();
  });

  it("derives support notification ownership from the stored ticket and its owner organization", async () => {
    database.supportTicket.findUnique.mockResolvedValue({
      id: "80000000-0000-4000-8000-000000000001",
      orderId: null,
      ownerId: ids.user,
      ownerOrgId: ids.companyA,
      ownerOrg: { tenantId: ids.tenantA },
      queue: { defaultOwnerId: null },
    });
    database.companyMembership.findUnique.mockResolvedValue({ id: ids.membershipA,
      tenantMembershipId: ids.tenantMembershipA });
    database.companyMembership.findFirst.mockResolvedValue(accessRecord(context(), ["support.update"]));
    database.userNotification.create.mockResolvedValue(notificationRow({
      type: NotificationType.support,
      orderId: null,
    }));

    await expect(createUserNotification({
      userId: ids.user,
      type: NotificationType.support,
      title: "Support ticket assigned",
      body: "Synthetic ticket",
      source: { kind: "support_ticket", ticketId: "80000000-0000-4000-8000-000000000001" },
    })).resolves.toMatchObject({ type: NotificationType.support });
    expect(database.userNotification.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      tenantId: ids.tenantA,
      companyId: ids.companyA,
      companyMembershipId: ids.membershipA,
      orderId: null,
    }) });
  });

  it("suppresses support notifications whose stored ticket has no tenant-owned organization", async () => {
    database.supportTicket.findUnique.mockResolvedValue({
      id: "80000000-0000-4000-8000-000000000001",
      orderId: null,
      ownerId: ids.user,
      ownerOrgId: ids.companyA,
      ownerOrg: { tenantId: null },
      queue: { defaultOwnerId: null },
    });

    await expect(createUserNotification({
      userId: ids.user,
      type: NotificationType.support,
      title: "Support ticket assigned",
      body: "Synthetic ticket",
      source: { kind: "support_ticket", ticketId: "80000000-0000-4000-8000-000000000001" },
    })).resolves.toBeNull();
    expect(database.companyMembership.findUnique).not.toHaveBeenCalled();
    expect(database.userNotification.create).not.toHaveBeenCalled();
  });

  it("preserves valid list, detail, read marking, read-all and unread-count shapes", async () => {
    database.companyMembership.findFirst.mockResolvedValue(accessRecord(context()));
    database.userNotification.findMany.mockResolvedValue([notificationRow()]);
    database.userNotification.findFirst.mockResolvedValue(notificationRow());
    database.userNotification.updateMany.mockResolvedValue({ count: 1 });
    database.userNotification.count.mockResolvedValue(1);

    await expect(listUserNotifications(context())).resolves.toMatchObject({
      items: [expect.objectContaining({ id: ids.notificationA, unread: true })], limit: 20,
    });
    await expect(getUserNotification(context(), ids.notificationA))
      .resolves.toMatchObject({ id: ids.notificationA, unread: true });
    await expect(markUserNotificationRead(context(), ids.notificationA))
      .resolves.toMatchObject({ id: ids.notificationA, readAt: expect.any(Date) });
    await expect(markAllUserNotificationsRead(context())).resolves.toBe(1);
    await expect(countUnreadUserNotifications(context())).resolves.toBe(1);
  });
});
