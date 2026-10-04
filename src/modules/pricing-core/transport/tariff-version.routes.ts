import type { FastifyInstance } from "fastify";
import { z, ZodError } from "zod";
import { fastifyAuth } from "../../identity-access/transport/fastify-auth";
import { proposeTariffVersion, decideTariffVersion, readTariffVersion } from "../repo/tariff-versions";

const proposal = z.object({ operationId: z.string().uuid(), expectedGeneration: z.number().int().min(0).max(2147483646), reason: z.string().trim().min(1).max(1000) }).strict();
const decision = z.object({ operationId: z.string().uuid(), contentSha256: z.string().regex(/^[0-9a-f]{64}$/), decision: z.enum(["approved", "rejected"]), reason: z.string().trim().min(1).max(1000) }).strict();
const params = z.object({ id: z.string().uuid(), versionId: z.string().uuid().optional() }).strict();
function error(reply: any, value: unknown) {
  if (value instanceof ZodError) return reply.code(400).send({ error: "Invalid tariff publication request" });
  const fault = value as { statusCode?: number; message?: string };
  const status = [400, 403, 404, 409].includes(fault.statusCode ?? 0) ? fault.statusCode! : 500;
  return reply.code(status).send({ error: status === 500 ? "Tariff publication failed" : fault.message });
}
export function registerTariffVersionRoutes(fastify: FastifyInstance) {
  fastify.post("/tariff-plans/:id/versions", { preHandler: fastifyAuth({ permission: "pricing.tariffs.propose" }) }, async (request, reply) => {
    try { const { id } = params.parse(request.params); return reply.code(201).send(await proposeTariffVersion({ user: request.user!, planId: id, ...proposal.parse(request.body) })); }
    catch (failure) { return error(reply, failure); }
  });
  fastify.get("/tariff-plans/:id/versions/:versionId", { preHandler: fastifyAuth({ permission: "pricing.read" }) }, async (request, reply) => {
    try { const { id, versionId } = params.parse(request.params); return reply.send(await readTariffVersion(request.user!, id, versionId!)); }
    catch (failure) { return error(reply, failure); }
  });
  fastify.post("/tariff-plans/:id/versions/:versionId/decision", { preHandler: fastifyAuth({ permission: "pricing.tariffs.approve" }) }, async (request, reply) => {
    try { const { id, versionId } = params.parse(request.params); return reply.code(201).send(await decideTariffVersion({ user: request.user!, planId: id, versionId: versionId!, ...decision.parse(request.body) })); }
    catch (failure) { return error(reply, failure); }
  });
}
