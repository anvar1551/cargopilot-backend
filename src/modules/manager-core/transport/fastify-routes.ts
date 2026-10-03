import { FastifyPluginAsync } from "fastify";
import { ZodError } from "zod";
import { requireAnalyticsScope } from "../../analytics-core/application/analyticsScope";
import { fastifyAuth } from "../../../modules/identity-access/transport/fastify-auth";
import { getManagerOverviewPayload, listDriversPayload } from "../application/managerController";

const managerFastifyRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get(
    "/overview",
    { preHandler: fastifyAuth({ permission: "shipment.view" }) },
    async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      try {
        if (!request.user) return reply.code(401).send({ error: "Authentication required" });
        const result = await getManagerOverviewPayload({
          actor: request.user,
        });

        reply.header("X-Overview-Cache", result.cache);
        return reply.send(result.payload);
      } catch (err: any) {
        return reply.code([401, 403].includes(err?.statusCode) ? err.statusCode : 500).send({ error: "Selected overview unavailable" });
      }
    },
  );

  fastify.get(
    "/ops/metrics",
    { preHandler: fastifyAuth({ permission: "shipment.view" }) },
    async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      try {
        if (!request.user) return reply.code(401).send({ error: "Authentication required" });
        await requireAnalyticsScope(request.user);
        return reply.code(409).send({ error: "Platform operational metrics are unavailable through tenant APIs", code: "PLATFORM_METRICS_UNAVAILABLE" });
      } catch (error: any) {
        return reply.code([401, 403].includes(error?.statusCode) ? error.statusCode : 500).send({ error: "Operational metrics unavailable" });
      }
    },
  );

  fastify.get(
    "/drivers",
    { preHandler: fastifyAuth({ permission: "drivers.read" }) },
    async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      try {
        if (!request.user) return reply.code(401).send({ error: "Authentication required" });
        const result = await listDriversPayload({
          actor: request.user,
          query: request.query,
        });

        reply.header("X-Drivers-Cache", result.cache);
        return reply.send(result.payload);
      } catch (err: any) {
        return reply.code(err instanceof ZodError ? 400 : [401, 403, 404].includes(err?.statusCode) ? err.statusCode : 500).send({ error: "Selected driver directory unavailable" });
      }
    },
  );
};

export default managerFastifyRoutes;

