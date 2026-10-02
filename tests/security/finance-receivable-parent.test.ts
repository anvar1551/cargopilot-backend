import { Prisma } from "@prisma/client";
import { projectFinanceSubledgerEvent } from "../../src/modules/finance-core/infrastructure/finance-subledger.projector";

const money = (v:string) => new Prisma.Decimal(v);
const event = (type:string) => ({companyId:"company",sourceEventId:"event",sourceId:"source",eventType:type,
  currency:"UZS",occurredAt:new Date("2026-01-01"),documentDate:new Date("2026-01-01"),
  dimensions:{orderId:"order"},amounts:{gross_amount:"0.1000",refund_amount:"0.1000"},metadata:{},attributes:{}} as any);
let tx:any;
const parent={id:"receivable",orderId:"order",legalEntityId:"entity",customerEntityId:null,currency:"UZS",originalAmount:money("0.2000"),outstandingAmount:money("0.1000")};
const receipt={id:"cash",legalEntityId:"entity",sourceEventId:"payment-event",customerEntityId:null,remainingAmount:money("0.1000"),metadataJson:{paymentIntentId:"intent"}};
beforeEach(()=>{
  tx={$queryRaw:jest.fn(),financeLegalEntity:{findFirst:jest.fn().mockResolvedValue({tenantId:"tenant",company:{tenantId:"tenant"}})},
    financeSourceEvent:{findFirst:jest.fn().mockResolvedValue({id:"durable-source"})}};
  for(const name of ["financeReceivableItem","financeReceivableAllocation","financeUnappliedCash","financeUnappliedCashApplication"])
    tx[name]={findMany:jest.fn().mockResolvedValue([]),create:jest.fn(),update:jest.fn()};
  tx.financeReceivableItem.create.mockResolvedValue(parent);
});
function noEffects(){expect(tx.$queryRaw).not.toHaveBeenCalled();for(const name of ["financeReceivableItem","financeReceivableAllocation","financeUnappliedCash","financeUnappliedCashApplication"]){expect(tx[name].create).not.toHaveBeenCalled();expect(tx[name].update).not.toHaveBeenCalled();}}
it.each([null,{tenantId:null,company:{tenantId:null}},{tenantId:"tenant",company:{tenantId:"foreign"}}])("unbound/conflicting owner rejects before lock or business effects",async owner=>{
  tx.financeLegalEntity.findFirst.mockResolvedValue(owner);
  await expect(projectFinanceSubledgerEvent(tx,"entity",event("payment.succeeded"))).rejects.toMatchObject({code:"FINANCE_SUBLEDGER_OWNER_INVALID"});noEffects();
});
it("missing or foreign stored source rejects before effects",async()=>{
  tx.financeSourceEvent.findFirst.mockResolvedValue(null);
  await expect(projectFinanceSubledgerEvent(tx,"entity",event("payment.refunded"))).rejects.toMatchObject({code:"FINANCE_SUBLEDGER_OWNER_INVALID"});
  expect(tx.financeSourceEvent.findFirst).toHaveBeenCalledWith({where:{sourceEventId:"event",legalEntityId:"entity",companyId:"company",sourceId:"source",eventType:"payment.refunded"},select:{id:true}});noEffects();
});
it("receipt allocation derives its bridge from server-resolved entity and scopes parents",async()=>{
  tx.financeReceivableItem.findMany.mockResolvedValue([parent]);await projectFinanceSubledgerEvent(tx,"entity",event("payment.succeeded"));
  expect(tx.financeReceivableItem.findMany.mock.calls[0][0].where).toMatchObject({legalEntityId:"entity",orderId:"order",currency:"UZS"});
  expect(tx.financeReceivableAllocation.create.mock.calls[0][0].data).toMatchObject({legalEntityId:"entity",receivableId:parent.id,type:"payment"});
});
it("invoice consumption binds both child relations to one entity",async()=>{
  tx.financeUnappliedCash.findMany.mockResolvedValue([receipt]);await projectFinanceSubledgerEvent(tx,"entity",event("invoice.issued"));
  for(const name of ["financeReceivableAllocation","financeUnappliedCashApplication"])expect(tx[name].create.mock.calls[0][0].data).toMatchObject({legalEntityId:"entity",receivableId:parent.id});
  expect(tx.financeUnappliedCashApplication.create.mock.calls[0][0].data.unappliedCashId).toBe(receipt.id);
});
it("refund cash consumption persists entity without requiring a receivable",async()=>{
  tx.financeUnappliedCash.findMany.mockResolvedValue([receipt]);await projectFinanceSubledgerEvent(tx,"entity",event("payment.refunded"));
  expect(tx.financeUnappliedCashApplication.create.mock.calls[0][0].data).toMatchObject({legalEntityId:"entity",unappliedCashId:receipt.id,type:"refund"});
  expect(tx.financeUnappliedCashApplication.create.mock.calls[0][0].data).not.toHaveProperty("receivableId");
});
it("refund receivable reopening persists entity and exact money",async()=>{
  tx.financeReceivableItem.findMany.mockResolvedValue([parent]);await projectFinanceSubledgerEvent(tx,"entity",event("payment.refunded"));
  const data=tx.financeReceivableAllocation.create.mock.calls[0][0].data;expect(data).toMatchObject({legalEntityId:"entity",receivableId:parent.id,type:"refund"});expect(data.amount.toFixed(4)).toBe("0.1000");
});
