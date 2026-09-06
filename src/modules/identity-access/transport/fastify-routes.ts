import { FastifyPluginAsync, FastifyReply } from "fastify";
import { z } from "zod";
import { fastifyAuth } from "./fastify-auth";
import {
  changeUserPassword,
  deleteUserMembershipFromCompany,
  listUsersForCompany,
  loginUser,
  refreshUserSession,
  revokeRefreshSession,
  updateUserAccessByCompanyAdmin,
} from "../application/auth.service";
import {
  createRoleForCompany,
  listPermissions,
  listRolesForCompany,
} from "../application/iam.service";
import {
  AbuseRateLimiter,
  createAbuseRateLimiter,
  createAbuseRateLimitPreHandler,
  readPositiveIntegerEnv,
} from "../../../shared/http/abuseRateLimit";

function extractClientIp(request: any) {
  return typeof request.ip === "string" ? request.ip : null;
}

const PUBLIC_REGISTRATION_RESPONSE = { error: "Registration is unavailable" } as const;
const ADMIN_CREATION_RESPONSE = { error: "User creation is unavailable" } as const;
const INVALID_CREDENTIALS_RESPONSE = { error: "Invalid credentials" } as const;
const INVALID_SESSION_RESPONSE = { error: "Invalid session" } as const;

function readAuthLimit(name: string, fallback: number) {
  if (process.env[name]?.trim()) return readPositiveIntegerEnv(name, fallback);
  return readPositiveIntegerEnv("AUTH_RATE_LIMIT_MAX", fallback);
}

const refreshSchema = z.object({
  refreshToken: z.string().min(20, "Refresh token is required"),
});

const logoutSchema = z.object({
  refreshToken: z.string().min(20, "Refresh token is required"),
});

const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, "Current password is required"),
    newPassword: z.string().min(6, "New password must be at least 6 characters"),
  })
  .superRefine((value, ctx) => {
    if (value.currentPassword === value.newPassword) {
      ctx.addIssue({
        code: "custom",
        path: ["newPassword"],
        message: "New password must be different from current password",
      });
    }
  });

export type IdentityAccessRouteOptions = {
  rateLimiter?: AbuseRateLimiter;
};

