import type { FastifyInstance } from "fastify";
import { ZodError } from "zod";
import { fastifyAuth } from "../../identity-access/transport/fastify-auth";
import { proposeBillingPolicy, decideBillingPolicy, readBillingPolicy } from "../repo/billing-policy";
import { bindOrderBillTo, acceptOrderPrice, approveOrderPrice } from "../repo/order-price";
export function billingRouteError(reply: any, error: unknown) {
  const e = error as { statusCode?: number; message?: string; code?: string };
  const status = error instanceof ZodError ? 400 : [400,403,404,409].includes(e.statusCode ?? 0) ? e.statusCode! : 500;
  return reply.code(status).send({ error: status === 500 ? "Billing operation failed" : error instanceof ZodError ? "Invalid billing request" : e.message, ...(e.code && status !== 500 ? { code: e.code } : {}) });
}
export function registerBillingPolicyRoutes(fastify: FastifyInstance) {
  for(const [path,permission,handler] of [
    ["bill-to","billing.payers.bind",bindOrderBillTo],
    ["price-acceptance","pricing.orders.accept",acceptOrderPrice],
    ["price-approval","pricing.orders.approve",approveOrderPrice],
  ] as const)fastify.post("/orders/:id/"+path,{preHandler:fastifyAuth({permission})},async(req,reply)=>{
    try{
      if(!req.body || typeof req.body!=="object" || Array.isArray(req.body) || "orderId" in req.body)throw Object.assign(new Error("Invalid billing request"),{statusCode:400});
      return reply.code(201).send(await handler(req.user!,{...req.body,orderId:(req.params as any).id}));
    }catch(e){return billingRouteError(reply,e);}
  });
  fastify.post("/billing-policies", { preHandler: fastifyAuth({ permission: "billing.policies.propose" }) }, async (req, reply) => {
    try { return reply.code(201).send(await proposeBillingPolicy(req.user!, req.body)); } catch (e) { return billingRouteError(reply,e); }
  });
  fastify.post("/billing-policies/decision", { preHandler: fastifyAuth({ permission: "billing.policies.approve" }) }, async (req, reply) => {
    try { return reply.code(201).send(await decideBillingPolicy(req.user!, req.body)); } catch (e) { return billingRouteError(reply,e); }
  });
  fastify.get("/billing-policies/:id", { preHandler: fastifyAuth({ permission: "pricing.read" }) }, async (req, reply) => {
    try { return reply.send(await readBillingPolicy(req.user!, String((req.params as any).id))); } catch (e) { return billingRouteError(reply,e); }
  });
}
