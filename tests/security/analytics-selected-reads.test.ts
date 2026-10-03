jest.mock("../../src/config/prismaClient", () => ({ __esModule: true, default: require("./fixtures").database }));
jest.mock("../../src/modules/orders-core/domain/company-authority", () => ({ requireTenantBoundOrderCompanyAuthority: jest.fn() }));
jest.mock("../../src/modules/analytics-core/config/analyticsConfig", () => ({ analyticsConfig: { slaPolicyDbEnabled: false, logLevel: "off" } }));
import { database as db } from "./fixtures";
import { requireTenantBoundOrderCompanyAuthority } from "../../src/modules/orders-core/domain/company-authority";
import { getAnalyticsSummaryV2, getAnalyticsTrendV2, getAnalyticsWarningsV2, getAnalyticsFinanceQueueV2 } from "../../src/modules/analytics-core/application/analyticsV2";
import { buildMembershipOrderScopeWhere, buildOrderScopeWhere } from "../../src/modules/identity-access/access-control";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const actor: any = { id: id(1), tenantId: id(2), companyId: id(3), membershipId: id(4), companyMembershipId: id(4), tenantMembershipId: id(5) };
const membership = (): any => ({ id: actor.membershipId, userId: actor.id, status: "active", companyId: actor.companyId, tenantId: actor.tenantId, tenantMembershipId: actor.tenantMembershipId, branchId: null,
  company: { id: actor.companyId, tenantId: actor.tenantId, isActive: true }, tenant: { id: actor.tenantId, status: "active" }, tenantMembership: { id: actor.tenantMembershipId, tenantId: actor.tenantId, userId: actor.id, status: "active" },
  user: { id: actor.id, name: "Synthetic", email: "synthetic@example.test", warehouseId: id(6), customerEntityId: id(7) }, scopes: [{ scopeType: "company", scopeRefId: actor.companyId }],
  roles: [{ role: { code: "manager", rolePermissions: ["shipment.view", "finance.invoices.read"].map(key => ({ permission: { key } })) } }] });
