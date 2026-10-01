jest.mock("../../src/modules/finance-core/application/legal-entity-access",()=>({requireLegalEntityContext:jest.fn(async()=>({})),rejectUnapprovedLegalEntityConfiguration:()=>{throw Object.assign(new Error("Approval required"),{code:"FINANCE_CONFIGURATION_APPROVAL_REQUIRED"});}}));
import { FinanceService } from "../../src/modules/finance-core/application/finance.service";
import type { FinanceRepositoryPort } from "../../src/modules/finance-core/application/finance.port";

function repositoryMock(): jest.Mocked<FinanceRepositoryPort> {
  return {
    getLegalEntity: jest.fn(),
    configureLegalEntity: jest.fn(),
    listAccounts: jest.fn(),
    createAccount: jest.fn(),
    bootstrapChart: jest.fn(),
    listPeriods: jest.fn(),
    createPeriod: jest.fn(),
    changePeriodStatus: jest.fn(),
    listJournals: jest.fn(),
    getJournal: jest.fn(),
    createDraftJournal: jest.fn(),
    postJournal: jest.fn(),
    reverseJournal: jest.fn(),
    getTrialBalance: jest.fn(),
    listPostingRules: jest.fn(),
    getPostingRule: jest.fn(),
    createPostingRule: jest.fn(),
    createPostingRuleVersion: jest.fn(),
    changePostingRuleStatus: jest.fn(),
    ingestSourceEvent: jest.fn(),
    processSourceEvent: jest.fn(),
    listSourceEvents: jest.fn(),
    retrySourceEvent: jest.fn(),
  };
}

describe("FinanceService", () => {
  it("contains configuration before persistence without independent approval", async () => {
    const repository = repositoryMock();
    repository.configureLegalEntity.mockResolvedValue({ id: "entity" });
    const service = new FinanceService(repository);
    await expect(service.configureLegalEntity({
      companyId: "company",
      actorUserId: "actor",
      baseCurrency: "uzs",
      reportingCurrency: "usd",
      fiscalYearStartMonth: 1,
      timezone: "Asia/Tashkent",
    }, {} as any)).rejects.toMatchObject({code:"FINANCE_CONFIGURATION_APPROVAL_REQUIRED"});
    expect(repository.configureLegalEntity).not.toHaveBeenCalled();
  });

  it("rejects an inverted fiscal period without calling persistence", async () => {
    const repository = repositoryMock();
    const service = new FinanceService(repository);
    await expect(
      service.createPeriod({
        companyId: "company",
        actorUserId: "actor",
        fiscalYear: 2026,
        periodNumber: 1,
        name: "January",
        startDate: new Date("2026-02-01T00:00:00.000Z"),
        endDate: new Date("2026-01-01T00:00:00.000Z"),
      }, {} as any)).rejects
      .toMatchObject({ code: "FINANCE_INVALID_PERIOD_RANGE" });
    expect(repository.createPeriod).not.toHaveBeenCalled();
  });

  it("rejects an inverted trial-balance range", () => {
    const repository = repositoryMock();
    const service = new FinanceService(repository);
    expect(() =>
      service.getTrialBalance(
        "company",
        new Date("2026-02-01T00:00:00.000Z"),
        new Date("2026-01-01T00:00:00.000Z"),
      ),
    ).toThrow(expect.objectContaining({ code: "FINANCE_INVALID_DATE_RANGE" }));
    expect(repository.getTrialBalance).not.toHaveBeenCalled();
  });
});
