jest.mock("../../src/config/prismaClient",()=>({__esModule:true,default:require("./fixtures").database}));
jest.mock("../../src/modules/identity-access/transport/fastify-auth",()=>({fastifyAuth:()=>async()=>undefined}));
jest.mock("../../src/modules/orders-core",()=>({requireOrderActor:(user:any)=>user,assignDriversBulkForActor:jest.fn(),assignTasksBulkForActor:jest.fn(),updateStatusBulkForActor:jest.fn()}));
jest.mock("../../src/modules/orders-core/transport/shared",()=>({...jest.requireActual("../../src/modules/orders-core/transport/shared"),emitMutationInvalidation:jest.fn()}));
import Fastify from "fastify";
import routes from "../../src/modules/orders-core/transport/routes/orders.routes";
import {assignDriversBulkForActor,assignTasksBulkForActor,updateStatusBulkForActor} from "../../src/modules/orders-core";
import {emitMutationInvalidation} from "../../src/modules/orders-core/transport/shared";
const actor:any={id:"synthetic-user",tenantId:"tenant-a",companyId:"company-a",companyMembershipId:"membership-a"};
const state={orderId:"synthetic-order",updatedAt:"2026-10-03T00:00:00.000Z",status:"assigned",assignedDriverId:"synthetic-driver",currentWarehouseId:null};
const cases=[{url:"/assign-driver-bulk",handler:assignDriversBulkForActor,body:{driverId:"synthetic-driver"}},{url:"/tasks/assign-bulk",handler:assignTasksBulkForActor,body:{driverId:"synthetic-driver"}},{url:"/status-bulk",handler:updateStatusBulkForActor,body:{status:"pickup_in_progress"}}];
beforeEach(()=>jest.clearAllMocks());
async function appFor(){const app=Fastify();app.setValidatorCompiler(({schema}:any)=>(data:any)=>{const result=schema.safeParse(data);return result.success?{value:result.data}:{error:result.error};});app.addHook("onRequest",async request=>{request.user=actor;});await app.register(routes);return app;}
it.each(cases)("$url rejects absent state preconditions before mutation/invalidation",async({url,body,handler})=>{const app=await appFor();try{const result=await app.inject({method:"POST",url,payload:{...body,orderIds:[state.orderId]}});expect(result.statusCode).toBe(400);expect(handler).not.toHaveBeenCalled();expect(emitMutationInvalidation).not.toHaveBeenCalled();}finally{await app.close();}});
it.each(cases)("$url forwards exact state preconditions and retains summary envelope",async({url,body,handler})=>{const app=await appFor();const payload={...body,orderIds:[state.orderId],expectedStates:[state]};(handler as jest.Mock).mockResolvedValue({success:true,count:1,orders:[{id:state.orderId}]});try{const result=await app.inject({method:"POST",url,payload});expect(result.statusCode).toBe(200);expect(handler).toHaveBeenCalledWith({actor,body:payload,includeFull:false});expect(result.json()).toEqual({success:true,count:1,orders:[{id:state.orderId}]});}finally{await app.close();}});
