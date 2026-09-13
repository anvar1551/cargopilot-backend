jest.mock("../../src/config/prismaClient", () => ({
  __esModule: true,
  default: require("./fixtures").database,
}));
jest.mock("../../src/modules/analytics-core/infrastructure/analyticsOutbox", () => ({
  enqueueCargoPilotDomainEventsTx: jest.fn(async () => undefined),
}));
jest.mock("../../src/utils/s3Cleanup", () => ({
  collectS3ObjectKeys: jest.fn(() => []),
  deleteS3ObjectsBestEffort: jest.fn(),
}));

import { database } from "./fixtures";
import {
  buildOrderScopeWhere,
  clearIdentityAccessCacheForUser,
} from "../../src/modules/identity-access/access-control";
import {
  getOrderForActor,
  listDriverWorkloadForActor,
  listOrdersForActor,
} from "../../src/modules/orders-core/read/queries";
import {
  assignDriversBulk,
  updateDriverOrderStatus,
  updateOrdersStatusBulk,
} from "../../src/modules/orders-core/operations/order-status";
import { assertCreationInputAuthority } from "../../src/modules/orders-core/domain/creation-authority";
import { deleteOrderForActor } from "../../src/modules/orders-core/write/delete-order";
import { deleteS3ObjectsBestEffort } from "../../src/utils/s3Cleanup";

const ids = {
  user: "10000000-0000-4000-8000-000000000001",
  tenant: "20000000-0000-4000-8000-000000000001",
  otherTenant: "20000000-0000-4000-8000-000000000002",
  tenantMembership: "30000000-0000-4000-8000-000000000001",
  membership: "40000000-0000-4000-8000-000000000001",
  company: "50000000-0000-4000-8000-000000000001",
  warehouse: "60000000-0000-4000-8000-000000000001",
  order: "70000000-0000-4000-8000-000000000001",
};

const actor: any = {
  id: ids.user,
  membershipId: ids.membership,
  companyMembershipId: ids.membership,
  companyId: ids.company,
  tenantId: ids.tenant,
  tenantMembershipId: ids.tenantMembership,
  branchId: null,
  email: "order-user@example.test",
  name: "Synthetic Order User",
  warehouseId: null,
  customerEntityId: null,
  roleCodes: ["dispatcher"],
  permissionCodes: ["shipment.view", "shipment.changeStatus"],
  scopes: [{ scopeType: "company", scopeRefId: ids.company }],
};

function accessRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: ids.membership,
    userId: ids.user,
    companyId: ids.company,
    branchId: null,
    status: "active",
    tenantId: ids.tenant,
    tenantMembershipId: ids.tenantMembership,
    tenant: { id: ids.tenant, status: "active" },
    tenantMembership: {
      id: ids.tenantMembership,
      tenantId: ids.tenant,
      userId: ids.user,
      status: "active",
    },
    company: { id: ids.company, tenantId: ids.tenant, isActive: true },
    branch: null,
    user: {
      id: ids.user,
      name: actor.name,
      email: actor.email,
      warehouseId: null,
      customerEntityId: null,
    },
    scopes: [{ scopeType: "company", scopeRefId: ids.company }],
    roles: [{
      role: {
        code: "dispatcher",
        rolePermissions: actor.permissionCodes.map((key: string) => ({ permission: { key } })),
      },
    }],
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  clearIdentityAccessCacheForUser(ids.user);
  database.companyMembership.findFirst.mockResolvedValue(accessRecord());
  database.order.findMany.mockResolvedValue([]);
  database.order.count.mockResolvedValue(0);
  database.order.groupBy.mockResolvedValue([]);
  database.order.findFirst.mockResolvedValue(null);
  database.$transaction.mockImplementation(async (arg: any) =>
    Array.isArray(arg) ? Promise.all(arg) : arg(database),
  );
});

it("combines authoritative tenant ownership with selected-company object scope", async () => {
  await listOrdersForActor({ actor, query: {} });
  const where = database.order.findMany.mock.calls[0][0].where;
  expect(JSON.stringify(where)).toContain(`\"tenantId\":\"${ids.tenant}\"`);
  expect(JSON.stringify(where)).toContain(`\"ownerOrgId\":{\"in\":[\"${ids.company}\"]}`);
  expect(JSON.stringify(where)).not.toContain(ids.otherTenant);
});

