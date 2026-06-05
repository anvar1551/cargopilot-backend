import jwt from "jsonwebtoken";
import { FastifyReply, FastifyRequest } from "fastify";
import { authorize, loadAccessSnapshot } from "../access-control";
import { AccessTokenPayload } from "../types";

declare module "fastify" {
  interface FastifyRequest {
    user?: Express.User;
  }
}

function getBearerTokenFromHeader(header: string | undefined) {
  if (!header) return null;
  const [scheme, token] = header.split(" ");
  if (scheme !== "Bearer" || !token) return null;
  return token;
}

async function resolveAuthenticatedUserFromAuthHeader(
  authorizationHeader: string | undefined,
) {
  const token = getBearerTokenFromHeader(authorizationHeader);
  if (!token) return null;
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    const e = new Error("JWT_SECRET not configured") as Error & { statusCode: number };
    e.statusCode = 500;
    throw e;
  }

  let decoded: AccessTokenPayload;
  try {
    decoded = jwt.verify(token, secret) as AccessTokenPayload;
  } catch {
    return null;
  }
  if (!decoded?.id || !decoded?.membershipId || decoded.tokenType !== "access") {
    return null;
  }

  const snapshot = await loadAccessSnapshot({
    userId: decoded.id,
    membershipId: decoded.membershipId,
  });
  if (!snapshot) return null;

  return {
    id: snapshot.userId,
    membershipId: snapshot.membershipId,
    companyId: snapshot.companyId,
    branchId: snapshot.branchId,
    email: snapshot.email,
    name: snapshot.name,
    warehouseId: snapshot.warehouseId,
    customerEntityId: snapshot.customerEntityId,
    roleCodes: snapshot.roleCodes,
    permissionCodes: snapshot.permissionCodes,
    scopes: snapshot.scopes,
  } satisfies Express.User;
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
