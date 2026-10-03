jest.mock("../../src/config/prismaClient", () => ({ __esModule: true, default: require("./fixtures").database }));
jest.mock("../../src/modules/identity-access/access-control", () => ({ loadAccessSnapshot: jest.fn(), buildOrderScopeWhere: jest.fn() }));
import { database } from "./fixtures";
import { loadAccessSnapshot, buildOrderScopeWhere } from "../../src/modules/identity-access/access-control";
import { createWarehouse, updateWarehouse, listWarehouses, getWarehouseById } from "../../src/modules/warehouse-core/application/warehouseRepo";
import { updateDriverProfileById } from "../../src/modules/driver-core/application/driverProfileService";
import { createUserByCompanyAdmin, updateUserAccessByCompanyAdmin } from "../../src/modules/identity-access/application/auth.service";

const context: any = { id: "user-a", tenantId: "tenant-a", tenantMembershipId: "tm-a", companyId: "company-a",
  companyMembershipId: "cm-a", membershipId: "cm-a", warehouseId: "foreign-user-global", roleCodes: ["manager"] };
const permissions = ["shipment.view", "shipment.update", "warehouse.create"];
const scopes = [{ scopeType: "warehouse", scopeRefId: "warehouse-a" }, { scopeType: "company", scopeRefId: "company-a" }];
const snap: any = { ...context, userId: context.id, permissionCodes: permissions, scopes };
const input: any = { name: "Synthetic A", location: "Test", type: "warehouse" };
const rows = [{ id: "warehouse-a", tenantId: "tenant-a", name: "Synthetic A" },
  { id: "warehouse-b", tenantId: "tenant-a", name: "Synthetic B" },
  { id: "foreign", tenantId: "tenant-b", name: "Foreign" }, { id: "legacy", tenantId: null, name: "Legacy" }];
// Small mocked query evaluator plus explicit query assertions; not PostgreSQL evidence.
function matches(row: any, where: any): boolean {
  if (where.AND && !where.AND.every((w: any) => matches(row, w))) return false;
  if (where.id && (typeof where.id === "string" ? row.id !== where.id : !where.id.in.includes(row.id))) return false;
  if (where.tenantId !== undefined && row.tenantId !== where.tenantId) return false;
  return true;
}
beforeEach(() => {
  jest.mocked(loadAccessSnapshot).mockReset().mockResolvedValue(snap);
  jest.mocked(buildOrderScopeWhere).mockReset().mockResolvedValue({ AND: [{ tenantId: "tenant-a" }, { customerEntityId: "scoped-customer" }] });
  database.warehouse.findMany.mockReset().mockImplementation(async ({ where }: any) => rows.filter(r => matches(r, where)));
  database.warehouse.findFirst.mockReset().mockImplementation(async ({ where }: any) => rows.find(r => matches(r, where)) ?? null);
  database.warehouse.update.mockReset().mockImplementation(async ({ where, data }: any) => {
    const row = rows.find(r => matches(r, where)); if (!row) throw Object.assign(new Error("Not found"), { code: "P2025" }); return { ...row, ...data };
  });
  database.warehouse.create.mockReset().mockImplementation(async ({ data }: any) => data);
  database.$transaction.mockReset(); database.user.findUnique.mockReset(); database.companyMembership.findFirst.mockReset();
});

