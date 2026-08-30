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
  it("passes only hashed and masked bank identifiers to persistence", async () => {
    const repo = repository();
    repo.createBankAccount.mockResolvedValue({ id: "bank" });
    const service = new FinanceTreasuryService(repo);

    await service.createBankAccount({
      companyId: "company",
      actorUserId: "actor",
      idempotencyKey: "bank-account-1",
      code: " main ",
      name: "Main account",
      bankName: "Test bank",
      accountIdentifier: "UZ1234567890",
      currency: "uzs",
    });

    expect(repo.createBankAccount).toHaveBeenCalledWith(expect.objectContaining({
      code: "MAIN",
      currency: "UZS",
      accountIdentifierHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      accountIdentifierMasked: expect.stringMatching(/\*+7890$/),
    }));
    expect(repo.createBankAccount.mock.calls[0][0]).not.toHaveProperty("accountIdentifier");
  });

  it("enforces maker-checker separation on payment runs and bank statements", async () => {
    const repo = repository();
    repo.getPaymentRun.mockResolvedValue({ createdByUserId: "maker" });
    repo.getBankStatement.mockResolvedValue({ createdByUserId: "maker" });
    const service = new FinanceTreasuryService(repo);

    await expect(service.approvePaymentRun({
      companyId: "company",
      paymentRunId: "run",
      actorUserId: "maker",
      allowSelfApproval: false,
    })).rejects.toMatchObject({ code: "FINANCE_SELF_APPROVAL_FORBIDDEN" });
    await expect(service.approveBankStatement({
      companyId: "company",
      statementId: "statement",
      actorUserId: "maker",
      allowSelfApproval: false,
    })).rejects.toMatchObject({ code: "FINANCE_SELF_APPROVAL_FORBIDDEN" });
  });

  it("requires payment execution by a third operator unless explicitly overridden", async () => {
    const repo = repository();
    repo.getPaymentRun.mockResolvedValue({
      createdByUserId: "maker",
      approvedByUserId: "checker",
    });
    const service = new FinanceTreasuryService(repo);

    await expect(service.executePaymentRun({
      companyId: "company",
      paymentRunId: "run",
      actorUserId: "checker",
      allowControlOverride: false,
      bankReference: "BANK-1",
      executedAt: new Date("2026-08-03T10:00:00.000Z"),
    })).rejects.toMatchObject({ code: "FINANCE_PAYMENT_EXECUTION_SEPARATION_REQUIRED" });
    expect(repo.executePaymentRun).not.toHaveBeenCalled();
  });
});