let tx: any;
beforeEach(() => { jest.clearAllMocks(); (requireTenantBoundOrderCompanyAuthority as jest.Mock).mockReset().mockResolvedValue({}); db.companyMembership.findFirst.mockReset().mockResolvedValue(membership());
  tx = { $executeRaw: jest.fn(), $queryRaw: jest.fn(async () => []), order: { count: jest.fn(async () => 0), findMany: jest.fn(async () => []) } }; db.$transaction.mockReset().mockImplementation(async (fn: any) => fn(tx));
});
it("strict explicit membership policy removes user-global customer and warehouse clauses while compatibility caller remains unchanged", async () => {
  const row = membership(); row.scopes = []; db.companyMembership.findFirst.mockResolvedValue(row);
  expect(JSON.stringify(await buildMembershipOrderScopeWhere(actor, "shipment.view"))).toContain("__no_access__");
  const compat = JSON.stringify(await buildOrderScopeWhere(actor, "shipment.view")); expect(compat).toContain(id(6)); expect(compat).toContain(id(7));
});
it("explicit warehouse scope is retained without global bindings", async () => { const row = membership(); row.scopes = [{ scopeType: "warehouse", scopeRefId: id(8) }]; db.companyMembership.findFirst.mockResolvedValue(row); const scope = JSON.stringify(await buildMembershipOrderScopeWhere(actor, "shipment.view")); expect(scope).toContain(id(8)); expect(scope).not.toContain(id(6)); });
it.each([getAnalyticsSummaryV2, getAnalyticsTrendV2, getAnalyticsWarningsV2, getAnalyticsFinanceQueueV2])("missing selected context denies before queries/cache or writes", async read => { await expect(read({ actor: null } as any)).rejects.toMatchObject({ statusCode: 403 }); expect(db.$transaction).not.toHaveBeenCalled(); expect(db.operationalSlaPolicy.findUnique).not.toHaveBeenCalled(); });
it.each(["membership", "tenant", "permission", "scope", "foreign-role"])("current %s failure denies before aggregate reads", async failure => {
  const row = membership(); if (failure === "membership") row.status = "suspended"; if (failure === "tenant") row.tenant.status = "suspended";
  if (failure === "permission") row.roles = []; if (failure === "scope") row.scopes = []; if (failure === "foreign-role") (requireTenantBoundOrderCompanyAuthority as jest.Mock).mockRejectedValue(Object.assign(new Error("Denied"), { statusCode: 403 }));
  db.companyMembership.findFirst.mockResolvedValue(row); await expect(getAnalyticsTrendV2({ actor })).rejects.toMatchObject({ statusCode: 403 }); expect(db.$transaction).not.toHaveBeenCalled();
});
it("all raw SQL reads carry tenant/object scope and repeat invoice ownership without User joins", async () => {
  await getAnalyticsSummaryV2({ actor }); await getAnalyticsTrendV2({ actor }); await getAnalyticsFinanceQueueV2({ actor });
  expect(tx.$queryRaw).toHaveBeenCalledTimes(7);
  for (const [sql] of tx.$queryRaw.mock.calls) { expect(sql.text).toContain('"o"."tenantId"'); expect(sql.values).toContain(actor.tenantId); expect(sql.values).toContain(actor.companyId); expect(sql.text).not.toContain('JOIN "User"'); }
  const invoiceSql = tx.$queryRaw.mock.calls[1][0].text; expect(invoiceSql).toContain('i."companyId" = o."ownerOrgId"'); expect(invoiceSql).toContain('i."customerEntityId" IS NOT DISTINCT');
  expect(tx.$queryRaw.mock.calls[2][0].text).toContain('i."tenantId" = o."tenantId"'); expect(tx.$queryRaw.mock.calls[6][0].text).toContain('NULL::text AS "holderLabel"');
});
it("invoice permission failure gives unavailable fields, never false financial zero or cached invoice data", async () => {
  const row = membership(); row.roles[0].role.rolePermissions = [{ permission: { key: "shipment.view" } }]; db.companyMembership.findFirst.mockResolvedValue(row);
  const result = await getAnalyticsSummaryV2({ actor }); expect(result.payload.finance).toMatchObject({ invoiceAccess: "unavailable", invoicedPaidAmount: null, pendingInvoicesCount: null, invoicedPaidAmountByCurrency: null }); expect(tx.$queryRaw.mock.calls[1][0].text).toContain("FALSE");
});
it("warning list/count finance OR cannot replace tenant/object AND; safe projection and bounded rows", async () => {
  await getAnalyticsWarningsV2({ actor }); expect(tx.order.count).toHaveBeenCalledTimes(3); expect(tx.order.findMany).toHaveBeenCalledTimes(3);
  for (const [query] of [...tx.order.count.mock.calls, ...tx.order.findMany.mock.calls]) { expect(JSON.stringify(query.where.AND)).toContain(actor.tenantId); expect(JSON.stringify(query.where.AND)).toContain(actor.companyId); }
  for (const [query] of tx.order.findMany.mock.calls) { expect(query.take).toBe(20); expect(query.include).toBeUndefined(); expect(query.select).not.toHaveProperty("customer"); }
});
it("repeated different selected contexts are fresh and never reuse a projection", async () => {
  for (let n = 0; n < 3; n++) { const selected = { ...actor, companyId: id(20+n), tenantId: id(30+n) }; const row = membership(); Object.assign(row, { companyId: selected.companyId, tenantId: selected.tenantId }); row.company = { ...row.company, id: selected.companyId, tenantId: selected.tenantId }; row.tenant = { ...row.tenant, id: selected.tenantId }; row.tenantMembership.tenantId = selected.tenantId; row.scopes = [{ scopeType: "company", scopeRefId: selected.companyId }]; db.companyMembership.findFirst.mockResolvedValue(row); await getAnalyticsTrendV2({ actor: selected }); expect(tx.$queryRaw.mock.calls.at(-1)[0].values).toContain(selected.tenantId); }
  expect(db.$transaction).toHaveBeenCalledTimes(3);
});
it.each([{ queueStatuses: ["invalid"] }, { queueKinds: ["foreign"] }, { queueFrom: new Date("invalid") }, { queueFrom: new Date("2026-01-02"), queueTo: new Date("2026-01-01") }])("invalid filter cannot broaden query", async query => { await expect(getAnalyticsFinanceQueueV2({ actor, ...query })).rejects.toMatchObject({ statusCode: 400 }); expect(db.$transaction).not.toHaveBeenCalled(); });
it("queue clamps integer limits and hides holder identity", async () => { tx.$queryRaw.mockResolvedValueOnce([{ total: 1n }]).mockResolvedValueOnce([{ id: id(9), orderId: id(10), updatedAt: new Date(), referenceAt: new Date(), holderLabel: null }]); const result = await getAnalyticsFinanceQueueV2({ actor, queuePageSize: 2000, queuePage: 1.8 }); expect(result.payload.queueMeta).toMatchObject({ page: 1, pageSize: 100 }); expect(result.payload.queue[0].holderLabel).toBeNull(); });
it("optional shared SLA policy is a projected readonly transaction read under the same deadlines", async () => {
  const { analyticsConfig } = require("../../src/modules/analytics-core/config/analyticsConfig"); const clock = jest.spyOn(Date, "now").mockReturnValue(Date.now() + 360000);
  analyticsConfig.slaPolicyDbEnabled = true; tx.operationalSlaPolicy = { findUnique: jest.fn(async () => ({ staleHours: 72, dueSoonHours: 12, overdueGraceHours: 1 })) };
  try { await getAnalyticsSummaryV2({ actor }); expect(tx.operationalSlaPolicy.findUnique).toHaveBeenCalledWith({ where: { singletonKey: "global" }, select: { staleHours: true, dueSoonHours: true, overdueGraceHours: true } }); expect(tx.$executeRaw).toHaveBeenCalledTimes(2); expect(db.operationalSlaPolicy.findUnique).not.toHaveBeenCalled(); }
  finally { clock.mockRestore(); analyticsConfig.slaPolicyDbEnabled = false; }
});
