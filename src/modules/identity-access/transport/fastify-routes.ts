import { proposeCashCapabilityGrant, acceptCashCapabilityGrant, revokeCashCapabilityGrant } from "../application/cash-capability-delegation";
import { createCompanyDriverInvitation, acceptCompanyDriverInvitation, cancelCompanyDriverInvitation, mutateCompanyDriverEligibility, readDriverDelegation, listDriverInvitations, listDriverEligibility } from "../application/driver-delegation";
import { readFinancialAccess } from "../application/financial-discovery";
import { proposeFinancialGrant, acceptFinancialGrant, revokeFinancialGrant } from "../application/financial-delegation";
import { proposeIssuingEntity, decideIssuingEntity, readIssuingEntityProposal, readIssuingEntitySetup } from "../application/issuing-entity-setup";
import { recordAuthRejection, AuthRejectionCode } from "./auth-rejection-diagnostics";
import { ADMINISTRATIVE_CONTAINMENT } from "../application/managementAccess";
import prisma from "../../../config/prismaClient";
import { createCompanyInvitation, acceptCompanyInvitation, cancelCompanyInvitation, mutateCompanyOperationalGrant,
  readOperationalDelegation, listOperationalWarehouses, listCompanyInvitations, listOperationalGrants } from "../application/company-delegation";
