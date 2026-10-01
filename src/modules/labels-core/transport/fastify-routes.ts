import { FastifyPluginAsync } from "fastify";
import { fastifyAuth } from "../../identity-access/transport/fastify-auth";
import { getOrderLabelUrls } from "../application/labelAccess";
const labelsFastifyRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get("/orders/:id/url", { preHandler: fastifyAuth({ permission: "shipment.view" }) }, async (request, reply) => {
    try {
      return reply.send(await getOrderLabelUrls(request.user, String((request.params as any)?.id || "").trim()));
    } catch (err: any) {
      return reply.code(err?.statusCode ?? 500).send({ error: err?.message || "Failed to load label" });
    }
  });
};
export default labelsFastifyRoutes;
