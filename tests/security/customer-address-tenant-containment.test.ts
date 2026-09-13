jest.mock("../../src/config/prismaClient", () => ({
  __esModule: true,
  default: require("./fixtures").database,
}));
jest.mock("../../src/modules/identity-access/access-control", () => ({
  loadAccessSnapshot: jest.fn(),
  buildCustomerEntityScopeWhere: jest.fn(),
}));

import { CustomerType } from "@prisma/client";
import { database } from "./fixtures";
import {
  buildCustomerEntityScopeWhere,
  loadAccessSnapshot,
} from "../../src/modules/identity-access/access-control";
import {
  createCustomerEntity,
  deleteCustomerEntity,
  getCustomerEntityById,
  listCustomerEntities,
  updateCustomerEntity,
} from "../../src/modules/customers-core/application/customerEntityRepo";
import {
  createAddress,
  deleteAddress,
  getAddressById,
  listAddresses,
  updateAddress,
} from "../../src/modules/addresses-core/application/addressRepo";

const mockedLoad = loadAccessSnapshot as jest.Mock;
const mockedScope = buildCustomerEntityScopeWhere as jest.Mock;
const ids = {
  user: "10000000-0000-4000-8000-000000000001",
  tenantA: "20000000-0000-4000-8000-000000000001",
  tenantB: "20000000-0000-4000-8000-000000000002",
  tenantMembershipA: "30000000-0000-4000-8000-000000000001",
  membershipA: "40000000-0000-4000-8000-000000000001",
  companyA: "50000000-0000-4000-8000-000000000001",
  customerA: "60000000-0000-4000-8000-000000000001",
  customerOther: "60000000-0000-4000-8000-000000000002",
  addressA: "70000000-0000-4000-8000-000000000001",
};

function context(overrides: Record<string, unknown> = {}): any {
  return {
    id: ids.user,
    membershipId: ids.membershipA,
    companyMembershipId: ids.membershipA,
    companyId: ids.companyA,
    tenantId: ids.tenantA,
    tenantMembershipId: ids.tenantMembershipA,
    branchId: null,
    email: "user@example.test",
    name: "Synthetic User",
    warehouseId: null,
    customerEntityId: null,
    roleCodes: ["manager"],
    permissionCodes: ["customers.read", "customers.write"],
    scopes: [{ scopeType: "company", scopeRefId: ids.companyA }],
    ...overrides,
  };
}

function snapshot(input = context()) {
  return {
    userId: input.id,
    membershipId: input.membershipId,
    companyMembershipId: input.companyMembershipId,
    companyId: input.companyId,
    tenantId: input.tenantId,
    tenantMembershipId: input.tenantMembershipId,
    branchId: input.branchId,
    email: input.email,
    name: input.name,
    warehouseId: input.warehouseId,
    customerEntityId: input.customerEntityId,
    roleCodes: input.roleCodes,
    permissionCodes: input.permissionCodes,
    scopes: input.scopes,
  };
}

function resetMocks() {
  mockedLoad.mockReset();
  mockedScope.mockReset();
  mockedLoad.mockImplementation(async (input: any) => snapshot(context({
    tenantId: input.tenantId,
    companyId: input.companyId,
    membershipId: input.membershipId,
    companyMembershipId: input.companyMembershipId,
    tenantMembershipId: input.tenantMembershipId,
  })));
  mockedScope.mockResolvedValue(null);
  [database.$transaction, database.customerEntity.findMany, database.customerEntity.count,
    database.customerEntity.findFirst, database.customerEntity.create,
    database.customerEntity.updateMany, database.customerEntity.deleteMany,
    database.address.findMany, database.address.findFirst, database.address.create,
    database.address.updateMany, database.address.deleteMany].forEach((mock) => mock.mockReset());
}

