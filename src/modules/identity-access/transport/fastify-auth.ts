import { recordAuthRejection } from "./auth-rejection-diagnostics";
import jwt from "jsonwebtoken";
import { FastifyReply, FastifyRequest } from "fastify";
import { authorize, loadAccessSnapshot } from "../access-control";
import { AccessTokenPayload } from "../types";
import type { AppUser } from "../../../types/app-user";
import { hasLiveAccessSession, isBoundAccessSession } from "../application/access-session";

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
  if (!isBoundAccessSession(decoded)) {
    return null;
  }
  try { if (!await hasLiveAccessSession(decoded)) return null; } catch { return null; }

  const snapshot = await loadAccessSnapshot({
    userId: decoded.id,
    membershipId: decoded.membershipId,
    companyMembershipId: decoded.companyMembershipId,
    companyId: decoded.companyId,
    tenantId: decoded.tenantId,
    tenantMembershipId: decoded.tenantMembershipId,
    requireFresh: true,
  });
  if (!snapshot) return null;

  return {
    id: snapshot.userId,
    membershipId: snapshot.membershipId,
    companyMembershipId: snapshot.companyMembershipId,
    companyId: snapshot.companyId,
    tenantId: snapshot.tenantId,
    tenantMembershipId: snapshot.tenantMembershipId,
    branchId: snapshot.branchId,
    email: snapshot.email,
    name: snapshot.name,
    warehouseId: snapshot.warehouseId,
    customerEntityId: snapshot.customerEntityId,
    roleCodes: snapshot.roleCodes,
    permissionCodes: snapshot.permissionCodes,
    scopes: snapshot.scopes,
  } satisfies AppUser;
}

type AuthOptions = {
  permission?: string;
  anyPermission?: string[];
};

function rejectAuthorityFailure(reply: FastifyReply, error: unknown) {
  const forbidden = (error as { statusCode?: unknown } | null)?.statusCode === 403;
  recordAuthRejection(forbidden ? "ACCESS_PERMISSION_REJECTED" : "ACCESS_AUTHORITY_UNAVAILABLE",
    diagnostic => console.warn(JSON.stringify(diagnostic)));
  return reply.code(forbidden ? 403 : 500).send({ error: forbidden ? "Forbidden" : "Authentication unavailable" });
}

export function fastifyAuth(options: AuthOptions = {}) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    let user: AppUser | null;
    try {
      user = await resolveAuthenticatedUserFromAuthHeader(
        typeof request.headers.authorization === "string" ? request.headers.authorization : undefined,
      );
    } catch {
      // Never pass configuration/database/verification exception details to HTTP or logs.
      return rejectAuthorityFailure(reply, null);
    }
    if (!user) {
      recordAuthRejection("ACCESS_SESSION_REJECTED", diagnostic => console.warn(JSON.stringify(diagnostic)));
      return reply.code(401).send({ error: "Unauthorized" });
    }
    request.user = user;

    if (options.permission) {
      try { await authorize(user, options.permission); }
      catch (error) { return rejectAuthorityFailure(reply, error); }
    }

    if (options.anyPermission?.length) {
      for (const permission of options.anyPermission) {
        try { await authorize(user, permission); return; }
        catch (error) {
          if ((error as { statusCode?: unknown } | null)?.statusCode !== 403)
            return rejectAuthorityFailure(reply, null);
        }
      }
      return rejectAuthorityFailure(reply, { statusCode: 403 });
    }
  };
}