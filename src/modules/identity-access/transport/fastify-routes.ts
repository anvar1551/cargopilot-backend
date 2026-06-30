import { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { fastifyAuth } from "./fastify-auth";
import {
  changeUserPassword,
  createUserByCompanyAdmin,
  deleteUserMembershipFromCompany,
  listUsersForCompany,
  loginUser,
  refreshUserSession,
  registerUser,
  revokeRefreshSession,
  updateUserAccessByCompanyAdmin,
} from "../application/auth.service";
import {
  createRoleForCompany,
  listPermissions,
  listRolesForCompany,
} from "../application/iam.service";

function extractClientIp(request: any) {
  const forwarded = request.headers?.["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) {
    return forwarded.split(",")[0]?.trim() || null;
  }
  if (Array.isArray(forwarded) && forwarded.length > 0) {
    return String(forwarded[0] ?? "").trim() || null;
  }
  return typeof request.ip === "string" ? request.ip : null;
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

const usersFastifyRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post("/register", async (request, reply) => {
    try {
      const body = (request.body ?? {}) as Record<string, unknown>;
      const result = await registerUser({
        name: String(body.name ?? ""),
        email: String(body.email ?? ""),
        password: String(body.password ?? ""),
        companyId: typeof body.companyId === "string" ? body.companyId : null,
        roleCodes: Array.isArray(body.roleCodes)
          ? body.roleCodes.map((value) => String(value))
          : undefined,
        companyName: body.companyName == null ? null : String(body.companyName),
        phone: body.phone == null ? null : String(body.phone),
        userAgent:
          typeof request.headers["user-agent"] === "string"
            ? request.headers["user-agent"]
            : null,
        ipAddress: extractClientIp(request),
      });
      return reply.code(201).send(result);
    } catch (err: any) {
      const message = err?.message ?? "Registration failed";
      return reply.code(400).send({ error: message });
    }
  });

  fastify.post("/login", async (request, reply) => {
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
      const message = err?.message || "Login failed";
      const statusCode = message.includes("Invalid email or password") ? 401 : 400;
      return reply.code(statusCode).send({ error: message });
    }
  });

  fastify.post("/refresh", async (request, reply) => {
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
      const message = err?.message ?? "Failed to refresh session";
      const statusCode = message.includes("token") ? 401 : 400;
      return reply.code(statusCode).send({ error: message });
    }
  });

  fastify.post("/logout", async (request, reply) => {
    try {
      const dto = logoutSchema.parse(request.body ?? {});
      await revokeRefreshSession(dto.refreshToken);
      return reply.send({ ok: true });
    } catch (err: any) {
      return reply.code(err instanceof z.ZodError ? 400 : 400).send({
        error: err?.message ?? "Failed to logout",
      });
    }
  });

  fastify.get("/me", { preHandler: fastifyAuth() }, async (request, reply) => {
    return reply.send({ user: request.user });
  });

  fastify.post("/change-password", { preHandler: fastifyAuth() }, async (request, reply) => {
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
      const message = err?.message ?? "Failed to update password";
      const statusCode = message === "Unauthorized" ? 401 : 400;
      return reply.code(statusCode).send({ error: message });
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
    { preHandler: fastifyAuth({ permission: "membership.invite" }) },
    async (request, reply) => {
      try {
        if (!request.user?.companyId) return reply.code(400).send({ error: "companyId missing" });
        const body = (request.body ?? {}) as Record<string, unknown>;
        const user = await createUserByCompanyAdmin({
          companyId: request.user.companyId,
          name: String(body.name ?? ""),
          email: String(body.email ?? ""),
          password: String(body.password ?? ""),
          roleCodes: Array.isArray(body.roleCodes)
            ? body.roleCodes.map((value) => String(value))
            : [],
          branchId: typeof body.branchId === "string" ? body.branchId : null,
          warehouseId: typeof body.warehouseId === "string" ? body.warehouseId : null,
          customerEntityId:
            typeof body.customerEntityId === "string" ? body.customerEntityId : null,
          driverType:
            body.driverType === "local" || body.driverType === "linehaul"
              ? body.driverType
              : null,
          scopes: body.scopes,
        });
        return reply.code(201).send({ user });
      } catch (err: any) {
        return reply.code(400).send({ error: err?.message ?? "Bad request" });
      }
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


