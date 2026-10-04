jest.mock("../../src/config/prismaClient", () => ({ __esModule:true,default:new Proxy({}, {get:(_t,k)=>{const v=(mockPrisma as any)[k];return typeof v==="function"?v.bind(mockPrisma):v;}}) }));
import { Pool } from "pg";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { randomUUID } from "crypto";
import http = require("http"); import https = require("https");
import { createTenantDemoFixture } from "../../src/modules/tenancy/demo-fixtures";
import { persistTenantDemoFixture } from "../tenancy/postgres-fixture.persistence";
import { syntheticBillingPolicy } from "./billing-policy.fixture";
import { proposeBillingPolicy,decideBillingPolicy,readBillingPolicy,billingHash } from "../../src/modules/pricing-core/repo/billing-policy";
import { bindOrderBillTo,acceptOrderPrice,approveOrderPrice } from "../../src/modules/pricing-core/repo/order-price";
import { issueOrderInvoiceForActor, listInvoicesForActor, getInvoiceByOrder } from "../../src/modules/invoice-core/application/invoiceRepo";
import { proposeTariffVersion,decideTariffVersion } from "../../src/modules/pricing-core/repo/tariff-versions";
const url=process.env.CARGOPILOT_WORKER_TEST_DATABASE_URL,run=process.env.CARGOPILOT_WORKER_RUN_ID;
if(!url||!run||!/^[a-f0-9]{12}$/.test(run))throw Error("Disposable run required");
const target=new URL(url);if(target.hostname!=="127.0.0.1"||target.username!=="cp_worker_it"||target.pathname!=="/cp_worker_"+run)throw Error("Refusing existing database");
const options="-c statement_timeout=5000 -c lock_timeout=2000 -c idle_in_transaction_session_timeout=5000";
const pool=new Pool({connectionString:url,max:2,connectionTimeoutMillis:3000,options});
let mockPrisma:PrismaClient;
const fixture=createTenantDemoFixture(),ms=fixture.companyMemberships;
const user=(i=3):any=>({...ms[i],id:ms[i].userId,membershipId:ms[i].id,companyMembershipId:ms[i].id});
let payerId:string,policyId:string,tariffId:string;
const roleIds:string[]=[];
let fetchSpy:jest.SpyInstance,httpSpy:jest.SpyInstance,httpsSpy:jest.SpyInstance;
const intent=(orderId:string)=>({orderId,operationId:randomUUID(),reason:"Synthetic test operation"});
async function state(){
 const result:any={};for(const t of ["Order","OrderBillTo","BillingPolicyVersion","BillingPolicyDecision","OrderPriceSnapshot","OrderPriceApproval","Invoice","InvoiceIssuanceReceipt","BillingInvoiceOutbox","FinanceNumberSequence","FinanceAuditEvent","FinanceDomainEventOutbox","FinanceJournalEntry"])
  result[t]=(await pool.query('SELECT to_jsonb(t) AS row FROM "'+t+'" t ORDER BY to_jsonb(t)::text')).rows;
 return result;
}
async function policy(content=syntheticBillingPolicy()){
 const p=await proposeBillingPolicy(user(),{operationId:randomUUID(),reason:"Synthetic explicit configuration",content});
 await decideBillingPolicy(user(4),{versionId:p.id,contentHash:p.contentHash,operationId:randomUUID(),decision:"approved",reason:"Independent synthetic configuration approval"});
 return p;
}
async function tariff(currency="UZS",price="100",extra:any={},zone=1){
 const p=await mockPrisma.tariffPlan.create({data:{tenantId:user().tenantId,companyId:user().companyId,name:"Synthetic bucket",serviceType:"DOOR_TO_DOOR",currency,isDefault:true,...extra,rates:{create:{zone,weightFromKg:"0.01",weightToKg:"100",price}}}});
 const current=await mockPrisma.tariffPlan.findUniqueOrThrow({where:{id:p.id}});
 const v=await proposeTariffVersion({user:user(),planId:p.id,expectedGeneration:current.contentGeneration,operationId:randomUUID(),reason:"Synthetic tariff"});
 await decideTariffVersion({user:user(4),planId:p.id,versionId:v.id,operationId:randomUUID(),contentSha256:v.contentSha256,decision:"approved",reason:"Synthetic tariff approval"});
 return p.id;
}
async function order(extra:any={}){
 const f=fixture.orders[0];
 return mockPrisma.order.create({data:{id:randomUUID(),orderNumber:"SYNTHETIC-"+randomUUID(),tenantId:f.tenantId,ownerOrgId:f.ownerOrgId,assignedOrgId:f.assignedOrgId,
  customerId:f.customerId,customerEntityId:f.customerEntityId,senderAddressId:f.senderAddressId,receiverAddressId:f.receiverAddressId,currentWarehouseId:f.currentWarehouseId,
  pickupAddress:"Synthetic A",dropoffAddress:"Synthetic B",weightKg:2,currency:"UZS",serviceType:"DOOR_TO_DOOR",paymentType:"CARD",...extra}});
}
async function ready(extra:any={}){
 const o=await order(extra),p=intent(o.id);
 await bindOrderBillTo(user(),{...intent(o.id),payerCustomerEntityId:payerId,evidence:"SYNTHETIC payer instruction; not recipient"});
 const accepted=await acceptOrderPrice(user(),p);return {o,p,accepted};
}
function issuance(o:any,accepted:any){return {user:user(),...intent(o.id),priceApprovalId:accepted.id};}
beforeAll(async()=>{
 const marker=(await pool.query('SELECT "runId" FROM "_CPDisposableRun"')).rows;if(marker.length!==1||marker[0].runId!==run)throw Error("Ownership mismatch");
 const c=await pool.connect();try{await c.query("BEGIN");await persistTenantDemoFixture(c,fixture);await c.query("COMMIT");}finally{await c.query("ROLLBACK");c.release();}
 mockPrisma=new PrismaClient({adapter:new PrismaPg({connectionString:url,max:6,connectionTimeoutMillis:3000,options})});
 const permissions=await Promise.all(["billing.policies.propose","billing.policies.approve","billing.payers.bind","pricing.orders.accept","pricing.orders.approve","pricing.tariffs.propose","pricing.tariffs.approve","pricing.read","customers.read","finance.invoices.issue","finance.invoices.read"].map(key=>mockPrisma.permission.create({data:{key,resource:"synthetic",action:"synthetic"}})));
 for(const m of ms){const role=await mockPrisma.role.create({data:{code:randomUUID(),name:"Synthetic finance authority",companyId:m.companyId}});roleIds.push(role.id);
  for(const p of permissions)await mockPrisma.rolePermission.create({data:{roleId:role.id,permissionId:p.id}});
  await mockPrisma.membershipRole.create({data:{membershipId:m.id,roleId:role.id}});
  await mockPrisma.membershipScope.create({data:{membershipId:m.id,scopeType:"company",scopeRefId:m.companyId}});
 }
 await mockPrisma.address.update({where:{id:fixture.addresses[0].id},data:{city:"Synthetic A",country:"ZZ"}});
 await mockPrisma.address.update({where:{id:fixture.addresses[1].id},data:{city:"Synthetic B",country:"ZZ"}});
 payerId=(await mockPrisma.customerEntity.create({data:{tenantId:user().tenantId,name:"Synthetic separate bill-to payer"}})).id;
 policyId=(await policy()).id;tariffId=await tariff();
 fetchSpy=jest.spyOn(global,"fetch").mockRejectedValue(Error("Network forbidden"));
 httpSpy=jest.spyOn(http,"request").mockImplementation(()=>{throw Error("HTTP forbidden");});
 httpsSpy=jest.spyOn(https,"request").mockImplementation(()=>{throw Error("HTTPS forbidden");});
});
afterEach(()=>{expect(fetchSpy).not.toHaveBeenCalled();expect(httpSpy).not.toHaveBeenCalled();expect(httpsSpy).not.toHaveBeenCalled();});
afterAll(async()=>{fetchSpy?.mockRestore();httpSpy?.mockRestore();httpsSpy?.mockRestore();await mockPrisma?.$disconnect();await pool.end();});
it("actual approved tariff/settings -> standard accepted components -> same-currency invoice -> original retry",async()=>{
 const {o,p,accepted}=await ready({codAmount:99999});
 expect(accepted).toMatchObject({state:"accepted",total:"110.0100",currency:"UZS"});
 expect(accepted.content.components).toMatchObject([{type:"base_tariff",amount:"100.00"},{type:"additional_fee",amount:"0.01"},{type:"tax",amount:"10.00"}]);
 expect(accepted.content.payerCustomerEntityId).toBe(payerId);
 expect(await acceptOrderPrice(user(),p)).toEqual(accepted);
 const args=issuance(o,accepted),invoice=await issueOrderInvoiceForActor(args);
 expect(invoice).toMatchObject({amount:"110.0100",currency:"UZS",status:"issued",billing:{payerCustomerEntityId:payerId,priceApprovalId:accepted.id}});
 expect(await issueOrderInvoiceForActor(args)).toEqual(invoice);
 const beforeReads=await state();
 expect(await getInvoiceByOrder(o.id,user())).toMatchObject({billing:invoice.billing});
 expect((await listInvoicesForActor({user:user(),limit:100})).items.find(row=>row.id===invoice.id)).toMatchObject({billing:invoice.billing});
 expect(await state()).toEqual(beforeReads);
 expect(await mockPrisma.billingInvoiceOutbox.count({where:{invoiceId:invoice.id,state:"held_no_accounting_authority"}})).toBe(1);
 expect(await mockPrisma.financeJournalEntry.count()).toBe(0);
});
it("concurrent matching acceptance and issuance create one price, invoice, receipt, audit and event",async()=>{
 const o=await order();await bindOrderBillTo(user(),{...intent(o.id),payerCustomerEntityId:payerId,evidence:"SYNTHETIC"});
 const p=intent(o.id),prices=await Promise.all(Array.from({length:3},()=>acceptOrderPrice(user(),p)));
 expect(new Set(prices.map(v=>v.id)).size).toBe(1);
 const args=issuance(o,prices[0]),invoices=await Promise.all(Array.from({length:3},()=>issueOrderInvoiceForActor(args)));
 expect(new Set(invoices.map(v=>v.id)).size).toBe(1);
 expect(await mockPrisma.orderPriceSnapshot.count({where:{orderId:o.id}})).toBe(1);
 expect(await mockPrisma.invoiceIssuanceReceipt.count({where:{orderId:o.id}})).toBe(1);
 expect(await mockPrisma.billingInvoiceOutbox.count({where:{orderId:o.id}})).toBe(1);
 expect(await mockPrisma.financeAuditEvent.count({where:{action:"billing.invoice.issued",detailsJson:{path:["invoiceId"],equals:invoices[0].id}}})).toBe(1);
});
it("conflicting IDs and caller monetary/ownership authority reject without changes",async()=>{
 const {o,p,accepted}=await ready(),args=issuance(o,accepted);await issueOrderInvoiceForActor(args);const before=await state();
 for(const call of [()=>acceptOrderPrice(user(),{...p,reason:"Different intent"}),()=>acceptOrderPrice(user(),{...p,total:"1"}),()=>acceptOrderPrice(user(),{...p,tenantId:user().tenantId}),
  ()=>issueOrderInvoiceForActor({...args,reason:"Different intent"}),()=>issueOrderInvoiceForActor({...args,priceApprovalId:randomUUID()}),()=>issueOrderInvoiceForActor({...args,amount:"1"} as any)])
  await expect(call()).rejects.toThrow();
 expect(await state()).toEqual(before);
});
it("cross-tenant, same-tenant company, forged and missing contexts cannot use a known receipt",async()=>{
 const {o,p,accepted}=await ready(),args=issuance(o,accepted);await issueOrderInvoiceForActor(args);const before=await state();
 for(const actor of [user(1),user(2),{}, {...user(),tenantMembershipId:user(2).tenantMembershipId}]){
  await expect(acceptOrderPrice(actor,p)).rejects.toThrow();await expect(issueOrderInvoiceForActor({...args,user:actor})).rejects.toThrow();
  await expect(readBillingPolicy(actor,policyId)).rejects.toThrow();
 }
 expect(await state()).toEqual(before);
});
it("fresh removed permission and scope deny invoice/price retries",async()=>{
 const {o,p,accepted}=await ready(),args=issuance(o,accepted);await issueOrderInvoiceForActor(args);
 const grant=await mockPrisma.rolePermission.findFirstOrThrow({where:{roleId:roleIds[3],permission:{key:"finance.invoices.issue"}}});
 await mockPrisma.rolePermission.delete({where:{id:grant.id}});
 try{const before=await state();await expect(issueOrderInvoiceForActor(args)).rejects.toThrow();expect(await state()).toEqual(before);}finally{await mockPrisma.rolePermission.create({data:grant});}
 const scope=await mockPrisma.membershipScope.findFirstOrThrow({where:{membershipId:user().companyMembershipId}});await mockPrisma.membershipScope.delete({where:{id:scope.id}});
 try{const before=await state();await expect(acceptOrderPrice(user(),p)).rejects.toThrow();expect(await state()).toEqual(before);}finally{await mockPrisma.membershipScope.create({data:scope});}
});
it("bill-to is explicit, scoped and immutable, never inferred from recipient/customer user or COD",async()=>{
 const o=await order(),before=await state();
 await expect(acceptOrderPrice(user(),intent(o.id))).rejects.toMatchObject({code:"BILLING_PAYER_INSTRUCTION_REQUIRED"});
 await expect(bindOrderBillTo(user(),{...intent(o.id),payerCustomerEntityId:fixture.customers[1].id,evidence:"Synthetic foreign"})).rejects.toThrow();
 expect(await state()).toEqual(before);
 const p={...intent(o.id),payerCustomerEntityId:payerId,evidence:"Synthetic instruction"};
 const first=await bindOrderBillTo(user(),p);expect(await bindOrderBillTo(user(),p)).toEqual(first);
 const bound=await state();await expect(bindOrderBillTo(user(),{...p,payerCustomerEntityId:fixture.customers[0].id})).rejects.toThrow();expect(await state()).toEqual(bound);
});
it("unsupported or absent policies, duplicate included fees and automatic billing create no approved authority",async()=>{
 const before=await state();
 for(const content of [syntheticBillingPolicy({tax:{}}),syntheticBillingPolicy({fees:[{service:"delivery",amount:"1"}]}),syntheticBillingPolicy({billing:{mode:"automatic"}})])
  await expect(proposeBillingPolicy(user(),{...intent(randomUUID()),content})).rejects.toThrow();
 expect(await state()).toEqual(before);
 const o=await order({currency:"XTS"});await bindOrderBillTo(user(),{...intent(o.id),payerCustomerEntityId:payerId,evidence:"Synthetic"});
 const unchanged=await state();await expect(acceptOrderPrice(user(),intent(o.id))).rejects.toMatchObject({code:"BILLING_CURRENCY_POLICY_UNCONFIGURED"});expect(await state()).toEqual(unchanged);
});
it("policy publication requires independent exact current content and durable matching retries",async()=>{
 const content=syntheticBillingPolicy(),p={operationId:randomUUID(),reason:"Synthetic proposal",content};
 const v=await proposeBillingPolicy(user(),p);expect(await proposeBillingPolicy(user(),p)).toEqual(v);
 const a={versionId:v.id,contentHash:v.contentHash,operationId:randomUUID(),decision:"approved",reason:"Independent synthetic"};
 const before=await state();
 await expect(decideBillingPolicy(user(),a)).rejects.toThrow();
 await expect(decideBillingPolicy(user(4),{...a,contentHash:"0".repeat(64)})).rejects.toThrow();
 expect(await state()).toEqual(before);
 const done=await decideBillingPolicy(user(4),a);expect(await decideBillingPolicy(user(4),a)).toEqual(done);
 const confirmed=await state();await expect(decideBillingPolicy(user(4),{...a,reason:"Changed"})).rejects.toThrow();expect(await state()).toEqual(confirmed);
});
it("changed policy proposal invalidates older pending publication",async()=>{
 const old=await proposeBillingPolicy(user(),{operationId:randomUUID(),reason:"Synthetic stale",content:syntheticBillingPolicy()});
 const current=await proposeBillingPolicy(user(),{operationId:randomUUID(),reason:"Synthetic new",content:syntheticBillingPolicy({precision:3})});
 const before=await state();await expect(decideBillingPolicy(user(4),{versionId:old.id,contentHash:old.contentHash,operationId:randomUUID(),decision:"approved",reason:"Stale"})).rejects.toThrow();expect(await state()).toEqual(before);
 await decideBillingPolicy(user(4),{versionId:current.id,contentHash:current.contentHash,operationId:randomUUID(),decision:"rejected",reason:"Synthetic rejection"});
});
it("discount proposals cannot self-approve; independent approval accepts exact discounted price",async()=>{
 await policy(syntheticBillingPolicy({discounts:[{code:"SYNTHETIC",type:"flat",value:"10"}]}));
 try{
  const {o,accepted}=await ready();expect(accepted.state).toBe("approval_required");
  const a={...intent(o.id),snapshotId:accepted.id,contentHash:accepted.contentHash},before=await state();
  await expect(approveOrderPrice(user(),a)).rejects.toThrow();await expect(issueOrderInvoiceForActor(issuance(o,accepted))).rejects.toThrow();expect(await state()).toEqual(before);
  const approved=await approveOrderPrice(user(4),a);expect(approved).toMatchObject({state:"accepted",total:"99.0100"});
  expect(await approveOrderPrice(user(4),a)).toEqual(approved);
  expect(await issueOrderInvoiceForActor(issuance(o,approved))).toMatchObject({amount:"99.0100"});
 }finally{await policy();}
});
it("revisions preserve original history and require separate approval; issued invoices cannot be reinterpreted",async()=>{
 const {o,p,accepted}=await ready(),revised=await acceptOrderPrice(user(),intent(o.id));
 expect(revised.state).toBe("approval_required");
 expect(await acceptOrderPrice(user(),p)).toEqual(accepted);
 const a={...intent(o.id),snapshotId:revised.id,contentHash:revised.contentHash};
 await approveOrderPrice(user(4),a);
 await issueOrderInvoiceForActor(issuance(o,revised));
 const before=await state();await expect(acceptOrderPrice(user(),intent(o.id))).rejects.toMatchObject({code:"BILLING_INVOICE_CORRECTION_POLICY_REQUIRED"});expect(await state()).toEqual(before);
});
it("changed source inputs and superseded policies invalidate pending exception approval",async()=>{
 await policy(syntheticBillingPolicy({discounts:[{code:"SYNTHETIC",type:"flat",value:"1"}]}));
 try{
  const {o,accepted}=await ready(),a={...intent(o.id),snapshotId:accepted.id,contentHash:accepted.contentHash};
  await mockPrisma.order.update({where:{id:o.id},data:{weightKg:3}});
  const before=await state();await expect(approveOrderPrice(user(4),a)).rejects.toMatchObject({code:"BILLING_PRICE_SOURCE_CHANGED"});expect(await state()).toEqual(before);
  await mockPrisma.order.update({where:{id:o.id},data:{weightKg:2}});await policy();
  const changed=await state();await expect(approveOrderPrice(user(4),a)).rejects.toThrow();expect(await state()).toEqual(changed);
 }finally{await policy();}
});
it("configured foreign-base currency is accepted without hardcoded lists but cannot fabricate invoice FX",async()=>{
 await policy(syntheticBillingPolicy({currency:"KWD",precision:3}));await tariff("KWD");
 const {o,accepted}=await ready({currency:"KWD"});expect(accepted.currency).toBe("KWD");
 const before=await state();await expect(issueOrderInvoiceForActor(issuance(o,accepted))).rejects.toMatchObject({code:"BILLING_BASE_CURRENCY_FX_POLICY_REQUIRED"});expect(await state()).toEqual(before);
});
it.each([{senderAddressId:null},{weightKg:null},{status:"cancelled"},{customerEntityId:null}])("incomplete/ineligible authoritative input %j rejects without price effects",async extra=>{
 const o=await order(extra);await bindOrderBillTo(user(),{...intent(o.id),payerCustomerEntityId:payerId,evidence:"Synthetic"});
 const before=await state();await expect(acceptOrderPrice(user(),intent(o.id))).rejects.toThrow();expect(await state()).toEqual(before);
});
it("invoice/number/receipt/audit/outbox transaction rolls back after injected final write failure",async()=>{
 const {o,accepted}=await ready(),before=await state();
 await pool.query("CREATE FUNCTION cp_test_invoice_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Synthetic rollback'; END $$");
 await pool.query('CREATE TRIGGER cp_test_invoice_failure BEFORE INSERT ON "BillingInvoiceOutbox" FOR EACH ROW EXECUTE FUNCTION cp_test_invoice_failure()');
 try{await expect(issueOrderInvoiceForActor(issuance(o,accepted))).rejects.toThrow();expect(await state()).toEqual(before);}
 finally{await pool.query('DROP TRIGGER cp_test_invoice_failure ON "BillingInvoiceOutbox"; DROP FUNCTION cp_test_invoice_failure()');}
});
it("lost commit acknowledgement followed by the original issuance ID returns one durable invoice",async()=>{
 const {o,accepted}=await ready(),args=issuance(o,accepted),tx=mockPrisma.$transaction.bind(mockPrisma);
 const spy=jest.spyOn(mockPrisma,"$transaction").mockImplementationOnce(async(...a:any[])=>{await(tx as any)(...a);throw Error("Synthetic lost acknowledgement");});
 try{await expect(issueOrderInvoiceForActor(args)).rejects.toThrow("Synthetic lost acknowledgement");}finally{spy.mockRestore();}
 const result=await issueOrderInvoiceForActor(args),before=await state();expect(await issueOrderInvoiceForActor(args)).toEqual(result);expect(await state()).toEqual(before);
 expect(await mockPrisma.invoiceIssuanceReceipt.count({where:{orderId:o.id}})).toBe(1);
});
it("database immutability and compound references protect price, payer, configuration and issued history",async()=>{
 const {o,accepted}=await ready(),invoice=await issueOrderInvoiceForActor(issuance(o,accepted)),before=await state();
 for(const [table,key,id] of [["OrderPriceSnapshot","id",accepted.id],["OrderPriceApproval","snapshotId",accepted.id],["BillingPolicyVersion","id",policyId]]){
  await expect(pool.query('UPDATE "'+table+'" SET reason=\'changed\' WHERE "'+key+'"=$1',[id])).rejects.toMatchObject({code:"23514"});
  await expect(pool.query('TRUNCATE "'+table+'" CASCADE')).rejects.toMatchObject({code:"23514"});
 }
 await expect(mockPrisma.invoice.update({where:{id:invoice.id},data:{amount:"1"}})).rejects.toThrow();
 await expect(mockPrisma.invoice.update({where:{id:invoice.id},data:{fxRate:"2"}})).rejects.toThrow();
 await expect(mockPrisma.invoice.update({where:{id:invoice.id},data:{status:"pending"}})).rejects.toThrow();
 await expect(mockPrisma.invoice.update({where:{id:invoice.id},data:{billingLegalEntityId:fixture.financeLegalEntities[1].id}})).rejects.toThrow();
 await expect(mockPrisma.order.update({where:{id:o.id},data:{currentPriceApprovalId:null}})).rejects.toThrow();
 expect(await state()).toEqual(before);
});
it("price acceptance rollback removes snapshot, acceptance, pointer and audit together",async()=>{
 const o=await order();await bindOrderBillTo(user(),{...intent(o.id),payerCustomerEntityId:payerId,evidence:"Synthetic"});
 const before=await state();
 await pool.query("CREATE FUNCTION cp_test_price_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Synthetic price rollback'; END $$");
 await pool.query('CREATE TRIGGER cp_test_price_failure BEFORE UPDATE OF "currentPriceApprovalId" ON "Order" FOR EACH ROW EXECUTE FUNCTION cp_test_price_failure()');
 try{await expect(acceptOrderPrice(user(),intent(o.id))).rejects.toThrow();expect(await state()).toEqual(before);}
 finally{await pool.query('DROP TRIGGER cp_test_price_failure ON "Order"; DROP FUNCTION cp_test_price_failure()');}
});
it("compound insertion constraints reject foreign entity/customer and wrong actor bridges with no audit effects",async()=>{
 const o=await order(),before=await state(),base:any={...intent(o.id),id:randomUUID(),tenantId:user().tenantId,companyId:user().companyId,
  legalEntityId:fixture.financeLegalEntities[0].id,payerCustomerEntityId:payerId,evidence:"Synthetic",actorUserId:user().id,
  companyMembershipId:user().companyMembershipId,tenantMembershipId:user().tenantMembershipId,intentHash:"a".repeat(64)};
 for(const extra of [{legalEntityId:fixture.financeLegalEntities[1].id},{legalEntityId:fixture.financeLegalEntities[2].id},
  {payerCustomerEntityId:fixture.customers[1].id},{companyMembershipId:user(4).companyMembershipId},{tenantMembershipId:user(2).tenantMembershipId}]){
  await expect(mockPrisma.orderBillTo.create({data:{...base,...extra}})).rejects.toThrow();
 }
 expect(await state()).toEqual(before);
});
it("rejected policy publication and concurrent exact policy retries create only one version/decision/audit",async()=>{
 const p={operationId:randomUUID(),reason:"Synthetic concurrent policy",content:syntheticBillingPolicy({currency:"XTS"})};
 const versions=await Promise.all(Array.from({length:3},()=>proposeBillingPolicy(user(),p)));expect(new Set(versions.map(v=>v.id)).size).toBe(1);
 const a={versionId:versions[0].id,contentHash:versions[0].contentHash,operationId:randomUUID(),decision:"rejected",reason:"Synthetic independent rejection"};
 const decisions=await Promise.all(Array.from({length:3},()=>decideBillingPolicy(user(4),a)));expect(decisions.every(d=>d.decision==="rejected")).toBe(true);
 const o=await order({currency:"XTS"});await bindOrderBillTo(user(),{...intent(o.id),payerCustomerEntityId:payerId,evidence:"Synthetic"});
 const before=await state();await expect(acceptOrderPrice(user(),intent(o.id))).rejects.toMatchObject({code:"BILLING_CURRENCY_POLICY_UNCONFIGURED"});expect(await state()).toEqual(before);
});
it("competing independently approved revisions serialize and only one can replace the current acceptance",async()=>{
 const {o}=await ready(),one=await acceptOrderPrice(user(),intent(o.id)),two=await acceptOrderPrice(user(),intent(o.id));
 const results=await Promise.allSettled([one,two].map(s=>approveOrderPrice(user(4),{...intent(o.id),snapshotId:s.id,contentHash:s.contentHash})));
 expect(results.filter(r=>r.status==="fulfilled")).toHaveLength(1);
 expect(await mockPrisma.orderPriceApproval.count({where:{orderId:o.id}})).toBe(2);
 const current=(await mockPrisma.order.findUniqueOrThrow({where:{id:o.id}})).currentPriceApprovalId;
 expect([one.id,two.id]).toContain(current);
});
it("accepted history survives later configuration changes without recalculating the issued obligation",async()=>{
 const {o,p,accepted}=await ready(),args=issuance(o,accepted),issued=await issueOrderInvoiceForActor(args);
 await policy(syntheticBillingPolicy({fees:[{service:"synthetic_extra",amount:"20"}]}));
 try{const before=await state();expect(await acceptOrderPrice(user(),p)).toEqual(accepted);expect(await issueOrderInvoiceForActor(args)).toEqual(issued);expect(await state()).toEqual(before);}
 finally{await policy();}
});

