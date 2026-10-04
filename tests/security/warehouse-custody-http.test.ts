jest.mock("../../src/config/prismaClient",()=>({__esModule:true,default:{userNotification:{findFirst:jest.fn()}}}));
jest.mock("../../src/modules/orders-core/operations/warehouse-custody",()=>({executeWarehouseCustody:jest.fn(),readWarehouseCustody:jest.fn()}));
jest.mock("../../src/modules/orders-core/read/custody-work",()=>({listCustodyWork:jest.fn()}));
jest.mock("../../src/modules/realtime-core/realtimeHub",()=>({emitPersistedDriverNotification:jest.fn(async()=>undefined)}));
jest.mock("../../src/modules/orders-core/transport/shared",()=>({emitMutationInvalidation:jest.fn(async()=>undefined),sendError:(reply:any,e:any)=>reply.code(e.statusCode??500).send({error:"Denied"})}));
jest.mock("../../src/modules/identity-access/transport/fastify-auth",()=>({fastifyAuth:()=>async(req:any,reply:any)=>{
  if(!req.headers["x-synthetic-auth"])return reply.code(401).send({error:"Unauthorized"});req.user={id:"synthetic-user",tenantId:"synthetic-tenant",companyId:"synthetic-company",companyMembershipId:"synthetic-member"};
}}));
import Fastify from "fastify";
import routes from "../../src/modules/orders-core/transport/routes/warehouse-custody.routes";
import prisma from "../../src/config/prismaClient";
import {executeWarehouseCustody,readWarehouseCustody} from "../../src/modules/orders-core/operations/warehouse-custody";
import {emitPersistedDriverNotification} from "../../src/modules/realtime-core/realtimeHub";
import {emitMutationInvalidation} from "../../src/modules/orders-core/transport/shared";
import {listCustodyWork} from "../../src/modules/orders-core/read/custody-work";
const headers={"x-synthetic-auth":"yes"};
beforeEach(()=>{jest.clearAllMocks();(prisma.userNotification.findFirst as jest.Mock).mockResolvedValue({id:"owned-notification"});
  (executeWarehouseCustody as jest.Mock).mockResolvedValue({eventId:"original-event",trackingId:"owned-tracking",phase:"delivered"});
  (readWarehouseCustody as jest.Mock).mockResolvedValue({custody:{id:"owned-event"}});
});
async function app(){const a=Fastify();await a.register(routes,{prefix:"/api/orders"});return a;}
it("authenticates work discovery and forwards selected context/page without effects",async()=>{const a=await app();try{
  expect((await a.inject({method:"GET",url:"/api/orders/custody-work?kind=warehouse"})).statusCode).toBe(401);
  expect(listCustodyWork).not.toHaveBeenCalled();
  (listCustodyWork as jest.Mock).mockResolvedValue({items:[],nextCursor:null});
  expect((await a.inject({method:"GET",url:"/api/orders/custody-work?kind=driver&limit=2&cursor=original",headers})).json()).toEqual({items:[],nextCursor:null});
  expect(listCustodyWork).toHaveBeenCalledWith(expect.objectContaining({companyMembershipId:"synthetic-member"}),{kind:"driver",limit:"2",cursor:"original"});
  expect(prisma.userNotification.findFirst).not.toHaveBeenCalled();expect(emitPersistedDriverNotification).not.toHaveBeenCalled();expect(emitMutationInvalidation).not.toHaveBeenCalled();
}finally{await a.close();}});
it("work discovery denial produces no writes, realtime or invalidation",async()=>{const a=await app();try{
  (listCustodyWork as jest.Mock).mockRejectedValue(Object.assign(Error("Denied"),{statusCode:403}));
  expect((await a.inject({method:"GET",url:"/api/orders/custody-work?kind=warehouse",headers})).statusCode).toBe(403);
  expect(prisma.userNotification.findFirst).not.toHaveBeenCalled();expect(emitPersistedDriverNotification).not.toHaveBeenCalled();expect(emitMutationInvalidation).not.toHaveBeenCalled();
}finally{await a.close();}});
it("authenticates before custody write or reads",async()=>{const a=await app();try{
  expect((await a.inject({method:"POST",url:"/api/orders/owned-order/custody",payload:{}})).statusCode).toBe(401);
  expect((await a.inject({method:"GET",url:"/api/orders/owned-order/custody"})).statusCode).toBe(401);
  expect(executeWarehouseCustody).not.toHaveBeenCalled();expect(readWarehouseCustody).not.toHaveBeenCalled();
}finally{await a.close();}});
it("routes verified context and original intent; emits only existing source/context-bound notification after service confirmation",async()=>{const a=await app();try{
  const body={operationId:"immutable-operation",action:"deliver"};
  const r=await a.inject({method:"POST",url:"/api/orders/owned-order/custody",headers,payload:body});expect(r.statusCode).toBe(200);
  expect(executeWarehouseCustody).toHaveBeenCalledWith(expect.objectContaining({tenantId:"synthetic-tenant",companyId:"synthetic-company"}),"owned-order",body);
  expect(prisma.userNotification.findFirst).toHaveBeenCalledWith({where:{dispatchTrackingId:"owned-tracking",orderId:"owned-order",tenantId:"synthetic-tenant",companyId:"synthetic-company"},select:{id:true}});
  expect(emitPersistedDriverNotification).toHaveBeenCalledWith("owned-notification");
  expect((executeWarehouseCustody as jest.Mock).mock.invocationCallOrder[0]).toBeLessThan((prisma.userNotification.findFirst as jest.Mock).mock.invocationCallOrder[0]);
}finally{await a.close();}});
it("denial creates no notification read, emission or invalidation",async()=>{const a=await app();try{
  (executeWarehouseCustody as jest.Mock).mockRejectedValue(Object.assign(Error("Denied"),{statusCode:403}));
  expect((await a.inject({method:"POST",url:"/api/orders/owned-order/custody",headers,payload:{}})).statusCode).toBe(403);
  expect(prisma.userNotification.findFirst).not.toHaveBeenCalled();expect(emitPersistedDriverNotification).not.toHaveBeenCalled();expect(emitMutationInvalidation).not.toHaveBeenCalled();
}finally{await a.close();}});
it("missing recipient suppresses delivery without a global fallback",async()=>{const a=await app();try{
  (prisma.userNotification.findFirst as jest.Mock).mockResolvedValue(null);
  expect((await a.inject({method:"POST",url:"/api/orders/owned-order/custody",headers,payload:{}})).statusCode).toBe(200);
  expect(emitPersistedDriverNotification).not.toHaveBeenCalled();
}finally{await a.close();}});
it("snapshot reads use the same verified context and cause no delivery",async()=>{const a=await app();try{
  expect((await a.inject({method:"GET",url:"/api/orders/owned-order/custody",headers})).json()).toEqual({custody:{id:"owned-event"}});
  expect(readWarehouseCustody).toHaveBeenCalledWith(expect.objectContaining({companyMembershipId:"synthetic-member"}),"owned-order");
  expect(prisma.userNotification.findFirst).not.toHaveBeenCalled();expect(emitPersistedDriverNotification).not.toHaveBeenCalled();
}finally{await a.close();}});
