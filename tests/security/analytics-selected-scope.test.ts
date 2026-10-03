jest.mock("../../src/config/prismaClient", () => ({ __esModule: true, default: require("./fixtures").database }));
jest.mock("../../src/modules/identity-access/access-control", () => ({ buildMembershipOrderScopeWhere: jest.fn() }));
jest.mock("../../src/modules/orders-core/domain/company-authority", () => ({ requireTenantBoundOrderCompanyAuthority: jest.fn() }));
import { Prisma } from "@prisma/client";
import { database as db } from "./fixtures";
import { buildMembershipOrderScopeWhere } from "../../src/modules/identity-access/access-control";
import { requireTenantBoundOrderCompanyAuthority } from "../../src/modules/orders-core/domain/company-authority";
import { analyticsOrderScopeSql, requireAnalyticsScope, freshAnalyticsRead } from "../../src/modules/analytics-core/application/analyticsScope";
const a = "00000000-0000-4000-8000-000000000001", b = "00000000-0000-4000-8000-000000000002";
const actor: any = { id: a, tenantId: a, companyId: b, membershipId: a, companyMembershipId: a, tenantMembershipId: b };
beforeEach(() => { jest.clearAllMocks(); (requireTenantBoundOrderCompanyAuthority as jest.Mock).mockReset().mockResolvedValue({}); (buildMembershipOrderScopeWhere as jest.Mock).mockReset().mockResolvedValue({ ownerOrgId: b }); });
it("parameterized compound tenant/object alternatives never interpolate identifiers as values", () => {
  const sql = analyticsOrderScopeSql({ AND: [{ tenantId: a }, { OR: [{ ownerOrgId: { in: [a, b] } }, { currentWarehouseId: b }] }] });
  expect(sql.text).toContain('"o"."tenantId"'); expect(sql.text).toContain(" OR "); expect(sql.text).not.toContain(a); expect(sql.values).toEqual([a, a, b, b]);
});
it.each([{}, null, { tenantId: "x' OR TRUE" }, { tenantId: { not: null } }, { orderNumber: a }, { OR: [] }, { ownerOrgId: { in: Array(1001).fill(a) } }, { tenantId: { in: [a], equals: a } }])("unsupported scope cannot become TRUE: %j", value => expect(() => analyticsOrderScopeSql(value as any)).toThrow());
it("empty membership id set is FALSE", () => expect(analyticsOrderScopeSql({ id: { in: [] } }).text).toContain("FALSE"));
it.each([null, {}, { ...actor, tenantId: null }, { ...actor, membershipId: b }])("missing/conflicting context fails before authority or read work", async value => {
  await expect(requireAnalyticsScope(value)).rejects.toMatchObject({ statusCode: 403 }); expect(requireTenantBoundOrderCompanyAuthority).not.toHaveBeenCalled(); expect(buildMembershipOrderScopeWhere).not.toHaveBeenCalled();
});
it("fresh action and explicit membership scopes preserve complete selected context", async () => {
  const result = await requireAnalyticsScope(actor); const call = (requireTenantBoundOrderCompanyAuthority as jest.Mock).mock.calls[0]; expect(call[0] === db).toBe(true); expect(call[1]).toBe(actor); expect(call[2]).toBe("shipment.view"); expect(buildMembershipOrderScopeWhere).toHaveBeenCalledWith(actor, "shipment.view"); expect(result.where).toEqual({ AND: [{ tenantId: a }, { ownerOrgId: b }] });
});
it.each([null, {}, { AND: [{ tenantId: a }, { id: "__no_access__" }] }])("missing/revoked scope never reaches data transaction", async scope => {
  (buildMembershipOrderScopeWhere as jest.Mock).mockResolvedValue(scope); await expect(requireAnalyticsScope(actor)).rejects.toMatchObject({ statusCode: 403 }); expect(db.$transaction).not.toHaveBeenCalled();
});
it("readonly snapshot sets SQL limits without a cache fallback or retry", async () => {
  const tx = { $executeRaw: jest.fn(), order: { count: jest.fn(async () => 2) } };
  db.$transaction.mockImplementation(async (callback: any, options: any) => { expect(options).toMatchObject({ isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, maxWait: 2000, timeout: 10000 }); return callback(tx); });
  expect(await freshAnalyticsRead(db => db.order.count())).toEqual({ payload: 2, cacheHit: false });
  expect(tx.$executeRaw.mock.calls.map(([s]: any) => s.join())).toEqual(["SET TRANSACTION READ ONLY", "SET LOCAL statement_timeout = '5s'"]);
  tx.order.count.mockRejectedValueOnce(new Error("Synthetic deadline")); await expect(freshAnalyticsRead(db => db.order.count())).rejects.toThrow("Synthetic deadline"); expect(tx.order.count).toHaveBeenCalledTimes(2);
});
