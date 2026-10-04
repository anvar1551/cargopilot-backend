jest.mock("../../src/modules/identity-access/transport/fastify-auth",()=>({fastifyAuth:(o:any)=>async(req:any,reply:any)=>{mockPermission=o.permission;if(!mockAuthenticated)return reply.code(401).send({error:"Unauthorized"});req.user=mockUser;}}));
jest.mock("../../src/modules/pricing-core/repo/billing-policy",()=>({proposeBillingPolicy:jest.fn(),decideBillingPolicy:jest.fn(),readBillingPolicy:jest.fn()}));
jest.mock("../../src/modules/pricing-core/repo/order-price",()=>({bindOrderBillTo:jest.fn(),acceptOrderPrice:jest.fn(),approveOrderPrice:jest.fn()}));
jest.mock("../../src/modules/invoice-core/application/invoiceRepo",()=>({issueOrderInvoiceForActor:jest.fn(),listInvoicesForActor:jest.fn(),getAuthorizedInvoiceFile:jest.fn()}));
jest.mock("../../src/utils/s3Presign",()=>({presignGetObject:jest.fn()}));
import Fastify from "fastify";
import { registerBillingPolicyRoutes } from "../../src/modules/pricing-core/transport/billing.routes";
import invoiceRoutes from "../../src/modules/invoice-core/transport/fastify-routes";
import { acceptOrderPrice } from "../../src/modules/pricing-core/repo/order-price";
import { issueOrderInvoiceForActor } from "../../src/modules/invoice-core/application/invoiceRepo";
import { readBillingPolicy } from "../../src/modules/pricing-core/repo/billing-policy";
const id="019b0000-0000-7000-8100-000000000001",operationId="019b0000-0000-7000-8100-000000000002",priceApprovalId="019b0000-0000-7000-8100-000000000003";
const mockUser={id:"verified",tenantId:"selected-tenant",companyMembershipId:"selected-member"};
let mockAuthenticated=true,mockPermission="";
const app=Fastify();registerBillingPolicyRoutes(app);app.register(invoiceRoutes,{prefix:"/invoices"});
beforeEach(()=>{jest.clearAllMocks();mockAuthenticated=true;mockPermission="";});
afterAll(()=>app.close());
it("price acceptance forwards only verified context, path order and original operation identity",async()=>{
 jest.mocked(acceptOrderPrice).mockResolvedValue({state:"accepted"} as any);
 const body={operationId,reason:"Synthetic"};const r=await app.inject({method:"POST",url:"/orders/"+id+"/price-acceptance",payload:body});
 expect(r.statusCode).toBe(201);expect(mockPermission).toBe("pricing.orders.accept");expect(acceptOrderPrice).toHaveBeenCalledWith(mockUser,{...body,orderId:id});
});
it("path/body order conflict rejects before service work",async()=>{
 expect((await app.inject({method:"POST",url:"/orders/"+id+"/price-acceptance",payload:{operationId,reason:"Synthetic",orderId:priceApprovalId}})).statusCode).toBe(400);
 expect(acceptOrderPrice).not.toHaveBeenCalled();
});
it("manual issuance preserves accepted-price selector and durable ID",async()=>{
 jest.mocked(issueOrderInvoiceForActor).mockResolvedValue({id,amount:"110.0100"} as any);
 const body={operationId,priceApprovalId,reason:"Synthetic"};const r=await app.inject({method:"POST",url:"/invoices/orders/"+id+"/issue",payload:body});
 expect(r.statusCode).toBe(201);expect(mockPermission).toBe("finance.invoices.issue");expect(issueOrderInvoiceForActor).toHaveBeenCalledWith({user:mockUser,orderId:id,...body});
});
it.each([{amount:"1"},{currency:"USD"},{tenantId:id},{dueAt:"2026-10-01T00:00:00.000Z"}])("financial/ownership/due-date override rejects before issuance",async extra=>{
 const r=await app.inject({method:"POST",url:"/invoices/orders/"+id+"/issue",payload:{operationId,priceApprovalId,reason:"Synthetic",...extra}});
 expect(r.statusCode).toBe(400);expect(issueOrderInvoiceForActor).not.toHaveBeenCalled();
});
it("anonymous callers receive no policy/service response",async()=>{
 mockAuthenticated=false;expect((await app.inject({method:"GET",url:"/billing-policies/"+id})).statusCode).toBe(401);expect(readBillingPolicy).not.toHaveBeenCalled();
});
it("unexpected configuration diagnostics are masked",async()=>{
 jest.mocked(readBillingPolicy).mockRejectedValue(Error("SYNTHETIC_PRIVATE_CANARY"));
 const r=await app.inject({method:"GET",url:"/billing-policies/"+id});expect(r.statusCode).toBe(500);expect(r.body).not.toContain("SYNTHETIC_PRIVATE_CANARY");
});