const usersFastifyRoutes: FastifyPluginAsync<IdentityAccessRouteOptions> = async (
  fastify,
  options,
) => {
  const rateLimiter = options.rateLimiter ?? createAbuseRateLimiter();
  const authWindowMs = readPositiveIntegerEnv("AUTH_RATE_LIMIT_WINDOW_MS", 15 * 60 * 1_000);
  const ipLimit = (purpose: string, limit: number) => createAbuseRateLimitPreHandler({
    purpose,
    limit,
    windowMs: authWindowMs,
    limiter: rateLimiter,
    identities: (request) => [`ip:${request.ip}`],
  });
  const loginLimit = readAuthLimit("AUTH_LOGIN_RATE_LIMIT_MAX", 20);
  const refreshLimit = readAuthLimit("AUTH_REFRESH_RATE_LIMIT_MAX", 60);
  const loginRateLimit = createAbuseRateLimitPreHandler({
    purpose: "auth-login",
    limit: loginLimit,
    windowMs: authWindowMs,
    limiter: rateLimiter,
    identities: (request) => {
      const body = (request.body ?? {}) as Record<string, unknown>;
      const email = String(body.email ?? "").trim().toLowerCase() || "missing";
      return [`principal:${email}`];
    },
  });
  const refreshRateLimit = createAbuseRateLimitPreHandler({
    purpose: "auth-refresh",
    limit: refreshLimit,
    windowMs: authWindowMs,
    limiter: rateLimiter,
    identities: (request) => {
      const body = (request.body ?? {}) as Record<string, unknown>;
      const refreshToken = String(body.refreshToken ?? "").trim() || "missing";
      return [`session:${refreshToken}`];
    },
  });

  const rejectRegistration = async (_request: unknown, reply: FastifyReply) => {
    reply.header("Cache-Control", "no-store");
    return reply.code(403).send(PUBLIC_REGISTRATION_RESPONSE);
  };
  // Reject before parsing, validation, limiter storage or any enrollment service.
  fastify.post("/register", { onRequest: rejectRegistration }, rejectRegistration);

  fastify.post("/login", {
    bodyLimit: 16 * 1024,
    onRequest: ipLimit("auth-login", loginLimit),
    preHandler: loginRateLimit,
  }, async (request, reply) => {
    try {
      const body = (request.body ?? {}) as Record<string, unknown>;
      const result = await loginUser({
        email: String(body.email ?? ""),
        password: String(body.password ?? ""),
        userAgent:
          typeof request.headers["user-agent"] === "string"
            ? request.headers["user-agent"]
            : null,
        ipAddress: extractClientIp(request),
      });
      return reply.send(result);
    } catch (err: any) {
      const message = String(err?.message || "");
      if (message === "Invalid email or password" || message === "No active membership found") {
        return reply.code(401).send(INVALID_CREDENTIALS_RESPONSE);
      }
      return reply.code(500).send({ error: "Authentication failed" });
    }
  });

  fastify.post("/refresh", {
    bodyLimit: 16 * 1024,
    onRequest: ipLimit("auth-refresh", refreshLimit),
    preHandler: refreshRateLimit,
  }, async (request, reply) => {
    try {
      const dto = refreshSchema.parse(request.body ?? {});
      const result = await refreshUserSession({
        refreshToken: dto.refreshToken,
        userAgent:
          typeof request.headers["user-agent"] === "string"
            ? request.headers["user-agent"]
            : null,
        ipAddress: extractClientIp(request),
      });
      return reply.send(result);
    } catch (err: any) {
      const message = String(err?.message || "");
      if (err instanceof z.ZodError || [
        "Refresh token is required", "Invalid refresh token", "Refresh token revoked",
        "Refresh token expired", "Refresh token mismatch", "No active membership found",
      ].includes(message)) {
        return reply.code(401).send(INVALID_SESSION_RESPONSE);
      }
      return reply.code(500).send({ error: "Session refresh failed" });
    }
  });

  fastify.post("/logout", {
    bodyLimit: 16 * 1024,
    onRequest: ipLimit("auth-logout", readAuthLimit("AUTH_LOGOUT_RATE_LIMIT_MAX", 60)),
  }, async (request, reply) => {
    try {
      const dto = logoutSchema.parse(request.body ?? {});
      await revokeRefreshSession(dto.refreshToken);
      return reply.send({ ok: true });
    } catch (err: any) {
      if (err instanceof z.ZodError) return reply.code(400).send(INVALID_SESSION_RESPONSE);
      return reply.code(500).send({ error: "Logout failed" });
    }
  });

  fastify.get("/me", { preHandler: fastifyAuth() }, async (request, reply) => {
    return reply.send({ user: request.user });
  });

  fastify.post("/change-password", {
    bodyLimit: 16 * 1024,
    onRequest: ipLimit("auth-password-ip", readAuthLimit("AUTH_PASSWORD_RATE_LIMIT_MAX", 10)),
    preHandler: [fastifyAuth(), createAbuseRateLimitPreHandler({
      purpose: "auth-password-user",
      limit: readAuthLimit("AUTH_PASSWORD_RATE_LIMIT_MAX", 10),
      windowMs: authWindowMs,
      limiter: rateLimiter,
      identities: (request) => request.user?.id ? [`user:${request.user.id}`] : [],
    })],
  }, async (request, reply) => {
    try {
      if (!request.user?.id) {
        return reply.code(401).send({ error: "Unauthorized" });
      }
      const dto = changePasswordSchema.parse(request.body ?? {});
      await changeUserPassword({
        userId: request.user.id,
        currentPassword: dto.currentPassword,
        newPassword: dto.newPassword,
      });
      return reply.send({ message: "Password updated successfully" });
    } catch (err: any) {
      if (err instanceof z.ZodError) return reply.code(400).send({ error: "Invalid password change request" });
      const message = String(err?.message ?? "");
      if (message === "Unauthorized") return reply.code(401).send({ error: "Unauthorized" });
      if (message === "Current password is incorrect") return reply.code(400).send({ error: message });
      return reply.code(500).send({ error: "Failed to update password" });
    }
  });

  fastify.get(
    "/permissions",
    { preHandler: fastifyAuth({ permission: "roles.read" }) },
    async (_request, reply) => {
      const items = await listPermissions();
      return reply.send({ items });
    },
  );

  fastify.get("/roles", { preHandler: fastifyAuth({ permission: "roles.read" }) }, async (request, reply) => {
    if (!request.user?.companyId) return reply.code(400).send({ error: "companyId missing" });
    const query = (request.query ?? {}) as Record<string, unknown>;
    const includeSystem = String(query.includeSystem ?? "true").toLowerCase() !== "false";
    const items = await listRolesForCompany({
      companyId: request.user.companyId,
      includeSystem,
    });
    return reply.send({ items });
  });

  fastify.post(
    "/roles",
    { preHandler: fastifyAuth({ permission: "role.bindPermissions" }) },
    async (request, reply) => {
      try {
        if (!request.user?.companyId) {
          return reply.code(400).send({ error: "companyId missing" });
        }
        const body = (request.body ?? {}) as Record<string, unknown>;
        const role = await createRoleForCompany({
          companyId: request.user.companyId,
          code: typeof body.code === "string" ? body.code : null,
          name: String(body.name ?? ""),
          permissionKeys: Array.isArray(body.permissionKeys)
            ? body.permissionKeys.map((value) => String(value))
            : [],
          isOwnerRole: Boolean(body.isOwnerRole),
        });
        return reply.code(201).send({ role });
      } catch (err: any) {
        return reply.code(400).send({ error: err?.message ?? "Failed to create role" });
      }
    },
  );

  fastify.get(
    "/",
    { preHandler: fastifyAuth({ permission: "membership.invite" }) },
    async (request, reply) => {
      if (!request.user?.companyId) return reply.code(400).send({ error: "companyId missing" });
      const query = (request.query ?? {}) as Record<string, unknown>;
      const q = typeof query.q === "string" ? query.q : undefined;
      const page = query.page ? Number(query.page) : 1;
      const limit = query.limit ? Number(query.limit) : 20;
      const result = await listUsersForCompany({
        companyId: request.user.companyId,
        q,
        page,
        limit,
      });
      return reply.send(result);
    },
  );

  fastify.post(
    "/",
    {
      // Temporary containment applies to every caller, including membership.invite.
      // Deny before parsing or identity lookup; no creation service is reachable.
      onRequest: async (_request, reply) => {
        reply.header("Cache-Control", "no-store");
        return reply.code(403).send(ADMIN_CREATION_RESPONSE);
      },
    },
    async (_request, reply) => {
      return reply.code(403).send(ADMIN_CREATION_RESPONSE);
    },
  );

  fastify.delete(
    "/:id", { preHandler: fastifyAuth({ permission: "membership.suspend" }) },
    async (request, reply) => {
      try {
        if (!request.user?.id || !request.user?.companyId) {
          return reply.code(401).send({ error: "Unauthorized" });
        }
        const userId = typeof (request.params as any)?.id === "string" ? (request.params as any).id : "";
        const result = await deleteUserMembershipFromCompany({
          actorUserId: request.user.id,
          targetUserId: userId,
          companyId: request.user.companyId,
        });
        return reply.send({
          message: result.deleted
            ? "User deleted permanently"
            : "User access removed and active sessions revoked",
        });
      } catch (err: any) {
        return reply.code(400).send({
          error: err?.message ?? "Failed to remove user access",
        });
      }
    },
  );

  fastify.patch(
    "/:id",
    { preHandler: fastifyAuth({ permission: "membership.invite" }) },
    async (request, reply) => {
      try {
        if (!request.user?.companyId) {
          return reply.code(400).send({ error: "companyId missing" });
        }
        const userId = typeof (request.params as any)?.id === "string" ? (request.params as any).id : "";
        const body = (request.body ?? {}) as Record<string, unknown>;
        const user = await updateUserAccessByCompanyAdmin({
          companyId: request.user.companyId,
          userId,
          name: body.name === undefined ? undefined : String(body.name),
          email: body.email === undefined ? undefined : String(body.email),
          roleCodes: Array.isArray(body.roleCodes)
            ? body.roleCodes.map((value) => String(value))
            : undefined,
          branchId:
            body.branchId === undefined
              ? undefined
              : typeof body.branchId === "string"
                ? body.branchId
                : null,
          warehouseId:
            body.warehouseId === undefined
              ? undefined
              : typeof body.warehouseId === "string"
                ? body.warehouseId
                : null,
          customerEntityId:
            body.customerEntityId === undefined
              ? undefined
              : typeof body.customerEntityId === "string"
                ? body.customerEntityId
                : null,
          driverType:
            body.driverType === undefined
              ? undefined
              : body.driverType === "local" || body.driverType === "linehaul"
                ? body.driverType
                : null,
          scopes: body.scopes,
        });
        return reply.send({ user });
      } catch (err: any) {
        return reply.code(400).send({ error: err?.message ?? "Failed to update user access" });
      }
    },
  );
};

export default usersFastifyRoutes;


