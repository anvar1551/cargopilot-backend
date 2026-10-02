import { resolveSettlementLines } from "../../src/modules/finance-core/infrastructure/settlement-line-references";
const owner={id:"entity",companyId:"company",tenantId:"tenant"};
const input=(lines:any[])=>({providerConfigId:"config",providerCode:"CLICK",environment:"TEST",currency:"UZS",lines} as any);
let tx:any;
beforeEach(()=>{tx={financeLegalEntity:{findFirst:jest.fn().mockResolvedValue({id:owner.id})},paymentProviderConfig:{findFirst:jest.fn().mockResolvedValue({provider:"CLICK",environment:"TEST"})},paymentIntent:{findMany:jest.fn().mockResolvedValue([{id:"intent",orderId:"order"}])},paymentRefund:{findMany:jest.fn().mockResolvedValue([{id:"refund",paymentIntentId:"intent",orderId:"order"}])},order:{findMany:jest.fn().mockResolvedValue([{id:"order"}])}};});
it("derives refund intent/order and immutable owner fields from stored relationships",async()=>{
 const rows=await resolveSettlementLines(tx,owner,input([{paymentRefundId:"refund",companyId:"foreign",tenantId:"foreign",currency:"EUR"}]));
 expect(rows[0]).toMatchObject({paymentIntentId:"intent",orderId:"order",companyId:"company",tenantId:"tenant",legalEntityId:"entity",providerConfigId:"config",currency:"UZS"});
 expect(tx.paymentIntent.findMany.mock.calls[0][0].where).toMatchObject({companyId:"company",providerConfigId:"config",provider:"CLICK",environment:"TEST",currency:"UZS",order:{is:{tenantId:"tenant",ownerOrgId:"company"}}});
 expect(tx.paymentRefund.findMany.mock.calls[0][0].take).toBe(5001);
});
it("valid payment and intentionally optional fee references preserve owned order",async()=>{
 const rows=await resolveSettlementLines(tx,owner,input([{paymentIntentId:"intent"},{type:"fee"},{type:"fee",orderId:"order"}]));
 expect(rows.map(r=>r.orderId)).toEqual(["order",null,"order"]);
});
it.each([{type:"payment"},{type:"refund",paymentIntentId:"intent"},{type:"payment",paymentIntentId:"intent",paymentRefundId:"refund"},{paymentIntentId:"foreign"},{paymentRefundId:"foreign"},{paymentRefundId:"refund",paymentIntentId:"different"},{paymentIntentId:"intent",orderId:"wrong"},{orderId:"foreign"}])("conflicting or unresolvable source references reject without effects",async line=>{
 await expect(resolveSettlementLines(tx,owner,input([line]))).rejects.toMatchObject({code:"FINANCE_SETTLEMENT_SOURCE_INVALID"});
 // Test transaction exposes only read methods: no storage, provider, audit, outbox or business writes are available.
 expect(Object.keys(tx)).toEqual(["financeLegalEntity","paymentProviderConfig","paymentIntent","paymentRefund","order"]);
});
it.each([null,{provider:"PAYME",environment:"TEST"},{provider:"CLICK",environment:"PRODUCTION"}])("missing/foreign provider context rejects before source lookup",async config=>{
 tx.paymentProviderConfig.findFirst.mockResolvedValue(config);await expect(resolveSettlementLines(tx,owner,input([{paymentIntentId:"intent"}]))).rejects.toMatchObject({code:"FINANCE_SETTLEMENT_SOURCE_INVALID"});expect(tx.paymentIntent.findMany).not.toHaveBeenCalled();
});
it("unbound/inactive owner and resource overflow reject before source work",async()=>{
 tx.financeLegalEntity.findFirst.mockResolvedValue(null);await expect(resolveSettlementLines(tx,owner,input([{paymentIntentId:"intent"}]))).rejects.toMatchObject({code:"FINANCE_SETTLEMENT_SOURCE_INVALID"});expect(tx.paymentProviderConfig.findFirst).not.toHaveBeenCalled();
 tx.financeLegalEntity.findFirst.mockClear();await expect(resolveSettlementLines(tx,owner,input(Array(5001).fill({})))).rejects.toMatchObject({code:"FINANCE_SETTLEMENT_SOURCE_INVALID"});expect(tx.financeLegalEntity.findFirst).not.toHaveBeenCalled();
});
