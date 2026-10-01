jest.mock("../../src/config/prismaClient",()=>({__esModule:true,default:require("./fixtures").database}));
jest.mock("../../src/config/redis",()=>({getRedisClient:jest.fn(async()=>null),getRedisPrefix:()=>"test",withRedisTimeout:async(_name:string,work:()=>Promise<unknown>)=>work()}));
jest.mock("../../src/modules/identity-access/access-control",()=>({loadAccessSnapshot:jest.fn(),buildOrderScopeWhere:jest.fn(),authorize:jest.fn(),clearIdentityAccessCacheForUser:jest.fn()}));
jest.mock("../../src/modules/identity-access/transport/fastify-auth",()=>({fastifyAuth:()=>async(request:any)=>{request.user=mockActor;}}));
jest.mock("../../src/utils/s3Presign",()=>({presignGetObject:jest.fn(async()=>"synthetic-confirmed-url")}));
jest.mock("../../src/modules/analytics-core/infrastructure/analyticsOutbox",()=>({enqueueCargoPilotDomainEventTx:jest.fn()}));
jest.mock("../../src/modules/orders-legs/pricing",()=>({resolvePayableTotalFromPricing:jest.fn()}));
import Fastify from "fastify";
import {Prisma} from "@prisma/client";
import routes from "../../src/modules/invoice-core/transport/fastify-routes";
import {database} from "./fixtures";
import {loadAccessSnapshot,buildOrderScopeWhere} from "../../src/modules/identity-access/access-control";
import {presignGetObject} from "../../src/utils/s3Presign";
import {listInvoicesForActor,getInvoiceByOrder,getAuthorizedInvoiceFile,issueOrderInvoiceForActor} from "../../src/modules/invoice-core/application/invoiceRepo";
import {resolvePayableTotalFromPricing} from "../../src/modules/orders-legs/pricing";
const mockActor:any={id:"user-a",companyId:"company-a",tenantId:"tenant-a",membershipId:"cm-a",companyMembershipId:"cm-a",tenantMembershipId:"tm-a"};
const snapshot:any={...mockActor,userId:mockActor.id,permissionCodes:["finance.invoices.read","payments.intents.read"],scopes:[{scopeType:"warehouse",scopeRefId:"warehouse-a"}]};
const row:any={id:"invoice-a",companyId:"company-a",orderId:"order-a",amount:new Prisma.Decimal("90071992547409.9300"),fxRate:new Prisma.Decimal("1.1234567890"),invoiceNumber:"SYNTHETIC-1",status:"issued",invoiceKey:"private-canary-key",metadataJson:{private:"CANARY"},currency:"USD",createdAt:new Date(),order:{orderNumber:"SYNTHETIC-ORDER",password:"CANARY"},customerEntity:{id:"customer-a",name:"Synthetic",companyName:"Synthetic",password:"CANARY"}};
beforeEach(()=>{
 jest.clearAllMocks();jest.mocked(loadAccessSnapshot).mockReset().mockResolvedValue(snapshot);jest.mocked(buildOrderScopeWhere).mockReset().mockResolvedValue({currentWarehouseId:"warehouse-a"});
 database.invoice.findMany.mockReset().mockResolvedValue([row]);database.invoice.findFirst.mockReset().mockResolvedValue(row);database.invoice.findUnique.mockReset().mockResolvedValue(null);database.invoice.create.mockReset().mockResolvedValue(row);database.invoice.update.mockReset();database.order.findFirst.mockReset().mockResolvedValue({id:"order-a",ownerOrgId:"company-a",orderNumber:"SYNTHETIC",customerId:mockActor.id,customerEntityId:null});database.$transaction.mockReset().mockImplementation(async(fn:any)=>fn(database));
});
function safePredicate(where:any){const serialized=JSON.stringify(where);expect(serialized).toContain('"tenantId":"tenant-a"');expect(serialized).toContain('"companyId":"company-a"');expect(serialized).toContain('"ownerOrgId":"company-a"');expect(serialized).toContain('"currentWarehouseId":"warehouse-a"');}
function noEffects(){expect(database.invoice.create).not.toHaveBeenCalled();expect(database.invoice.update).not.toHaveBeenCalled();expect(presignGetObject).not.toHaveBeenCalled();}
test("authorized list preserves exact decimal strings and explicit nested projections",async()=>{
 const result=await listInvoicesForActor({user:mockActor,limit:10});expect(result.items[0].amount).toBe("90071992547409.9300");expect(result.items[0].fxRate).toBe("1.1234567890");expect(JSON.stringify(result)).not.toContain("CANARY");expect(JSON.stringify(result)).not.toContain("private-canary-key");
 safePredicate(database.invoice.findMany.mock.calls[0][0].where);expect(database.invoice.findMany.mock.calls[0][0].select.invoiceKey).toBeUndefined();noEffects();
});
test.each([undefined,{...mockActor,tenantId:null},{...mockActor,membershipId:"wrong"}])("missing/unbound selected context denies invoice reads and file references",async actor=>{
 await expect(listInvoicesForActor({user:actor,limit:10})).rejects.toMatchObject({statusCode:403});await expect(getAuthorizedInvoiceFile("invoice-a",actor)).rejects.toMatchObject({statusCode:403});expect(database.invoice.findMany).not.toHaveBeenCalled();expect(database.invoice.findFirst).not.toHaveBeenCalled();noEffects();
});
test.each([null,{...snapshot,companyId:"company-b"},{...snapshot,tenantId:"tenant-b"},{...snapshot,userId:"other"},{...snapshot,tenantMembershipId:"other"},{...snapshot,permissionCodes:[]}])("fresh context mismatch/revocation cannot expose invoices",async value=>{
 jest.mocked(loadAccessSnapshot).mockResolvedValue(value);await expect(getInvoiceByOrder("order-a",mockActor)).rejects.toMatchObject({statusCode:403});expect(database.invoice.findFirst).not.toHaveBeenCalled();noEffects();
});
test.each([null,{}, {id:"__no_access__"},{AND:[{tenantId:"tenant-a"},{id:"__no_access__"}]}])("missing/nested-denied order scope fails closed without invalid UUID queries",async value=>{
 jest.mocked(buildOrderScopeWhere).mockResolvedValue(value as any);await expect(listInvoicesForActor({user:mockActor,limit:10})).rejects.toMatchObject({statusCode:403});expect(database.invoice.findMany).not.toHaveBeenCalled();noEffects();
});
test.each(["foreign-tenant","other-company","legacy-null","restricted-object"])("known %s invoice cannot be retrieved or signed",async _kind=>{
 database.invoice.findFirst.mockResolvedValue(null);expect(await getInvoiceByOrder("known-foreign",mockActor)).toBeNull();await expect(getAuthorizedInvoiceFile("known-foreign",mockActor)).rejects.toMatchObject({statusCode:404});for(const call of database.invoice.findFirst.mock.calls)safePredicate(call[0].where);noEffects();
});
test("foreign cursor cannot position an authorized list",async()=>{
 database.invoice.findFirst.mockResolvedValue(null);await expect(listInvoicesForActor({user:mockActor,limit:10,cursor:"foreign"})).rejects.toMatchObject({statusCode:404});expect(database.invoice.findMany).not.toHaveBeenCalled();safePredicate(database.invoice.findFirst.mock.calls[0][0].where);noEffects();
});
test("owned cursor uses an authorized date/id keyset without unscoped Prisma cursor",async()=>{
 await listInvoicesForActor({user:mockActor,limit:10,cursor:row.id});const query=database.invoice.findMany.mock.calls[0][0];expect(query.cursor).toBeUndefined();expect(JSON.stringify(query.where)).toContain('"lt":"invoice-a"');safePredicate(query.where);noEffects();
});
test.each([0,101,NaN,1.5])("service bounds pagination independently of HTTP validation",async limit=>{
 await expect(listInvoicesForActor({user:mockActor,limit})).rejects.toMatchObject({statusCode:400});expect(database.invoice.findMany).not.toHaveBeenCalled();noEffects();
});
test("HTTP signing authorizes first and retains order/invoice identifier compatibility",async()=>{
 const app=Fastify();await app.register(routes);try{const response=await app.inject({method:"GET",url:"/orders/invoice-a/url"});expect(response.statusCode).toBe(200);expect(response.json()).toEqual({url:"synthetic-confirmed-url"});expect(presignGetObject).toHaveBeenCalledWith(row.invoiceKey,300);safePredicate(database.invoice.findFirst.mock.calls[0][0].where);}finally{await app.close();}
});
test("HTTP denied lookup produces no protected output or signing call",async()=>{
 database.invoice.findFirst.mockResolvedValue(null);const app=Fastify();await app.register(routes);try{const response=await app.inject({method:"GET",url:"/orders/foreign/url"});expect(response.statusCode).toBe(404);expect(response.json()).not.toHaveProperty("url");noEffects();}finally{await app.close();}
});
test("HTTP database failures are sanitized and never invoke signing",async()=>{
 database.invoice.findFirst.mockRejectedValue(new Error("CANARY database detail"));const app=Fastify();await app.register(routes);try{const response=await app.inject({method:"GET",url:"/orders/foreign/url"});expect(response.statusCode).toBe(500);expect(response.body).not.toContain("CANARY");noEffects();}finally{await app.close();}
});
test("issuance receipt preserves exact projection after fresh authorization",async()=>{
 jest.mocked(loadAccessSnapshot).mockResolvedValue({...snapshot,permissionCodes:["finance.invoices.issue"]});
 database.$executeRaw.mockResolvedValue(0); database.$queryRaw.mockResolvedValue([{id:"order-a"}]);
 database.financeLegalEntity.findFirst.mockResolvedValue({id:"entity-a"});
 database.order.findFirst.mockResolvedValue({id:"order-a",tenantId:"tenant-a",ownerOrgId:"company-a",customerId:"user-a",customerEntityId:null});
 database.invoice.findFirst.mockResolvedValue({...row,customerId:"user-a",customerEntityId:null,issuedAt:new Date(),issuedByUserId:"user-a"});
 const result=await issueOrderInvoiceForActor({user:mockActor,orderId:"order-a"});
 expect(result.amount).toBe("90071992547409.9300");expect(result.fxRate).toBe("1.1234567890");
 expect(JSON.stringify(result)).not.toContain("CANARY");expect(result).not.toHaveProperty("invoiceKey");noEffects();
});