import { FastifyPluginAsync, FastifyReply } from "fastify";
import { z } from "zod";
import { fastifyAuth } from "./fastify-auth";
import {
  changeUserPassword,
  listUsersForCompany,
  InvalidMembershipSelectionError,
  loginUser,
  MembershipSelectionRequiredError,
  refreshUserSession,
  revokeRefreshSession,
} from "../application/auth.service";
import {
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
  const reportRejection = (code: AuthRejectionCode) => recordAuthRejection(code,
    diagnostic => console.warn(JSON.stringify(diagnostic)));
  fastify.addHook("onError", async (_request, _reply, error) => {
    if (["FST_ERR_CTP_INVALID_JSON_BODY", "FST_ERR_CTP_EMPTY_JSON_BODY", "FST_ERR_CTP_INVALID_MEDIA_TYPE", "FST_ERR_CTP_BODY_TOO_LARGE"].includes(error.code ?? ""))
      reportRejection("AUTH_INPUT_REJECTED");
  });
  const observedAuthLimit = (policy: Parameters<typeof createAbuseRateLimitPreHandler>[0]) => {
    const hook = createAbuseRateLimitPreHandler(policy);
    return async (request: Parameters<typeof hook>[0], reply: Parameters<typeof hook>[1]) => {
      const result = await hook(request, reply);
      if (reply.statusCode === 429) reportRejection("AUTH_ADMISSION_LIMITED");
      else if (reply.statusCode === 503) reportRejection("AUTH_ADMISSION_UNAVAILABLE");
      return result;
    };
  };
  const rateLimiter = options.rateLimiter ?? createAbuseRateLimiter();
  const authWindowMs = readPositiveIntegerEnv("AUTH_RATE_LIMIT_WINDOW_MS", 15 * 60 * 1_000);
  const ipLimit = (purpose: string, limit: number) => observedAuthLimit({
    purpose,
    limit,
    windowMs: authWindowMs,
    limiter: rateLimiter,
    identities: (request) => [`ip:${request.ip}`],
  });
  const loginLimit = readAuthLimit("AUTH_LOGIN_RATE_LIMIT_MAX", 20);
  const refreshLimit = readAuthLimit("AUTH_REFRESH_RATE_LIMIT_MAX", 60);
  const loginRateLimit = observedAuthLimit({
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
  const refreshRateLimit = observedAuthLimit({
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
        companyMembershipId: body.companyMembershipId == null ? null : String(body.companyMembershipId),
        membershipId: body.membershipId == null ? null : String(body.membershipId),
        userAgent:
          typeof request.headers["user-agent"] === "string"
            ? request.headers["user-agent"]
            : null,
        ipAddress: extractClientIp(request),
      });
      return reply.send(result);
    } catch (err: any) {
      const message = String(err?.message || "");
      reply.header("Cache-Control", "no-store");
      if (err instanceof MembershipSelectionRequiredError) {
        return reply.code(409).send({
          error: "Membership selection required",
          code: err.code,
          memberships: err.memberships,
        });
      }
      if (err instanceof InvalidMembershipSelectionError) {
        reportRejection("LOGIN_SELECTION_REJECTED");
        return reply.code(403).send({ error: err.message, code: err.code });
      }
      if (message === "Invalid email or password" || message === "No active tenant membership found") {
        reportRejection("LOGIN_CREDENTIALS_REJECTED");
        return reply.code(401).send(INVALID_CREDENTIALS_RESPONSE);
      }
      reportRejection("LOGIN_UNAVAILABLE");
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
        "Refresh token expired", "Refresh token mismatch", "Refresh token context mismatch",
        "Refresh session requires fresh login", "Refresh membership is no longer eligible",
      ].includes(message)) {
        reportRejection("REFRESH_REJECTED");
        return reply.code(401).send(INVALID_SESSION_RESPONSE);
      }
      reportRejection("REFRESH_UNAVAILABLE");
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
      if (err instanceof z.ZodError) {
        reportRejection("LOGOUT_INPUT_REJECTED");
        return reply.code(400).send(INVALID_SESSION_RESPONSE);
      }
      reportRejection("LOGOUT_UNAVAILABLE");
      return reply.code(500).send({ error: "Logout failed" });
    }
  });

  fastify.get("/me", { preHandler: fastifyAuth() }, async (request, reply) => {
    return reply.send({ user: request.user });
  });

  fastify.post("/change-password", {
    bodyLimit: 16 * 1024,
    onRequest: ipLimit("auth-password-ip", readAuthLimit("AUTH_PASSWORD_RATE_LIMIT_MAX", 10)),
    preHandler: [fastifyAuth(), observedAuthLimit({
      purpose: "auth-password-user",
      limit: readAuthLimit("AUTH_PASSWORD_RATE_LIMIT_MAX", 10),
      windowMs: authWindowMs,
      limiter: rateLimiter,
      identities: (request) => request.user?.id ? [`user:${request.user.id}`] : [],
    })],
  }, async (request, reply) => {
    try {
      if (!request.user?.id) {
        reportRejection("PASSWORD_CHANGE_REJECTED");
        return reply.code(401).send({ error: "Unauthorized" });
      }
      const dto = changePasswordSchema.parse(request.body ?? {});
      await changeUserPassword({
        actor: request.user,
        currentPassword: dto.currentPassword,
        newPassword: dto.newPassword,
      });
      return reply.send({ message: "Password updated successfully" });
    } catch (err: any) {
      if (err instanceof z.ZodError) {
        reportRejection("PASSWORD_CHANGE_REJECTED");
        return reply.code(400).send({ error: "Invalid password change request" });
      }
      const message = String(err?.message ?? "");
      if (message === "Unauthorized") {
        reportRejection("PASSWORD_CHANGE_REJECTED");
        return reply.code(401).send({ error: "Unauthorized" });
      }
      if (message === "Current password is incorrect") {
        reportRejection("PASSWORD_CHANGE_REJECTED");
        return reply.code(400).send({ error: message });
      }
      reportRejection("PASSWORD_CHANGE_UNAVAILABLE");
      return reply.code(500).send({ error: "Failed to update password" });
    }
  });

  fastify.get(
    "/permissions",
    { preHandler: fastifyAuth({ permission: "roles.read" }) },
    async (request, reply) => {
      try { return reply.send({ items: await listPermissions(request.user!) }); }
      catch (error: any) { return reply.code(error.statusCode ?? 500).send({ error: error.statusCode === 403 ? "Forbidden" : "Failed to load permissions" }); }
    },
  );

  fastify.get("/roles", { preHandler: fastifyAuth({ permission: "roles.read" }) }, async (request, reply) => {
    try { return reply.send({ items: await listRolesForCompany({ actor: request.user! }) }); }
    catch (error: any) { return reply.code(error.statusCode ?? 500).send({ error: error.statusCode === 403 ? "Forbidden" : "Failed to load roles" }); }
  });

  fastify.get(
    "/",
    { preHandler: fastifyAuth({ permission: "membership.invite" }) },
    async (request, reply) => {
      if (!request.user?.companyId) return reply.code(400).send({ error: "companyId missing" });
      const query = (request.query ?? {}) as Record<string, unknown>;
      const q = typeof query.q === "string" ? query.q : undefined;
      const page = query.page ? Number(query.page) : 1;
      const limit = query.limit ? Number(query.limit) : 20;
      try { const result = await listUsersForCompany({
        actor: request.user!,
        q,
        page,
        limit,
      });
      return reply.send(result); } catch(error: any) { return reply.code(error.statusCode ?? 500).send({ error: error.statusCode === 403 ? "Forbidden" : "Failed to load users" }); }
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

  // Legacy arbitrary mutation contracts stay denied; approved profiles use explicit routes.
  const rejectAccessChange = async (_request: unknown, reply: FastifyReply) => {
    reply.header("Cache-Control", "no-store");
    return reply.code(403).send({ error: ADMINISTRATIVE_CONTAINMENT, code: "DELEGATION_POLICY_REQUIRED" });
  };
  fastify.post("/roles", { onRequest: rejectAccessChange }, rejectAccessChange);
  fastify.patch("/:id", { onRequest: rejectAccessChange }, rejectAccessChange);
  fastify.delete("/:id", { onRequest: rejectAccessChange }, rejectAccessChange);

  const delegationError = (reply: FastifyReply, error: unknown) => {
    const e = error as { statusCode?: number; code?: string };
    const code = typeof e?.code === "string" && /^(DELEGATION_|INVITATION_|FINANCIAL_|ENTITY_SETUP_)[A-Z_]+$/.test(e.code) ? e.code : "DELEGATION_REQUEST_REJECTED";
    if (e?.statusCode === 404 && code === "ENTITY_SETUP_PROPOSAL_NOT_FOUND") return reply.code(404).send({ error: code, code });
    return reply.code([400, 401, 403, 409].includes(e?.statusCode ?? 0) ? e.statusCode! : error instanceof z.ZodError ? 400 : 500).send({ error: code, code });
  };
  const privateReply = async (_request: unknown, reply: FastifyReply) => { reply.header("Cache-Control", "no-store"); };
  fastify.get("/company-invitations", { onRequest: privateReply, preHandler: fastifyAuth({ permission: "membership.invite" }) }, async (request, reply) => {
    try { return await listCompanyInvitations(prisma, request.user!, request.query); } catch(e) { return delegationError(reply,e); }
  });
  fastify.get("/company-operational-delegation", { onRequest: privateReply, preHandler: fastifyAuth({ permission: "membership.delegateOperational" }) }, async (request, reply) => {
    try { return await readOperationalDelegation(prisma, request.user!); } catch(e) { return delegationError(reply,e); }
  });
  fastify.get("/company-operational-delegation/warehouses", { onRequest: privateReply, preHandler: fastifyAuth({ permission: "membership.delegateOperational" }) }, async (request, reply) => {
    try { return await listOperationalWarehouses(prisma, request.user!, request.query); } catch(e) { return delegationError(reply,e); }
  });
  fastify.get("/company-operational-grants", { onRequest: privateReply, preHandler: fastifyAuth({ permission: "membership.delegateOperational" }) }, async (request, reply) => {
    try { return await listOperationalGrants(prisma, request.user!, request.query); } catch(e) { return delegationError(reply,e); }
  });
  fastify.get("/issuing-entity-setup", { onRequest: privateReply, preHandler: fastifyAuth() },async(request,reply)=>{
    try{return reply.send(await readIssuingEntitySetup(prisma,request.user!,request.query));}catch(e){return delegationError(reply,e);}
  });
  fastify.post("/issuing-entity-setup/proposals", { onRequest: privateReply, preHandler: fastifyAuth({permission:"finance.entitySetup.propose"}), bodyLimit:4096 },async(request,reply)=>{
    try{return reply.code(201).send(await proposeIssuingEntity(prisma,request.user!,request.body));}catch(e){return delegationError(reply,e);}
  });
  fastify.get("/issuing-entity-setup/proposals/:proposalId", { onRequest: privateReply, preHandler: fastifyAuth() },async(request,reply)=>{
    try{return reply.send(await readIssuingEntityProposal(prisma,request.user!,(request.params as {proposalId:string}).proposalId));}catch(e){return delegationError(reply,e);}
  });
  fastify.post("/issuing-entity-setup/decisions", { onRequest: privateReply, preHandler: fastifyAuth({permission:"finance.entitySetup.approve"}), bodyLimit:4096 },async(request,reply)=>{
    try{return reply.code(201).send(await decideIssuingEntity(prisma,request.user!,request.body));}catch(e){return delegationError(reply,e);}
  });
  fastify.post("/company-cash-capabilities/proposals",{onRequest:privateReply,preHandler:fastifyAuth({permission:"membership.proposeCashCapability"}),bodyLimit:8192},async(req,reply)=>{
    try{return reply.code(201).send(await proposeCashCapabilityGrant(prisma,req.user!,req.body));}catch(e){return delegationError(reply,e);}
  });
  fastify.post("/company-cash-capabilities/accept",{onRequest:privateReply,preHandler:fastifyAuth({permission:"membership.approveCashCapability"}),bodyLimit:8192},async(req,reply)=>{
    try{return reply.code(201).send(await acceptCashCapabilityGrant(prisma,req.user!,req.body));}catch(e){return delegationError(reply,e);}
  });
  fastify.post("/company-cash-capabilities/revoke",{onRequest:privateReply,preHandler:fastifyAuth(),bodyLimit:8192},async(req,reply)=>{
    try{return reply.send(await revokeCashCapabilityGrant(prisma,req.user!,req.body));}catch(e){return delegationError(reply,e);}
  });
  fastify.get("/company-financial-access", {onRequest:privateReply,preHandler:fastifyAuth()},async(request,reply)=>{
    try{return await readFinancialAccess(prisma,request.user!,request.query);}catch(e){return delegationError(reply,e);}
  });
  fastify.post("/company-financial-grants/proposals", { onRequest: privateReply, preHandler: fastifyAuth({permission:"membership.proposeFinancial"}), bodyLimit:8192 },async(request,reply)=>{
    try{return reply.code(201).send(await proposeFinancialGrant(prisma,request.user!,request.body));}catch(e){return delegationError(reply,e);}
  });
  fastify.post("/company-financial-grants/accept", { onRequest: privateReply, preHandler: fastifyAuth({permission:"membership.approveFinancial"}), bodyLimit:8192 },async(request,reply)=>{
    try{return reply.code(201).send(await acceptFinancialGrant(prisma,request.user!,request.body));}catch(e){return delegationError(reply,e);}
  });
  fastify.post("/company-financial-grants/revoke", { onRequest: privateReply, preHandler: fastifyAuth(), bodyLimit:8192 },async(request,reply)=>{
    try{return await revokeFinancialGrant(prisma,request.user!,request.body);}catch(e){return delegationError(reply,e);}
  });
  fastify.post("/company-invitations", { onRequest: privateReply, preHandler: fastifyAuth({ permission: "membership.invite" }), bodyLimit: 8192 }, async (request, reply) => {
    try { return await createCompanyInvitation(prisma, request.user!, request.body); } catch (e) { return delegationError(reply, e); }
  });
  fastify.post("/company-invitations/cancel", { onRequest: privateReply, preHandler: fastifyAuth({ permission: "membership.invite" }), bodyLimit: 8192 }, async (request, reply) => {
    try { return await cancelCompanyInvitation(prisma, request.user!, request.body); } catch (e) { return delegationError(reply, e); }
  });
  fastify.post("/company-operational-grants", { onRequest: privateReply, preHandler: fastifyAuth({ permission: "membership.delegateOperational" }), bodyLimit: 8192 }, async (request, reply) => {
    try { return await mutateCompanyOperationalGrant(prisma, request.user!, request.body); } catch (e) { return delegationError(reply, e); }
  });
  fastify.post("/company-invitations/accept", { onRequest: privateReply, preHandler: ipLimit("invitation-accept", 10), bodyLimit: 8192 }, async (request, reply) => {
    const header = request.headers.authorization;
    const token = header?.startsWith("Bearer ") ? header.slice(7) : undefined;
    if (header && !token) return reply.code(401).send({ error: "INVITATION_IDENTITY_REQUIRED" });
    try { return await acceptCompanyInvitation(prisma, request.body, token); } catch (e) { return delegationError(reply, e); }
  });
  fastify.get("/company-driver-delegation", { onRequest: privateReply, preHandler: fastifyAuth({permission:"membership.delegateDrivers"}) },async(request,reply)=>{
    try{return await readDriverDelegation(prisma,request.user!);}catch(e){return delegationError(reply,e);}
  });
  fastify.get("/company-driver-invitations", { onRequest: privateReply, preHandler: fastifyAuth({permission:"membership.invite"}) },async(request,reply)=>{
    try{return await listDriverInvitations(prisma,request.user!,request.query);}catch(e){return delegationError(reply,e);}
  });
  fastify.get("/company-driver-grants", { onRequest: privateReply, preHandler: fastifyAuth({permission:"membership.delegateDrivers"}) },async(request,reply)=>{
    try{return await listDriverEligibility(prisma,request.user!,request.query);}catch(e){return delegationError(reply,e);}
  });
  fastify.post("/company-driver-invitations", { onRequest: privateReply, preHandler: fastifyAuth({ permission: "membership.invite" }), bodyLimit: 8192 }, async (request, reply) => {
    try { return await createCompanyDriverInvitation(prisma, request.user!, request.body); } catch (e) { return delegationError(reply, e); }
  });
  fastify.post("/company-driver-invitations/cancel", { onRequest: privateReply, preHandler: fastifyAuth({ permission: "membership.invite" }), bodyLimit: 8192 }, async (request, reply) => {
    try { return await cancelCompanyDriverInvitation(prisma, request.user!, request.body); } catch (e) { return delegationError(reply, e); }
  });
  fastify.post("/company-driver-grants", { onRequest: privateReply, preHandler: fastifyAuth({ permission: "membership.delegateDrivers" }), bodyLimit: 8192 }, async (request, reply) => {
    try { return await mutateCompanyDriverEligibility(prisma, request.user!, request.body); } catch (e) { return delegationError(reply, e); }
  });
  fastify.post("/company-driver-invitations/accept", { onRequest: privateReply, preHandler: ipLimit("driver-invitation-accept", 10), bodyLimit: 8192 }, async (request, reply) => {
    const header = request.headers.authorization;
    const token = header?.startsWith("Bearer ") ? header.slice(7) : undefined;
    if (header && !token) return reply.code(401).send({ error: "INVITATION_IDENTITY_REQUIRED" });
    try { return await acceptCompanyDriverInvitation(prisma, request.body, token); } catch (e) { return delegationError(reply, e); }
  });
};

export default usersFastifyRoutes;
