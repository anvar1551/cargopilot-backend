import { FastifyReply, FastifyRequest } from "fastify";
import { authorize } from "../modules/identity-access";
import { resolveAuthenticatedUserFromAuthHeader } from "./auth";

declare module "fastify" {
  interface FastifyRequest {
    user?: Express.User;
  }
}

type AuthOptions = {
  permission?: string;
};

export function fastifyAuth(options: AuthOptions = {}) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const user = await resolveAuthenticatedUserFromAuthHeader(
      typeof request.headers.authorization === "string"
        ? request.headers.authorization
        : undefined,
    );
    if (!user) {
      return reply.code(401).send({ error: "Unauthorized" });
    }
    request.user = user;

    if (options.permission) {
      try {
        await authorize(user, options.permission);
      } catch (err: any) {
        return reply
          .code(err?.statusCode ?? 403)
          .send({ error: err?.message ?? "Forbidden" });
      }
    }
  };
}