it("scopes detail, count and workload queries and hides tenant-null rows", async () => {
  await getOrderForActor({ actor, orderId: ids.order });
  await listOrdersForActor({ actor, query: { q: "demo" } });
  await listDriverWorkloadForActor(actor);

  for (const call of [
    database.order.findFirst.mock.calls[0][0],
    database.order.count.mock.calls[0][0],
    database.order.groupBy.mock.calls[0][0],
  ]) {
    expect(JSON.stringify(call.where)).toContain(`\"tenantId\":\"${ids.tenant}\"`);
  }
});

it("fails closed for missing, foreign or revoked selected membership context", async () => {
  database.companyMembership.findFirst.mockResolvedValue(null);
  const missing = await buildOrderScopeWhere(actor);
  expect(missing).toEqual({ id: "__no_access__" });

  database.companyMembership.findFirst.mockResolvedValue(accessRecord({
    tenantId: ids.otherTenant,
    tenant: { id: ids.otherTenant, status: "active" },
  }));
  const foreign = await buildOrderScopeWhere(actor);
  expect(foreign).toEqual({ id: "__no_access__" });
});

it("rejects client-selected order ownership fields before any database work", () => {
  for (const field of ["tenantId", "ownerOrgId", "assignedOrgId", "currentWarehouseId", "assignedDriverId"]) {
    expect(() => assertCreationInputAuthority({ shipment: { [field]: ids.otherTenant } }))
      .toThrow("Client order ownership is not accepted");
  }
});

it("rejects a foreign or legacy-unowned driver update without changing records", async () => {
  database.order.findFirst.mockResolvedValue(null);
  await expect(updateDriverOrderStatus({
    orderId: ids.order,
    status: "pickup_in_progress" as any,
    actor,
  })).rejects.toMatchObject({ statusCode: 404 });

  const where = database.order.findFirst.mock.calls[0][0].where;
  expect(JSON.stringify(where)).toContain(`\"tenantId\":\"${ids.tenant}\"`);
  expect(database.order.updateMany).not.toHaveBeenCalled();
  expect(database.tracking.create).not.toHaveBeenCalled();
});

it("rejects a foreign or legacy-unowned delete before business or storage effects", async () => {
  const deleteActor = {
    ...actor,
    permissionCodes: [...actor.permissionCodes, "shipment.delete"],
  };
  database.companyMembership.findFirst.mockResolvedValue(accessRecord({
    roles: [{
      role: {
        code: "dispatcher",
        rolePermissions: deleteActor.permissionCodes.map((key: string) => ({ permission: { key } })),
      },
    }],
  }));
  database.order.findFirst.mockResolvedValue(null);

  await expect(deleteOrderForActor({ actor: deleteActor, orderId: ids.order }))
    .rejects.toMatchObject({ statusCode: 404 });
  expect(database.order.deleteMany).not.toHaveBeenCalled();
  expect(database.tracking.deleteMany).not.toHaveBeenCalled();
  expect(deleteS3ObjectsBestEffort).not.toHaveBeenCalled();
});

it("rejects an unscoped warehouse reference without changing the order", async () => {
  database.order.findMany.mockResolvedValue([{
    id: ids.order,
    status: "pending",
    currentWarehouseId: null,
    codAmount: null,
    codPaidStatus: null,
    serviceCharge: null,
    serviceChargePaidStatus: null,
    deliveryChargePaidBy: null,
    cashCollections: [],
  }]);

  await expect(updateOrdersStatusBulk({
    orderIds: [ids.order],
    status: "in_transit" as any,
    warehouseId: ids.warehouse,
    actor,
  })).rejects.toMatchObject({ statusCode: 403 });
  expect(database.order.updateMany).not.toHaveBeenCalled();
  expect(database.tracking.createMany).not.toHaveBeenCalled();
});

it("rejects a driver without an active membership in the selected company", async () => {
  database.user.findUnique.mockResolvedValue({ id: "driver-b", driverType: "local" });
  database.companyMembership.findFirst.mockResolvedValueOnce(null);

  await expect(assignDriversBulk({
    orderIds: [ids.order],
    driverId: "driver-b",
    actor,
  })).rejects.toMatchObject({ statusCode: 403 });
  expect(database.order.updateMany).not.toHaveBeenCalled();
  expect(database.tracking.createMany).not.toHaveBeenCalled();
});
