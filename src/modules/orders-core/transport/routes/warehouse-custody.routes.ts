import type { FastifyPluginAsync } from "fastify";
import { fastifyAuth } from "../../../identity-access/transport/fastify-auth";
import { executeWarehouseCustody, readWarehouseCustody } from "../../operations/warehouse-custody";
import { sendError, emitMutationInvalidation } from "../shared";
import prisma from "../../../../config/prismaClient";
import { emitPersistedDriverNotification } from "../../../realtime-core/realtimeHub";
import { listCustodyWork } from "../../read/custody-work";

const routes: FastifyPluginAsync = async fastify => {
  fastify.get("/custody-work", { preHandler: fastifyAuth() }, async (request, reply) => {
    try { return await listCustodyWork(request.user!, request.query); } catch (error) { return sendError(reply, error); }
  });
  fastify.get<{Params:{id:string}}>("/:id/custody", {preHandler:fastifyAuth()}, async (request,reply) => {
    try{return await readWarehouseCustody(request.user!,request.params.id);}catch(error){return sendError(reply,error);}
  });
  fastify.post<{Params:{id:string}}>("/:id/custody", {preHandler:fastifyAuth()}, async (request,reply) => {
    try{
      const result=await executeWarehouseCustody(request.user!,request.params.id,request.body);
      const receipt=result as {trackingId?:string};
      if(receipt.trackingId){
        const notification=await prisma.userNotification.findFirst({where:{dispatchTrackingId:receipt.trackingId,orderId:request.params.id,
          tenantId:request.user!.tenantId!,companyId:request.user!.companyId!},select:{id:true}});
        if(notification) void emitPersistedDriverNotification(notification.id).catch(()=>undefined);
      }
      await emitMutationInvalidation("order_mutation");
      return result;
    }catch(error){return sendError(reply,error);}
  });
};
export default routes;
