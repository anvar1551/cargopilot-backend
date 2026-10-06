import type { FastifyPluginAsync } from "fastify";
import { fastifyAuth } from "../../../identity-access/transport/fastify-auth";
import { executeRestrictedCash,readRestrictedCash } from "../../cash/restricted-cash.service";
import { sendError } from "../shared";
import { z } from "zod";
const routes:FastifyPluginAsync=async fastify=>{
 for(const [suffix,action] of [["collect","collect"],["handoff","offer"],["handoff/accept","accept"],["settle","settle"]] as const){
  fastify.post(`/:id/cash/${suffix}`,{preHandler:fastifyAuth(),bodyLimit:8192},async(req,reply)=>{
   try{if(!req.body||typeof req.body!=="object"||Array.isArray(req.body)||"orderId" in req.body)throw Object.assign(new Error("CASH_INPUT_INVALID"),{statusCode:400});
    const result=await executeRestrictedCash(req.user!,action,{...req.body,orderId:(req.params as any).id});return reply.send({success:true,order:result});
   }catch(e){return sendError(reply,e,"Cash operation rejected");}
  });
 }
 for(const action of ["collect","handoff","settle"] as const){fastify.post(`/cash/${action}-bulk`,{preHandler:fastifyAuth(),bodyLimit:65536},async(req,reply)=>{
  try{const body=z.object({items:z.array(z.record(z.string(),z.unknown())).min(1).max(100)}).strict().parse(req.body),orders=[],failed=[];
   for(const item of body.items){try{orders.push(await executeRestrictedCash(req.user!,action==="handoff"?"offer":action,item));}catch(e){failed.push({orderId:item.orderId,error:(e as {code?:string}).code??"CASH_ITEM_REJECTED"});}}
   return reply.code(failed.length?207:200).send({success:!failed.length,count:orders.length,failedCount:failed.length,orders,failed});
  }catch(e){return sendError(reply,e,"Cash batch rejected");}
 });}
 fastify.get("/cash/queue",{preHandler:fastifyAuth()},async(req,reply)=>{try{return await readRestrictedCash(req.user!,req.query);}catch(e){return sendError(reply,e,"Cash read rejected");}});
 fastify.get("/:id/cash/preflight",{preHandler:fastifyAuth()},async(req,reply)=>{try{return await readRestrictedCash(req.user!,{orderId:(req.params as any).id});}catch(e){return sendError(reply,e,"Cash read rejected");}});
 // Existing numeric/mixed-currency summary is not exposed as restricted authority.
 fastify.get("/cash/queue-summary",{preHandler:fastifyAuth()},async(_req,reply)=>reply.code(409).send({error:"CASH_EXACT_SUMMARY_UNAVAILABLE",code:"CASH_EXACT_SUMMARY_UNAVAILABLE"}));
};
export default routes;
