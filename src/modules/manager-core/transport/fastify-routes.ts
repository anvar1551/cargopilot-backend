import { FastifyPluginAsync } from "fastify";
import { fastifyAuth } from "../../../middleware/authFastify";
import { getOpsMetricsSnapshot } from "../../../features/observability/opsMetrics";
import { getManagerOverviewPayload, listDriversPayload } from "../application/managerController";

const managerFastifyRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get(
    "/overview",
    { preHandler: fastifyAuth({ permission: "orders.read" }) },
    async (request, reply) => {
      try {
        const result = await getManagerOverviewPayload({
          actor: {
            id: request.user?.id ?? null,
            role: request.user?.role ?? null,
            warehouseId: request.user?.warehouseId ?? null,
          },
        });

        reply.header("X-Overview-Cache", result.cache);
        reply.header("Cache-Control", `private, max-age=${Math.floor(result.ttlMs / 1000)}`);
        return reply.send(result.payload);
      } catch (err: any) {
        return reply.code(500).send({ error: err?.message || "Failed to load overview" });
      }
    },
  );

  fastify.get(
    "/ops/metrics",
    { preHandler: fastifyAuth({ permission: "orders.read" }) },
    async (_request, reply) => {
      try {
        const snapshot = getOpsMetricsSnapshot();
        return reply.send(snapshot);
      } catch (err: any) {
        return reply.code(500).send({ error: err?.message || "Failed to load ops metrics" });
      }
    },
  );

  fastify.get(
    "/drivers",
    { preHandler: fastifyAuth({ permission: "drivers.read" }) },
    async (request, reply) => {
      try {
        const result = await listDriversPayload({
          actor: {
            id: request.user?.id ?? null,
            role: request.user?.role ?? null,
            warehouseId: request.user?.warehouseId ?? null,
          },
        });

        reply.header("X-Drivers-Cache", result.cache);
        reply.header("Cache-Control", `private, max-age=${Math.floor(result.ttlMs / 1000)}`);
        return reply.send(result.payload);
      } catch (err: any) {
        return reply.code(500).send({ error: err?.message || "Failed to load drivers" });
      }
    },
  );
};

export default managerFastifyRoutes;
