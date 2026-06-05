import { FastifyPluginAsync } from "fastify";
import { getRedisHealthSnapshot } from "../../../config/redis";
import { fastifyAuth } from "../../../modules/identity-access/transport/fastify-auth";
import { getOpsMetricsSnapshot } from "../../../modules/observability-core/application/opsMetrics";
import { getManagerOverviewPayload, listDriversPayload } from "../application/managerController";

const managerFastifyRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get(
    "/overview",
    { preHandler: fastifyAuth({ permission: "shipment.view" }) },
    async (request, reply) => {
      try {
        const result = await getManagerOverviewPayload({
          actor: {
            id: request.user?.id ?? null,
            roleCodes: Array.isArray(request.user?.roleCodes) ? request.user.roleCodes : [],
            permissionCodes: Array.isArray(request.user?.permissionCodes)
              ? request.user.permissionCodes
              : [],
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
    { preHandler: fastifyAuth({ permission: "shipment.view" }) },
    async (_request, reply) => {
      try {
        const snapshot = getOpsMetricsSnapshot();
        const redis = await getRedisHealthSnapshot();
        return reply.send({
          ...snapshot,
          redis,
        });
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
            roleCodes: Array.isArray(request.user?.roleCodes) ? request.user.roleCodes : [],
            permissionCodes: Array.isArray(request.user?.permissionCodes)
              ? request.user.permissionCodes
              : [],
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

