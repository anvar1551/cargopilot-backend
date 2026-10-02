jest.mock("../../src/config/prismaClient",()=>({__esModule:true,default:require("../security/fixtures").database}));
jest.mock("../../src/modules/identity-access/access-control",()=>({loadAccessSnapshot:jest.fn()}));
import { database } from "../security/fixtures";
import { loadAccessSnapshot } from "../../src/modules/identity-access/access-control";
import { secureBankIdentifier } from "../../src/modules/finance-core/domain/treasury";
const actor:any={id:"actor",tenantId:"t",tenantMembershipId:"tm",companyId:"company",companyMembershipId:"cm",membershipId:"cm"};
beforeEach(()=>{jest.clearAllMocks();jest.mocked(loadAccessSnapshot).mockResolvedValue({...actor,userId:"actor",permissionCodes:["finance.treasury.manage","finance.treasury.approve","finance.treasury.execute"],scopes:[{scopeType:"company",scopeRefId:"company"}]}as any);database.membershipScope.findFirst.mockResolvedValue({id:"scope"});});
import { FinanceTreasuryService } from "../../src/modules/finance-core/application/finance-treasury.service";
import type { FinanceTreasuryRepositoryPort } from "../../src/modules/finance-core/application/finance-treasury.port";

function repository(): jest.Mocked<FinanceTreasuryRepositoryPort> {
  return {
    createBankAccount: jest.fn(),
    listBankAccounts: jest.fn(),
    changeBankAccountStatus: jest.fn(),
    createPaymentRun: jest.fn(),
    listPaymentRuns: jest.fn(),
    getPaymentRun: jest.fn(),
    submitPaymentRun: jest.fn(),
    approvePaymentRun: jest.fn(),
    rejectPaymentRun: jest.fn(),
    executePaymentRun: jest.fn(),
    createBankStatement: jest.fn(),
    listBankStatements: jest.fn(),
    getBankStatement: jest.fn(),
    reconcileBankStatementLine: jest.fn(),
    ignoreBankStatementLine: jest.fn(),
    submitBankStatement: jest.fn(),
    approveBankStatement: jest.fn(),
    rejectBankStatement: jest.fn(),
  };
}

describe("FinanceTreasuryService", () => {
  it("masks identifiers but denies unaccepted bank persistence", async () => {
    const repo = repository();
    repo.createBankAccount.mockResolvedValue({ id: "bank" });
    const service = new FinanceTreasuryService(repo);

    await expect(service.createBankAccount({
      companyId: "company",
      actorUserId: "actor",
      idempotencyKey: "bank-account-1",
      code: " main ",
      name: "Main account",
      bankName: "Test bank",
      accountIdentifier: "UZ1234567890",
      currency: "uzs",
    },actor)).rejects.toMatchObject({code:"FINANCE_BANK_CONFIGURATION_APPROVAL_REQUIRED"});

    expect(repo.createBankAccount).not.toHaveBeenCalled();
    const identifier=secureBankIdentifier("UZ1234567890");
    expect(identifier.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(identifier.masked).toMatch(/\*+7890$/);
  });

  it("contains payment approval and retains bank statement maker-checker check", async () => {
    const repo = repository();
    repo.getPaymentRun.mockResolvedValue({ createdByUserId: "maker" });
    repo.getBankStatement.mockResolvedValue({ createdByUserId: "maker" });
    const service = new FinanceTreasuryService(repo);

    await expect(service.approvePaymentRun({
      companyId: "company",
      paymentRunId: "run",
      actorUserId: "actor",
    },actor)).rejects.toMatchObject({ code: "FINANCE_PAYMENT_RUN_ACCEPTANCE_REQUIRED" });
    expect(repo.getPaymentRun).not.toHaveBeenCalled();
    await expect(service.approveBankStatement({
      companyId: "company",
      statementId: "statement",
      actorUserId: "maker",
      allowSelfApproval: false,
    })).rejects.toMatchObject({ code: "FINANCE_SELF_APPROVAL_FORBIDDEN" });
  });

  it("contains unaccepted payment execution before retrieving financial records", async () => {
    const repo = repository();
    repo.getPaymentRun.mockResolvedValue({
      createdByUserId: "maker",
      approvedByUserId: "checker",
    });
    const service = new FinanceTreasuryService(repo);

    await expect(service.executePaymentRun({
      companyId: "company",
      paymentRunId: "run",
      actorUserId: "actor",
      bankReference: "BANK-1",
      executedAt: new Date("2026-08-03T10:00:00.000Z"),
    },actor)).rejects.toMatchObject({ code: "FINANCE_PAYMENT_RUN_ACCEPTANCE_REQUIRED" });
    expect(repo.executePaymentRun).not.toHaveBeenCalled();
  });
});
