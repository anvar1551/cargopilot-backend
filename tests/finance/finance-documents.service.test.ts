jest.mock("../../src/config/prismaClient",()=>({__esModule:true,default:require("../security/fixtures").database}));
jest.mock("../../src/modules/identity-access/access-control",()=>({loadAccessSnapshot:jest.fn()}));
import { database } from "../security/fixtures";
import { loadAccessSnapshot } from "../../src/modules/identity-access/access-control";
const actor:any={id:"same-user",tenantId:"t",tenantMembershipId:"tm",companyId:"company",companyMembershipId:"cm",membershipId:"cm"};
beforeEach(()=>{jest.clearAllMocks();jest.mocked(loadAccessSnapshot).mockResolvedValue({...actor,userId:actor.id,permissionCodes:["finance.settlements.approve","finance.payables.approve"],scopes:[{scopeType:"company",scopeRefId:"company"}]} as any);database.membershipScope.findFirst.mockResolvedValue({id:"scope"});});
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
  it("contains settlement approval before protected records", async () => {
    const repo = repository();
    repo.getProviderSettlement.mockResolvedValue({ createdByUserId: "same-user" });
    const service = new FinanceDocumentsService(repo, references());
    await expect(service.approveProviderSettlement({
      companyId: "company",
      settlementId: "settlement",
      actorUserId: "same-user",
    },actor)).rejects.toMatchObject({ code: "FINANCE_SETTLEMENT_ACCEPTANCE_REQUIRED" });
    expect(repo.getProviderSettlement).not.toHaveBeenCalled();
    expect(repo.approveProviderSettlement).not.toHaveBeenCalled();
  });

  it("contains unsupported carrier approval without an emergency bypass", async () => {
    const repo = repository();
    repo.getCarrierBill.mockResolvedValue({ createdByUserId: "same-user" });
    repo.approveCarrierBill.mockResolvedValue({ status: "approved" });
    const service = new FinanceDocumentsService(repo, references());
    await expect(service.approveCarrierBill({
      companyId: "company",
      billId: "bill",
      actorUserId: "same-user",
    },actor)).rejects.toMatchObject({code:"FINANCE_CARRIER_BILL_ACCEPTANCE_REQUIRED"});
    expect(repo.getCarrierBill).not.toHaveBeenCalled();
    expect(repo.approveCarrierBill).not.toHaveBeenCalled();
  });
});
