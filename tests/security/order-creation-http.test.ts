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
