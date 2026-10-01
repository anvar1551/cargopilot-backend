jest.mock("../../src/config/prismaClient", () => ({ __esModule: true, default: require("./fixtures").database }));
jest.mock("../../src/config/redis", () => ({ getRedisClient: jest.fn(async () => null), getRedisPrefix: () => "test", withRedisTimeout: async (_name: string, work: () => Promise<unknown>) => work() }));
jest.mock("../../src/modules/identity-access/access-control", () => ({ loadAccessSnapshot: jest.fn(), hasAnyPermissionSync: jest.fn() }));
jest.mock("../../src/modules/identity-access/transport/fastify-auth", () => ({ fastifyAuth: () => async (request: any) => { request.user = mockActor; } }));
import Fastify from "fastify";
import { database } from "./fixtures";
import { loadAccessSnapshot } from "../../src/modules/identity-access/access-control";
import { prismaFinanceRepository as repo } from "../../src/modules/finance-core/infrastructure/prisma-finance.repository";
import { FinanceService } from "../../src/modules/finance-core/application/finance.service";
import routes from "../../src/modules/finance-core/transport/fastify-routes";

const mockActor: any = { id: "u", tenantId: "t", tenantMembershipId: "tm", companyId: "c", companyMembershipId: "cm", membershipId: "cm" };
const snapshot: any = { ...mockActor, userId: "u", permissionCodes: ["finance.periods.manage", "finance.periods.close", "finance.periods.read"], scopes: [{ scopeType: "company", scopeRefId: "c" }] };
const service = new FinanceService(repo);
const periodId = "11111111-1111-4111-8111-111111111111";
const input = { companyId: "c", actorUserId: "u", fiscalYear: 2026, periodNumber: 1, name: "Synthetic January", startDate: new Date("2026-01-01"), endDate: new Date("2026-01-31") };
const create = (actor: any = mockActor) => service.createPeriod(input, actor);
const change = (actor: any = mockActor, status: "open" | "restricted" | "closed" = "closed") => service.changePeriodStatus({ companyId: "c", actorUserId: "u", periodId, status }, actor);

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(loadAccessSnapshot).mockResolvedValue(snapshot);
  database.membershipScope.findFirst.mockReset().mockResolvedValue({ id: "scope" });
  database.financeFiscalPeriod.findMany.mockReset().mockResolvedValue([]);
});
afterEach(() => {
  expect(database.$transaction).not.toHaveBeenCalled();
  for (const model of ["financeFiscalPeriod", "financeLegalEntity", "financeJournalEntry", "financeAuditEvent", "financeDomainEventOutbox"])
    for (const operation of ["create", "update", "updateMany", "upsert", "delete"])
      expect(database[model][operation]).not.toHaveBeenCalled();
});

test("qualified creation requires independent durable approval before period/configuration access", async () => {
  await expect(create()).rejects.toMatchObject({ statusCode: 409, code: "FINANCE_PERIOD_APPROVAL_REQUIRED" });
  expect(loadAccessSnapshot).toHaveBeenCalledWith(expect.objectContaining({ requireFresh: true, membershipId: "cm", tenantId: "t", companyId: "c" }));
  expect(database.financeFiscalPeriod.findFirst).not.toHaveBeenCalled();
  expect(database.financeLegalEntity.findFirst).not.toHaveBeenCalled();
});
test.each(["open", "restricted", "closed"] as const)("qualified %s transition remains contained", async status => {
  await expect(change(mockActor, status)).rejects.toMatchObject({ statusCode: 409, code: "FINANCE_PERIOD_APPROVAL_REQUIRED" });
  expect(database.financeFiscalPeriod.findFirst).not.toHaveBeenCalled();
});
test.each([null, { ...snapshot, permissionCodes: [] }, { ...snapshot, tenantId: "foreign" }, { ...snapshot, companyId: "foreign" }, { ...snapshot, userId: "foreign" }, { ...snapshot, tenantMembershipId: "foreign" }, { ...snapshot, scopes: [] }])("ineligible/suspended or conflicting fresh context rejects both mutations", async value => {
  jest.mocked(loadAccessSnapshot).mockResolvedValue(value);
  await expect(create()).rejects.toMatchObject({ statusCode: 403 });
  await expect(change()).rejects.toMatchObject({ statusCode: 403 });
});
test.each([null, { ...mockActor, tenantId: null }, { ...mockActor, membershipId: "other" }])("missing or partial selected context denies both mutations", async actor => {
  await expect(create(actor)).rejects.toMatchObject({ statusCode: 403 });
  await expect(change(actor)).rejects.toMatchObject({ statusCode: 403 });
});
test("removed stored company scope denies mutations despite snapshot compatibility scope", async () => {
  database.membershipScope.findFirst.mockResolvedValue(null);
  await expect(create()).rejects.toMatchObject({ code: "FINANCE_COMPANY_SCOPE_REQUIRED" });
  await expect(change()).rejects.toMatchObject({ code: "FINANCE_COMPANY_SCOPE_REQUIRED" });
});
test("direct repository calls cannot forge approval or use company-only worker authority", async () => {
  await expect(repo.createPeriod({ ...input, companyId: "foreign", approved: true, checkerUserId: "other" } as any)).rejects.toMatchObject({ code: "FINANCE_PERIOD_APPROVAL_REQUIRED" });
  await expect(repo.changePeriodStatus({ companyId: "foreign", actorUserId: "u", periodId, status: "open", approved: true } as any)).rejects.toMatchObject({ code: "FINANCE_PERIOD_APPROVAL_REQUIRED" });
  expect(loadAccessSnapshot).not.toHaveBeenCalled();
});
test("inverted date range retains validation after fresh authorization", async () => {
  await expect(service.createPeriod({ ...input, startDate: input.endDate, endDate: input.startDate }, mockActor)).rejects.toMatchObject({ statusCode: 400, code: "FINANCE_INVALID_PERIOD_RANGE" });
  expect(loadAccessSnapshot).toHaveBeenCalled();
});
test("HTTP mutations return controlled approval failures while read access remains available", async () => {
  const app = Fastify(); await app.register(routes);
  try {
    const payload = { fiscalYear: 2026, periodNumber: 1, name: input.name, startDate: "2026-01-01", endDate: "2026-01-31" };
    const created = await app.inject({ method: "POST", url: "/periods", payload });
    expect(created.statusCode).toBe(409); expect(created.json().code).toBe("FINANCE_PERIOD_APPROVAL_REQUIRED");
    const changed = await app.inject({ method: "PATCH", url: `/periods/${periodId}/status`, payload: { status: "closed" } });
    expect(changed.statusCode).toBe(409); expect(changed.json().code).toBe("FINANCE_PERIOD_APPROVAL_REQUIRED");
    expect((await app.inject({ method: "GET", url: "/periods?limit=10" })).statusCode).toBe(200);
  } finally { await app.close(); }
});
test.each(["companyId", "tenantId", "actorUserId", "checkerUserId", "approved"])("HTTP rejects supplied authority field %s", async field => {
  const app = Fastify(); await app.register(routes);
  try {
    expect((await app.inject({ method: "POST", url: "/periods", payload: { fiscalYear: 2026, periodNumber: 1, name: input.name, startDate: "2026-01-01", endDate: "2026-01-31", [field]: "forged" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "PATCH", url: `/periods/${periodId}/status`, payload: { status: "closed", [field]: "forged" } })).statusCode).toBe(400);
  } finally { await app.close(); }
});
