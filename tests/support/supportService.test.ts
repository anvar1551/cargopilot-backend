jest.mock("../../src/config/prismaClient", () => ({ __esModule: true, default: require("../security/fixtures").database }));
jest.mock("../../src/modules/identity-access/access-control", () => ({ loadAccessSnapshot: jest.fn(), buildSupportScopeWhere: jest.fn(), buildOrderScopeWhere: jest.fn() }));
jest.mock("../../src/modules/analytics-core/infrastructure/analyticsOutbox", () => ({ enqueueCargoPilotDomainEventTx: jest.fn(async () => undefined) }));
import { database } from "../security/fixtures";
import { loadAccessSnapshot, buildSupportScopeWhere, buildOrderScopeWhere } from "../../src/modules/identity-access/access-control";
import { getSupportSummary, listSupportAssignees } from "../../src/modules/support-core/application/supportService";
const actor: any = { id: "synthetic-user", membershipId: "cm-a", companyMembershipId: "cm-a", tenantMembershipId: "tm-a",
 tenantId: "tenant-a", companyId: "company-a", customerEntityId: null, permissionCodes: ["support.view"], scopes: [] };
beforeEach(() => {
 jest.mocked(loadAccessSnapshot).mockReset().mockResolvedValue({ ...actor, userId: actor.id, scopes: [{ scopeType: "company", scopeRefId: actor.companyId }] });
 jest.mocked(buildSupportScopeWhere).mockReset().mockResolvedValue({ ownerOrgId: actor.companyId });
 jest.mocked(buildOrderScopeWhere).mockReset().mockResolvedValue({ customerEntityId: "scoped-customer" });
 database.supportTicket.count.mockReset(); database.companyMembership.findMany.mockReset();
});
test("summary ignores caller-supplied filters and scopes every count", async () => {
 for (const n of [4,1,2,1,3,2]) database.supportTicket.count.mockResolvedValueOnce(n);
 expect(await getSupportSummary({ actor, scopeWhere: {} })).toEqual({ open: 4, escalated: 1, waitingCustomer: 2, waitingDriver: 1, waiting: 3, resolvedToday: 3, slaRisk: 2 });
 for (const [query] of database.supportTicket.count.mock.calls) {
  expect(JSON.stringify(query.where)).toContain('"tenantId":"tenant-a"'); expect(JSON.stringify(query.where)).toContain('"ownerOrgId":"company-a"');
  expect(JSON.stringify(query.where)).toContain("scoped-customer");
 }
 expect(loadAccessSnapshot).toHaveBeenCalledWith(expect.objectContaining({ requireFresh: true }));
});
test("assignees require active selected-company/tenant bridges, permission and scope", async () => {
 database.companyMembership.findMany.mockResolvedValue([{ user: { id: "synthetic-operator", name: "Synthetic", email: "synthetic@example.test" } }]);
 expect(await listSupportAssignees(actor)).toEqual([{ id: "synthetic-operator", name: "Synthetic", email: "synthetic@example.test" }]);
 expect(database.companyMembership.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ tenantId: actor.tenantId, companyId: actor.companyId, status: "active", tenantMembershipId: { not: null } }), take: 200 }));
});
test("missing context fails closed before assignee reads", async () => {
 await expect(listSupportAssignees({ id: actor.id } as any)).rejects.toMatchObject({ statusCode: 403 });
 expect(database.companyMembership.findMany).not.toHaveBeenCalled();
});
