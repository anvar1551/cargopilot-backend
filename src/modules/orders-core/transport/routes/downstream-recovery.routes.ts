import type { FastifyPluginAsync } from "fastify";
import { fastifyAuth } from "../../../identity-access/transport/fastify-auth";
import { requireOrderActor } from "../../shared/actor";
import { readDownstreamRecovery } from "../../read/downstream-recovery";
import { sendError } from "../shared";

const downstreamRecoveryRoutes: FastifyPluginAsync = async fastify => {
  fastify.get("/:id/downstream-recovery", { preHandler: fastifyAuth({ permission: "shipment.view" }) }, async (request, reply) => {
    try {
      return reply.send(await readDownstreamRecovery(requireOrderActor(request.user), String((request.params as any)?.id ?? ""), (request.query ?? {}) as any));
    } catch (error) { return sendError(reply, error, "Failed to read downstream state"); }
  });
};
export default downstreamRecoveryRoutes;