test("list/search is tenant AND explicit selected warehouse scope, bounded", async () => {
  expect(await listWarehouses(context, { search: "Synthetic", limit: 20, page: 2 })).toEqual([rows[0]]);
  expect(database.warehouse.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: {
    tenantId: "tenant-a", id: { in: ["warehouse-a"] }, name: { contains: "Synthetic", mode: "insensitive" } }, skip: 20, take: 20 }));
  expect(loadAccessSnapshot).toHaveBeenCalledWith(expect.objectContaining({ companyMembershipId: "cm-a", requireFresh: true }));
});
test("detail scopes nested orders by tenant/company AND existing object policy; no global users", async () => {
  await getWarehouseById(context, "warehouse-a");
  const query = database.warehouse.findFirst.mock.calls[0][0];
  expect(query.select.users).toBeUndefined(); expect(query.select.orders.take).toBe(100);
  expect(query.select.orders.where.AND).toContainEqual({ tenantId: "tenant-a", ownerOrgId: "company-a" });
  expect(query.select.orders.where.AND).toContainEqual(await jest.mocked(buildOrderScopeWhere).mock.results[0].value);
});
test.each(["warehouse-b", "foreign", "legacy"])("detail hides %s, including known IDs", async id => {
  expect(await getWarehouseById(context, id)).toBeNull();
});
test.each(["warehouse-b", "foreign", "legacy"])("update denies %s without changing rows", async id => {
  const before = JSON.stringify(rows); await expect(updateWarehouse(context, id, input)).rejects.toMatchObject({ code: "P2025" });
  expect(JSON.stringify(rows)).toBe(before); expect(database.$transaction).not.toHaveBeenCalled();
});
test("authorized edit remains scoped at the write, cannot change ownership", async () => {
  expect(await updateWarehouse(context, "warehouse-a", input)).toMatchObject({ tenantId: "tenant-a", name: input.name });
  expect(database.warehouse.update.mock.calls[0][0].where).toEqual({ id: "warehouse-a", AND: [{ tenantId: "tenant-a", id: { in: ["warehouse-a"] } }] });
});
test("creation derives tenant only and grants neither ownership nor scope from body", async () => {
  expect(await createWarehouse(context, input)).toMatchObject({ tenantId: "tenant-a" });
  expect(database.warehouse.create.mock.calls[0][0].data).not.toHaveProperty("companyId");
});
test.each(["tenantId", "companyId", "users", "orders", "driverAccesses", "tenant", "id"])("rejects injected %s before write", async key => {
  await expect(createWarehouse(context, { ...input, [key]: { connect: { id: "foreign" } } })).rejects.toMatchObject({ statusCode: 400 });
  await expect(updateWarehouse(context, "warehouse-a", { ...input, [key]: "foreign" })).rejects.toMatchObject({ statusCode: 400 });
  expect(database.warehouse.create).not.toHaveBeenCalled(); expect(database.warehouse.update).not.toHaveBeenCalled();
});
test.each([undefined, { ...context, tenantId: null }, { ...context, companyMembershipId: "forged" }])("missing/partial context denies before DB", async actor => {
  await expect(listWarehouses(actor)).rejects.toMatchObject({ statusCode: 403 });
  await expect(updateWarehouse(actor, "warehouse-a", input)).rejects.toMatchObject({ statusCode: 403 });
  expect(loadAccessSnapshot).not.toHaveBeenCalled(); expect(database.warehouse.update).not.toHaveBeenCalled();
});
test.each([null, { ...snap, permissionCodes: [] }, { ...snap, companyId: "other-company" }, { ...snap, tenantId: "tenant-b" },
  { ...snap, scopes: [{ scopeType: "company", scopeRefId: "company-a" }] }])("revoked, inconsistent, insufficient permission/scope denies", async value => {
  jest.mocked(loadAccessSnapshot).mockResolvedValue(value);
  await expect(listWarehouses(context)).rejects.toMatchObject({ statusCode: 403 });
  expect(database.warehouse.findMany).not.toHaveBeenCalled();
});
test("shipment.update cannot create; creation needs new capability plus selected company scope", async () => {
  jest.mocked(loadAccessSnapshot).mockResolvedValue({ ...snap, permissionCodes: ["shipment.update"] });
  await expect(createWarehouse(context, input)).rejects.toMatchObject({ statusCode: 403 });
  jest.mocked(loadAccessSnapshot).mockResolvedValue({ ...snap, scopes: [scopes[0]] });
  await expect(createWarehouse(context, input)).rejects.toMatchObject({ statusCode: 403 });
  expect(database.warehouse.create).not.toHaveBeenCalled();
});
test.each([{ primaryWarehouseId: "foreign" }, { warehouseIds: ["foreign"] }, { primaryWarehouseId: null }, { warehouseIds: [] }])("driver assignment contained before reads or writes", async body => {
  await expect(updateDriverProfileById("other-user", body, context)).rejects.toMatchObject({ statusCode: 403 });
  expect(database.user.findUnique).not.toHaveBeenCalled(); expect(database.$transaction).not.toHaveBeenCalled();
});
test.each([{ warehouseId: "foreign" }, { warehouseId: null }, { scopes: [{ scopeType: " WAREHOUSE ", scopeRefId: "foreign" }] }])("admin assignment/grant contained before effects", async body => {
  await expect(updateUserAccessByCompanyAdmin({ companyId: "company-a", userId: "other-user", ...body })).rejects.toMatchObject({ statusCode: 403 });
  expect(database.companyMembership.findFirst).not.toHaveBeenCalled(); expect(database.$transaction).not.toHaveBeenCalled();
});
test("invalid pagination produces no query", async () => {
  await expect(listWarehouses(context, { limit: 101 })).rejects.toMatchObject({ statusCode: 400 });
  expect(database.warehouse.findMany).not.toHaveBeenCalled();
});
test("alternate user creation cannot install a global warehouse assignment", async () => {
  await expect(createUserByCompanyAdmin({ companyId: "company-a", name: "Synthetic", email: "synthetic@example.test",
    password: "synthetic-test-only", roleCodes: ["driver"], warehouseId: "foreign" })).rejects.toMatchObject({ statusCode: 403 });
  expect(database.user.findUnique).not.toHaveBeenCalled(); expect(database.$transaction).not.toHaveBeenCalled();
});