describe("customer and address tenant containment (mocked repository evidence)", () => {
  beforeEach(resetMocks);

  it("requires complete verified context before any repository query", async () => {
    const missing = context({ tenantId: "" });
    await expect(listCustomerEntities(missing)).rejects.toMatchObject({ statusCode: 403 });
    await expect(listAddresses(missing, {})).rejects.toMatchObject({ statusCode: 403 });
    expect(mockedLoad).not.toHaveBeenCalled();
    expect(database.customerEntity.findMany).not.toHaveBeenCalled();
    expect(database.address.findMany).not.toHaveBeenCalled();
  });

  it("scopes customer search and count to the selected tenant and existing object scope", async () => {
    mockedScope.mockResolvedValue({ id: ids.customerA });
    database.$transaction.mockResolvedValue([[], 0]);
    await listCustomerEntities(context(), { q: "Synthetic", page: 1, limit: 10 });
    expect(database.customerEntity.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { AND: [expect.objectContaining({ tenantId: ids.tenantA, AND: [{ id: ids.customerA }] }), expect.any(Object)] },
      include: expect.objectContaining({ _count: { select: {
        orders: { where: { tenantId: ids.tenantA } },
        users: { where: { memberships: { some: { tenantId: ids.tenantA } } } },
        addresses: { where: { tenantId: ids.tenantA } },
      } } }),
    }));
    expect(database.customerEntity.count).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ AND: expect.any(Array) }),
    }));
  });

  it("derives customer tenant ownership and rejects client ownership fields", async () => {
    database.customerEntity.create.mockResolvedValue({ id: ids.customerA, tenantId: ids.tenantA, defaultAddress: null });
    await createCustomerEntity(context(), { type: CustomerType.COMPANY, name: "Synthetic Customer" });
    expect(database.customerEntity.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ tenantId: ids.tenantA, name: "Synthetic Customer" }),
    }));
    database.customerEntity.create.mockClear();
    await expect(createCustomerEntity(context(), {
      type: CustomerType.COMPANY,
      name: "Rejected",
      tenantId: ids.tenantB,
    } as any)).rejects.toMatchObject({ statusCode: 400 });
    expect(database.customerEntity.create).not.toHaveBeenCalled();
  });

  it("does not let an object-scoped writer create a new customer master", async () => {
    mockedScope.mockResolvedValue({ id: ids.customerA });
    await expect(createCustomerEntity(context(), {
      type: CustomerType.COMPANY,
      name: "Out of scope",
    })).rejects.toMatchObject({ statusCode: 403 });
    expect(database.customerEntity.create).not.toHaveBeenCalled();
  });

  it("denies writes without customers.write and creates no business record", async () => {
    mockedLoad.mockResolvedValue(snapshot(context({ permissionCodes: ["customers.read"] })));
    await expect(createAddress(context(), { customerEntityId: ids.customerA, city: "Bremen" }))
      .rejects.toMatchObject({ statusCode: 403 });
    expect(database.customerEntity.findFirst).not.toHaveBeenCalled();
    expect(database.address.create).not.toHaveBeenCalled();
  });

  it("requires an accessible selected customer before creating an address", async () => {
    mockedScope.mockResolvedValue({ id: ids.customerA });
    database.customerEntity.findFirst.mockResolvedValue(null);
    await expect(createAddress(context(), { customerEntityId: ids.customerOther, city: "Bremen" }))
      .rejects.toMatchObject({ statusCode: 404 });
    expect(database.address.create).not.toHaveBeenCalled();
  });

  it("creates and lists addresses through tenant and customer ownership", async () => {
    database.customerEntity.findFirst.mockResolvedValue({ id: ids.customerA });
    database.address.create.mockResolvedValue({ id: ids.addressA, tenantId: ids.tenantA,
      customerEntityId: ids.customerA });
    database.address.findMany.mockResolvedValue([]);
    await createAddress(context(), { customerEntityId: ids.customerA, city: "Bremen" });
    await listAddresses(context(), { customerEntityId: ids.customerA, q: "Bremen" });
    expect(database.address.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ tenantId: ids.tenantA, customerEntityId: ids.customerA }),
    }));
    expect(database.address.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ tenantId: ids.tenantA, customerEntityId: ids.customerA,
        customerEntity: expect.objectContaining({ tenantId: ids.tenantA }) }),
    }));
  });

  it("scopes customer and address details before returning records", async () => {
    database.customerEntity.findFirst.mockResolvedValue(null);
    database.address.findFirst.mockResolvedValue(null);
    await expect(getCustomerEntityById(context(), ids.customerOther)).resolves.toBeNull();
    await expect(getAddressById(context(), ids.addressA)).resolves.toBeNull();
    expect(database.customerEntity.findFirst.mock.calls[0][0].where).toEqual({
      AND: [{ id: ids.customerOther }, expect.objectContaining({ tenantId: ids.tenantA })],
    });
    expect(database.address.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: ids.addressA, tenantId: ids.tenantA,
        customerEntity: expect.objectContaining({ tenantId: ids.tenantA }) }),
    }));
  });

  it("rejects a default address owned by another customer without updating", async () => {
    database.address.findFirst.mockResolvedValue(null);
    await expect(updateCustomerEntity(context(), ids.customerA, { defaultAddressId: ids.addressA }))
      .rejects.toMatchObject({ statusCode: 400 });
    expect(database.customerEntity.updateMany).not.toHaveBeenCalled();
  });

  it("foreign or out-of-scope updates and deletes leave records unchanged", async () => {
    database.customerEntity.findFirst.mockResolvedValue(null);
    database.address.findFirst.mockResolvedValue(null);
    await expect(updateCustomerEntity(context(), ids.customerOther, { name: "Rejected" })).resolves.toBeNull();
    await expect(deleteCustomerEntity(context(), ids.customerOther)).resolves.toBe(false);
    await expect(updateAddress(context(), ids.addressA, { city: "Rejected" })).resolves.toBeNull();
    await expect(deleteAddress(context(), ids.addressA)).resolves.toBe(false);
    expect(database.customerEntity.updateMany).not.toHaveBeenCalled();
    expect(database.customerEntity.deleteMany).not.toHaveBeenCalled();
    expect(database.address.updateMany).not.toHaveBeenCalled();
    expect(database.address.deleteMany).not.toHaveBeenCalled();
  });

  it("allows valid write-only customer and address updates and deletes", async () => {
    const writeOnly = context({ permissionCodes: ["customers.write"] });
    mockedLoad.mockResolvedValue(snapshot(writeOnly));
    database.customerEntity.findFirst
      .mockResolvedValueOnce({ id: ids.customerA })
      .mockResolvedValueOnce({ id: ids.customerA, tenantId: ids.tenantA, defaultAddress: null });
    database.customerEntity.updateMany.mockResolvedValue({ count: 1 });
    await expect(updateCustomerEntity(writeOnly, ids.customerA, { name: "Updated" }))
      .resolves.toMatchObject({ id: ids.customerA });
    database.address.findFirst
      .mockResolvedValueOnce({ id: ids.addressA })
      .mockResolvedValueOnce({ id: ids.addressA, tenantId: ids.tenantA, customerEntityId: ids.customerA });
    database.address.updateMany.mockResolvedValue({ count: 1 });
    await expect(updateAddress(writeOnly, ids.addressA, { city: "Updated" }))
      .resolves.toMatchObject({ id: ids.addressA });

    database.customerEntity.findFirst.mockResolvedValueOnce({ id: ids.customerA });
    database.customerEntity.deleteMany.mockResolvedValue({ count: 1 });
    database.address.findFirst.mockResolvedValueOnce({ id: ids.addressA });
    database.address.deleteMany.mockResolvedValue({ count: 1 });
    await expect(deleteCustomerEntity(writeOnly, ids.customerA)).resolves.toBe(true);
    await expect(deleteAddress(writeOnly, ids.addressA)).resolves.toBe(true);
  });

  it("rejects attempts to move address ownership", async () => {
    await expect(updateAddress(context(), ids.addressA, { customerEntityId: ids.customerOther } as any))
      .rejects.toMatchObject({ statusCode: 400 });
    expect(database.address.updateMany).not.toHaveBeenCalled();
  });
});
