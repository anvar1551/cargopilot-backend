import { FastifyPluginAsync } from "fastify";
import { fastifyAuth } from "../../../identity-access/transport/fastify-auth";
import { getOrderForActor } from "../..";
import { sendError } from "../shared";

const orderDetailRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get("/:id", { preHandler: fastifyAuth({ permission: "shipment.view" }) }, async (request, reply) => {
    try {
      const actor = request.user as Express.User;
      const orderId = String((request.params as any)?.id ?? "").trim();
      const result = await getOrderForActor({ actor, orderId });
      if (result.status === 200) return reply.send(result.order);
      if (result.status === 404) return reply.code(404).send({ error: "Not found" });
      return reply.code(403).send({ error: "Forbidden" });
    } catch (err: any) {
      return sendError(reply, err, "Failed to fetch order");
    }
  });
};

export default orderDetailRoutes;
