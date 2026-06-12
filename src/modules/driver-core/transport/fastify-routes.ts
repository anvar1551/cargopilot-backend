import type { FastifyPluginAsync } from "fastify";
import { ZodError } from "zod";
import { fastifyAuth } from "../../../modules/identity-access/transport/fastify-auth";
import {
  getDriverPresence,
  heartbeatDriverPresence,
  ingestDriverLocation,
  ingestDriverTelemetry,
  setDriverPresence,
} from "../../live-map-core/application/liveMapService";
import {
  listDriversView,
  updateDriverProfileById,
} from "../application/driverProfileService";

function liveMapActorFromRequest(request: any) {
  const warehouseId = request.user?.warehouseId ?? null;
  const userId = request.user?.id as string | undefined;
  if (!userId) return null;
  return {
    userId,
    warehouseId,
    roleCodes: Array.isArray(request.user?.roleCodes) ? request.user.roleCodes : [],
    permissionCodes: Array.isArray(request.user?.permissionCodes)
      ? request.user.permissionCodes
      : [],
  };
}

function sendLiveMapActionError(reply: any, err: any, fallbackMessage: string) {
  if (err instanceof ZodError) {
    return reply.code(400).send({
      error: "Invalid payload",
      issues: err.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    });
  }
  if (typeof err?.message === "string" && err.message.includes("different driver")) {
    return reply.code(403).send({ error: err.message });
  }
  if (typeof err?.message === "string" && err.message.includes("required for manager")) {
    return reply.code(400).send({ error: err.message });
  }
  if (typeof err?.message === "string" && err.message.includes("not found")) {
    return reply.code(404).send({ error: err.message });
  }
  return reply.code(400).send({ error: err?.message || fallbackMessage });
}

const driverFastifyRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get(
    "/",
    { preHandler: fastifyAuth({ permission: "drivers.manage" }) },
    async (request, reply) => {
      try {
        const drivers = await listDriversView();
        return reply.send(drivers);
      } catch (err: any) {
        return reply.code(500).send({ error: err?.message || "Failed to fetch drivers" });
      }
    },
  );

  fastify.put(
    "/:id",
    { preHandler: fastifyAuth({ permission: "drivers.manage" }) },
    async (request, reply) => {
      try {
        const payload = await updateDriverProfileById(
          String((request.params as any)?.id || ""),
          request.body ?? {},
        );
        return reply.send(payload);
      } catch (err: any) {
        if (err instanceof ZodError) {
          return reply.code(400).send({
            error: "Invalid payload",
            issues: err.issues,
          });
        }
        return reply.code(err?.statusCode ?? 500).send({
          error: err?.message || "Failed to update driver profile",
        });
      }
    },
  );

  fastify.post(
    "/location",
    { preHandler: fastifyAuth({ anyPermission: ["drivers.telemetry", "drivers.manage"] }) },
    async (request, reply) => {
      const actor = liveMapActorFromRequest(request);
      if (!actor) return reply.code(401).send({ error: "Unauthorized" });
      try {
        const result = await ingestDriverLocation({ actor, body: request.body });
        return reply.send(result);
      } catch (err: any) {
        return sendLiveMapActionError(reply, err, "Failed to ingest driver location");
      }
    },
  );

  fastify.post(
    "/telemetry",
    { preHandler: fastifyAuth({ anyPermission: ["drivers.telemetry", "drivers.manage"] }) },
    async (request, reply) => {
      const actor = liveMapActorFromRequest(request);
      if (!actor) return reply.code(401).send({ error: "Unauthorized" });
      try {
        const result = await ingestDriverTelemetry({ actor, body: request.body });
        return reply.send(result);
      } catch (err: any) {
        return sendLiveMapActionError(reply, err, "Failed to ingest driver telemetry");
      }
    },
  );

  fastify.get(
    "/presence",
    { preHandler: fastifyAuth({ anyPermission: ["drivers.telemetry", "drivers.manage"] }) },
    async (request, reply) => {
      const actor = liveMapActorFromRequest(request);
      if (!actor) return reply.code(401).send({ error: "Unauthorized" });
      try {
        const result = await getDriverPresence({ actor, query: request.query });
        return reply.send(result);
      } catch (err: any) {
        return sendLiveMapActionError(reply, err, "Failed to fetch driver presence");
      }
    },
  );

  fastify.put(
    "/presence",
    { preHandler: fastifyAuth({ anyPermission: ["drivers.telemetry", "drivers.manage"] }) },
    async (request, reply) => {
      const actor = liveMapActorFromRequest(request);
      if (!actor) return reply.code(401).send({ error: "Unauthorized" });
      try {
        const result = await setDriverPresence({ actor, body: request.body });
        return reply.send(result);
      } catch (err: any) {
        return sendLiveMapActionError(reply, err, "Failed to update driver presence");
      }
    },
  );

  fastify.post(
    "/presence/heartbeat",
    { preHandler: fastifyAuth({ anyPermission: ["drivers.telemetry", "drivers.manage"] }) },
    async (request, reply) => {
      const actor = liveMapActorFromRequest(request);
      if (!actor) return reply.code(401).send({ error: "Unauthorized" });
      try {
        const result = await heartbeatDriverPresence({ actor, body: request.body });
        return reply.send(result);
      } catch (err: any) {
        return sendLiveMapActionError(reply, err, "Failed to heartbeat driver presence");
      }
    },
  );
};

export default driverFastifyRoutes;
