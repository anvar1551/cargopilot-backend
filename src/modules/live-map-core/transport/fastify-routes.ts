import type { FastifyPluginAsync } from "fastify";
import { fastifyAuth } from "../../identity-access/transport/fastify-auth";
import { getLiveMapSnapshot } from "../application/liveMapService";
import type { LiveMapViewport } from "../application/liveMap.types";

function parseViewport(raw: Record<string, unknown>): LiveMapViewport | null {
  const keys=["minLat","minLng","maxLat","maxLng"] as const;
  if(keys.every(key=>raw[key]===undefined)) return null;
  if(keys.some(key=>raw[key]===undefined || raw[key]==="")) throw Object.assign(new Error("Invalid viewport"),{statusCode:400});
  return {minLat:Number(raw.minLat),minLng:Number(raw.minLng),maxLat:Number(raw.maxLat),maxLng:Number(raw.maxLng)};
}
const liveMapFastifyRoutes:FastifyPluginAsync=async fastify=>{
  fastify.get("/snapshot",{preHandler:fastifyAuth({permission:"shipment.view"})},async(request,reply)=>{
    if(!request.user) return reply.code(401).send({error:"Unauthorized"});
    try {
      const snapshot=await getLiveMapSnapshot({actor:request.user,viewport:parseViewport((request.query??{}) as Record<string,unknown>)});
      reply.header("Cache-Control","no-store");
      return reply.send(snapshot);
    } catch(error:any) {
      const status=[400,403,404].includes(error?.statusCode)?error.statusCode:500;
      if(status===500) console.error("LIVE_MAP_SNAPSHOT_FAILED");
      reply.header("Cache-Control","no-store");
      return reply.code(status).send({error:status===400?"Invalid live map viewport":status===403?"Live map access denied":"Failed to fetch live map snapshot"});
    }
  });
  fastify.get("/stream",{preHandler:fastifyAuth({permission:"shipment.view"})},async(_request,reply)=>{
    // Current events/Redis locations lack authoritative selected ownership.
    // Deny before SSE headers, replay, subscription or Redis work.
    reply.header("Cache-Control","no-store");
    return reply.code(409).send({error:"Live driver streams are unavailable until tenant/company telemetry ownership is established"});
  });
};
export default liveMapFastifyRoutes;
