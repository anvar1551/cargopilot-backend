import { FinanceDocumentsService } from "../../src/modules/finance-core/application/finance-documents.service";
import type {
  FinanceDocumentsRepositoryPort,
  FinanceReferencePort,
} from "../../src/modules/finance-core/application/finance-documents.port";

function repository(): jest.Mocked<FinanceDocumentsRepositoryPort> {
  return {
    createProviderSettlement: jest.fn(),
    listProviderSettlements: jest.fn(),
    getProviderSettlement: jest.fn(),
    submitProviderSettlement: jest.fn(),
    reconcileProviderSettlementLine: jest.fn(),
    approveProviderSettlement: jest.fn(),
    rejectProviderSettlement: jest.fn(),
    createCarrierBill: jest.fn(),
    listCarrierBills: jest.fn(),
    getCarrierBill: jest.fn(),
    submitCarrierBill: jest.fn(),
    approveCarrierBill: jest.fn(),
    rejectCarrierBill: jest.fn(),
  };
}

function references(): jest.Mocked<FinanceReferencePort> {
  return {
    resolveProviderSettlement: jest.fn(),
    resolveCarrierProvider: jest.fn(),
    validateCarrierBillLegs: jest.fn(),
  };
}

describe("FinanceDocumentsService", () => {
  it("enforces maker-checker separation for settlements", async () => {
    const repo = repository();
    repo.getProviderSettlement.mockResolvedValue({ createdByUserId: "same-user" });
    const service = new FinanceDocumentsService(repo, references());
    await expect(service.approveProviderSettlement({
      companyId: "company",
      settlementId: "settlement",
      actorUserId: "same-user",
      allowSelfApproval: false,
    })).rejects.toMatchObject({ code: "FINANCE_SELF_APPROVAL_FORBIDDEN" });
    expect(repo.approveProviderSettlement).not.toHaveBeenCalled();
  });

  it("permits explicitly authorized emergency self-approval", async () => {
    const repo = repository();
    repo.getCarrierBill.mockResolvedValue({ createdByUserId: "same-user" });
    repo.approveCarrierBill.mockResolvedValue({ status: "approved" });
    const service = new FinanceDocumentsService(repo, references());
    await expect(service.approveCarrierBill({
      companyId: "company",
      billId: "bill",
      actorUserId: "same-user",
      allowSelfApproval: true,
    })).resolves.toEqual({ status: "approved" });
  });
});