it("review correction: approved zone zero yields accepted price and same-currency invoice",async()=>{
 const mapping={...syntheticBillingPolicy().zones.mappings[0],zone:0};
 await policy(syntheticBillingPolicy({zones:{source:"structured_address_cities",mappings:[mapping]}}));
 const id=await tariff("UZS","100",{priority:500},0);
 try{const {o,accepted}=await ready();expect(accepted.content.inputs.zone).toBe(0);expect(accepted.content.tariffPlanId).toBe(id);
  expect(await issueOrderInvoiceForActor(issuance(o,accepted))).toMatchObject({amount:"110.0100",currency:"UZS"});
 }finally{await mockPrisma.tariffPlan.update({where:{id},data:{status:"archived"}});await policy();}
});
it("review correction: country-qualified identical city pairs match normalized authoritative addresses",async()=>{
 const m=syntheticBillingPolicy().zones.mappings[0];
 await policy(syntheticBillingPolicy({zones:{source:"structured_address_cities",mappings:[{...m,zone:0},{...m,originCountry:"AA",destinationCountry:"BB",zone:1}]}}));
 const id=await tariff("UZS","100",{priority:500},0);
 try{
  await mockPrisma.address.update({where:{id:fixture.addresses[0].id},data:{city:" SYNTHETIC A ",country:"zz"}});
  const {o,accepted}=await ready();expect(accepted.content.inputs.zone).toBe(0);
  expect(await issueOrderInvoiceForActor(issuance(o,accepted))).toMatchObject({currency:"UZS"});
  await mockPrisma.address.update({where:{id:fixture.addresses[0].id},data:{country:"AA"}});
  await mockPrisma.address.update({where:{id:fixture.addresses[1].id},data:{country:"BB"}});
  // Archive the zone-zero candidate; the other complete route uses the original zone-one tariff.
  await mockPrisma.tariffPlan.update({where:{id},data:{status:"archived"}});
  const second=await ready();expect(second.accepted.content.inputs.zone).toBe(1);
  expect(await issueOrderInvoiceForActor(issuance(second.o,second.accepted))).toMatchObject({currency:"UZS"});
 }finally{
  await mockPrisma.tariffPlan.update({where:{id},data:{status:"archived"}});
  await mockPrisma.address.update({where:{id:fixture.addresses[0].id},data:{city:"Synthetic A",country:"ZZ"}});
  await mockPrisma.address.update({where:{id:fixture.addresses[1].id},data:{country:"ZZ"}});await policy();
 }
});
it("review correction: many unrelated approved snapshots do not block the eligible tariff; drafts are not authority",async()=>{
 const ids:string[]=[];
 // More than the old 100-company-plan cap. Each source is independently approved through actual services.
 for(let i=0;i<106;i++)ids.push(await tariff(i%2 ? "USD":"UZS","900",i%2?{}:{customerEntityId:payerId}));
 try{
  // Both directions: draft changes cannot admit unrelated approval or exclude the relevant approval.
  await mockPrisma.tariffPlan.updateMany({where:{id:{in:ids}},data:{currency:"UZS",customerEntityId:null,priority:999}});
  await mockPrisma.tariffPlan.update({where:{id:tariffId},data:{currency:"USD",priority:-999}});
  const {o,accepted}=await ready();expect(accepted.content.tariffPlanId).toBe(tariffId);expect(accepted.total).toBe("110.0100");
  expect(await issueOrderInvoiceForActor(issuance(o,accepted))).toMatchObject({currency:"UZS",amount:"110.0100"});
 }finally{await mockPrisma.tariffPlan.updateMany({where:{id:{in:ids}},data:{status:"archived"}});await mockPrisma.tariffPlan.update({where:{id:tariffId},data:{currency:"UZS",priority:0}});}
});
it("review correction: excessive relevant approved candidates reject with no price or invoice effects",async()=>{
 await policy(syntheticBillingPolicy({currency:"XTS"}));
 const ids:string[]=[];for(let i=0;i<101;i++)ids.push(await tariff("XTS"));
 try{const o=await order({currency:"XTS"});await bindOrderBillTo(user(),{...intent(o.id),payerCustomerEntityId:payerId,evidence:"Synthetic"});
  const before=await state();await expect(acceptOrderPrice(user(),intent(o.id))).rejects.toMatchObject({code:"BILLING_TARIFF_SELECTION_LIMIT"});expect(await state()).toEqual(before);
 }finally{await mockPrisma.tariffPlan.updateMany({where:{id:{in:ids}},data:{status:"archived"}});}
});
it("review correction: customer/default precedence remains authoritative and missing top bucket never falls back",async()=>{
 const specific=await tariff("UZS","200",{customerEntityId:fixture.customers[0].id,isDefault:false,priority:-100});
 try{const first=await ready();expect(first.accepted.content.tariffPlanId).toBe(specific);expect(first.accepted.total).toBe("220.0100");
  const missing=await tariff("UZS","300",{customerEntityId:fixture.customers[0].id,isDefault:true},0);
  try{const o=await order();await bindOrderBillTo(user(),{...intent(o.id),payerCustomerEntityId:payerId,evidence:"Synthetic"});const before=await state();
   await expect(acceptOrderPrice(user(),intent(o.id))).rejects.toMatchObject({code:"BILLING_BUCKET_AMBIGUOUS_OR_MISSING"});expect(await state()).toEqual(before);
  }finally{await mockPrisma.tariffPlan.update({where:{id:missing},data:{status:"archived"}});}
 }finally{await mockPrisma.tariffPlan.update({where:{id:specific},data:{status:"archived"}});}
});
