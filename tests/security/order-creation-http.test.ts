jest.mock("../../src/modules/orders-core/read/import-receipt-status",()=>({readImportReceiptStatus:jest.fn()}));
jest.mock("../../src/config/prismaClient",()=>({__esModule:true,default:require("./fixtures").database}));
jest.mock("../../src/modules/identity-access",()=>({authorize:jest.fn(),buildOrderScopeWhere:jest.fn()}));
jest.mock("../../src/modules/identity-access/transport/fastify-auth",()=>({fastifyAuth:()=>async()=>undefined}));
jest.mock("../../src/modules/orders-core",()=>({createOrderForActor:jest.fn(),importOrdersFromCsv:jest.fn(),previewOrderImport:jest.fn(),getOrderImportTemplateCsv:jest.fn()}));
jest.mock("../../src/modules/orders-core/transport/shared",()=>({...jest.requireActual("../../src/modules/orders-core/transport/shared"),emitMutationInvalidation:jest.fn()}));
import Fastify from "fastify";
import ordersRoutes from "../../src/modules/orders-core/transport/routes/orders.routes";
import importRoutes from "../../src/modules/orders-core/transport/routes/import.routes";
import {createOrderForActor,importOrdersFromCsv} from "../../src/modules/orders-core";
import {emitMutationInvalidation} from "../../src/modules/orders-core/transport/shared";
const user:any={id:"synthetic-user",tenantId:"tenant-a",companyId:"company-a",companyMembershipId:"membership-a"};
beforeEach(()=>jest.clearAllMocks());
async function appFor(plugin:any){const app=Fastify();app.setValidatorCompiler(()=>()=>true);app.addHook("onRequest",async request=>{request.user=user;});await app.register(plugin);return app;}
it.each([false,true])("normal creation passes immutable operation request and invalidates only new creation (replay=%s)",async replay=>{
  const app=await appFor(ordersRoutes);
  try{const body={operationId:"50000000-0000-4000-8000-000000000001"};(createOrderForActor as jest.Mock).mockResolvedValue({statusCode:201,payload:{order:{id:"order-a"},creationReplay:replay}});
    const response=await app.inject({method:"POST",url:"/",payload:body});expect(response.statusCode).toBe(201);expect(createOrderForActor).toHaveBeenCalledWith({user,body});expect(emitMutationInvalidation).toHaveBeenCalledTimes(replay?0:1);
  }finally{await app.close();}
});
it.each([0,1,2])("import confirmation forwards operationId and suppresses full replay invalidation (replayed=%s)",async replayedRows=>{
  const app=await appFor(importRoutes);
  try{const operationId="50000000-0000-4000-8000-000000000001";(importOrdersFromCsv as jest.Mock).mockResolvedValue({count:2,orders:[{id:"one"},{id:"two"}],replayedRows,downstreamRecoveryRequired:replayedRows>0});
    const response=await app.inject({method:"POST",url:"/import/confirm",payload:{csvText:"synthetic csv",operationId}});expect(response.statusCode).toBe(201);expect(response.json()).toMatchObject({success:true,count:2,replayedRows,downstreamRecoveryRequired:replayedRows>0});expect(importOrdersFromCsv).toHaveBeenCalledWith({actor:user,csvText:"synthetic csv",customerEntityId:null,operationId});expect(emitMutationInvalidation).toHaveBeenCalledTimes(replayedRows===2?0:1);
  }finally{await app.close();}
});

it.each([true,false])("only explicit receipt identity conflict is returned as a conflict code (identity=%s)", async identity => {
 const app=await appFor(importRoutes);
 try { (importOrdersFromCsv as jest.Mock).mockRejectedValue(Object.assign(new Error(identity ? "Operation identity conflict" : "Operational state rejected"),{statusCode:409,...(identity ? {code:"ORDER_CREATION_IDENTITY_CONFLICT"}: {})}));
 const response=await app.inject({method:"POST",url:"/import/confirm",payload:{csvText:"synthetic",operationId:"50000000-0000-4000-8000-000000000001"}});
 expect(response.statusCode).toBe(409); expect(response.json().code).toBe(identity ? "ORDER_CREATION_IDENTITY_CONFLICT" : undefined); expect(emitMutationInvalidation).not.toHaveBeenCalled();
 } finally {await app.close();}
});
it("receipt status HTTP read uses the authenticated actor and performs no mutation invalidation", async()=>{
 const read=require("../../src/modules/orders-core/read/import-receipt-status").readImportReceiptStatus;read.mockResolvedValue({rows:[]});const app=await appFor(importRoutes);
 try {const operationId="50000000-0000-4000-8000-000000000001";const response=await app.inject({url:"/import/"+operationId+"/status"});expect(response.statusCode).toBe(200);expect(response.headers["cache-control"]).toBe("no-store");expect(read).toHaveBeenCalledWith(user,operationId);expect(importOrdersFromCsv).not.toHaveBeenCalled();expect(emitMutationInvalidation).not.toHaveBeenCalled();}finally{await app.close();}
});
