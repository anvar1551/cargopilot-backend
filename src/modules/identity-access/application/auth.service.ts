import bcrypt from "bcryptjs";
import type { AppUser } from "../../../types/app-user";
import { requireIdentityManagementContext, rejectAdministrativeMutation } from "./managementAccess";
import jwt from "jsonwebtoken";
import { randomUUID, createHash } from "crypto";
import { MembershipStatus, Prisma } from "@prisma/client";
import prisma from "../../../config/prismaClient";
import { RefreshTokenPayload } from "../types";
import { lockCredentialUser } from "./credential-lock";
import { lockRefreshContext, revokeRecordedSuccessors, MAX_REFRESH_ROTATION_DEPTH, refreshLineageTransactionOptions } from "./refresh-lineage";
import { clearIdentityAccessCacheForUser, loadAccessSnapshot } from "../access-control";

// Synthetic credential, never an account: missing users still incur a password check.
const MISSING_USER_PASSWORD_HASH = bcrypt.hashSync("CargoPilot authentication timing sentinel", 10);

function getJwtSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET not configured");
  return secret;
}

function getRefreshTokenSecret() {
  return process.env.REFRESH_TOKEN_SECRET || getJwtSecret();
}

function getAccessTokenTtl() {
  return process.env.ACCESS_TOKEN_TTL || "12h";
}

function getRefreshTokenTtl() {
  return process.env.REFRESH_TOKEN_TTL || "30d";
}

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function getTokenExpiryDate(token: string) {
  const decoded = jwt.decode(token) as { exp?: number } | null;
  if (!decoded?.exp) throw new Error("Unable to read token expiry");
  return new Date(decoded.exp * 1000);
}

function getTokenLifetimeSec(token: string) {
  const decoded = jwt.decode(token) as { iat?: number; exp?: number } | null;
  if (!decoded?.exp || !decoded?.iat) return 0;
  const ttl = decoded.exp - decoded.iat;
  return ttl > 0 ? ttl : 0;
}

function signAccessToken(payload: {
  id: string;
  membershipId: string;
  companyMembershipId: string;
  companyId: string;
  tenantId: string;
  tenantMembershipId: string;
  branchId?: string | null;
}) {
  return jwt.sign(
    {
      ...payload,
      tokenType: "access",
    },
    getJwtSecret(),
    { expiresIn: getAccessTokenTtl() as jwt.SignOptions["expiresIn"] },
  );
}

function signRefreshToken(payload: RefreshTokenPayload) {
  return jwt.sign(payload, getRefreshTokenSecret(), {
    expiresIn: getRefreshTokenTtl() as jwt.SignOptions["expiresIn"],
  });
}

type TenantSessionContext = {
  userId: string;
  membershipId: string;
  companyMembershipId: string;
  companyId: string;
  tenantId: string;
  tenantMembershipId: string;
  branchId: string | null;
};

type MembershipChoice = {
  companyMembershipId: string;
  companyName: string;
  tenantName: string;
};

export class MembershipSelectionRequiredError extends Error {
  readonly code = "MEMBERSHIP_SELECTION_REQUIRED";
  constructor(readonly memberships: MembershipChoice[]) {
    super("Membership selection required");
  }
}

export class InvalidMembershipSelectionError extends Error {
  readonly code = "INVALID_MEMBERSHIP_SELECTION";
  constructor() {
    super("Invalid membership selection");
  }
}

const tenantSessionMembershipSelect = {
  id: true,
  userId: true,
  companyId: true,
  branchId: true,
  status: true,
  tenantId: true,
  tenantMembershipId: true,
  tenant: { select: { id: true, name: true, status: true } },
  tenantMembership: { select: { id: true, tenantId: true, userId: true, status: true } },
  company: { select: { id: true, name: true, tenantId: true, isActive: true } },
  branch: { select: { id: true, tenantId: true, isActive: true } },
} as const;

function toTenantSessionContext(record: any): TenantSessionContext | null {
  if (!record
    || record.status !== MembershipStatus.active
    || !record.tenantId
    || !record.tenantMembershipId
    || record.tenant?.id !== record.tenantId
    || record.tenant.status !== "active"
    || record.tenantMembership?.id !== record.tenantMembershipId
    || record.tenantMembership.status !== MembershipStatus.active
    || record.tenantMembership.userId !== record.userId
    || record.tenantMembership.tenantId !== record.tenantId
    || record.company?.id !== record.companyId
    || record.company.tenantId !== record.tenantId
    || !record.company.isActive
    || (record.branch && (record.branch.tenantId !== record.tenantId || !record.branch.isActive))) {
    return null;
  }
  return {
    userId: record.userId,
    membershipId: record.id,
    companyMembershipId: record.id,
    companyId: record.companyId,
    tenantId: record.tenantId,
    tenantMembershipId: record.tenantMembershipId,
    branchId: record.branchId ?? null,
  };
}

function toMembershipChoice(record: any, context: TenantSessionContext): MembershipChoice {
  return {
    companyMembershipId: context.companyMembershipId,
    companyName: record.company.name,
    tenantName: record.tenant.name,
  };
}

async function resolveLoginContext(userId: string, requestedMembershipId?: string | null) {
  const selector = String(requestedMembershipId ?? "").trim();
  if (selector) {
    const selected = await prisma.companyMembership.findFirst({
      where: { id: selector, userId },
      select: tenantSessionMembershipSelect,
    });
    const context = toTenantSessionContext(selected);
    if (!context) throw new InvalidMembershipSelectionError();
    return context;
  }

  const records = await prisma.companyMembership.findMany({
    where: { userId },
    select: tenantSessionMembershipSelect,
  });
  const eligible = records
    .map((record) => ({ record, context: toTenantSessionContext(record) }))
    .filter((item): item is { record: any; context: TenantSessionContext } => Boolean(item.context));
  if (eligible.length === 0) throw new Error("No active tenant membership found");
  if (eligible.length > 1) {
    const choices = eligible
      .sort((a, b) => a.context.tenantId.localeCompare(b.context.tenantId)
        || a.context.companyId.localeCompare(b.context.companyId)
        || a.context.companyMembershipId.localeCompare(b.context.companyMembershipId))
      .map(({ record, context }) => toMembershipChoice(record, context));
    throw new MembershipSelectionRequiredError(choices);
  }
  return eligible[0].context;
}

async function resolveStoredContext(userId: string, companyMembershipId: string, db: Prisma.TransactionClient | typeof prisma = prisma) {
  const selected = await db.companyMembership.findFirst({
    where: { id: companyMembershipId, userId },
    select: tenantSessionMembershipSelect,
  });
  return toTenantSessionContext(selected);
}

function sameSelectedContext(left: TenantSessionContext | null, right: TenantSessionContext) {
  return left && left.userId === right.userId && left.membershipId === right.membershipId &&
    left.companyMembershipId === right.companyMembershipId && left.companyId === right.companyId &&
    left.tenantId === right.tenantId && left.tenantMembershipId === right.tenantMembershipId;
}

async function createRefreshSession(args: TenantSessionContext & {
  predecessor?: { id: string; depth: number };
  userAgent?: string | null;
  ipAddress?: string | null;
}, tx: Prisma.TransactionClient | typeof prisma = prisma) {
  const sessionId = randomUUID();
  const refreshToken = signRefreshToken({
    id: args.userId,
    sid: sessionId,
    companyMembershipId: args.companyMembershipId,
    companyId: args.companyId,
    tenantId: args.tenantId,
    tenantMembershipId: args.tenantMembershipId,
    tokenType: "refresh",
  });

  await tx.userRefreshSession.create({
    data: {
      id: sessionId,
      userId: args.userId,
      tenantId: args.tenantId,
      tenantMembershipId: args.tenantMembershipId,
      companyMembershipId: args.companyMembershipId,
      rotationDepth: args.predecessor ? args.predecessor.depth + 1 : 0,
      replacementDepth: null, replacedBySessionId: null,
      tokenHash: hashToken(refreshToken),
      expiresAt: getTokenExpiryDate(refreshToken),
      userAgent: args.userAgent ?? null,
      ipAddress: args.ipAddress ?? null,
    },
  });
  if (args.predecessor) {
    const published = await tx.userRefreshSession.updateMany({ where: {
      id: args.predecessor.id, userId: args.userId, tenantId: args.tenantId,
      tenantMembershipId: args.tenantMembershipId, companyMembershipId: args.companyMembershipId,
      rotationDepth: args.predecessor.depth, revokedAt: { not: null }, replacedBySessionId: null, replacementDepth: null,
    }, data: { replacedBySessionId: sessionId, replacementDepth: args.predecessor.depth + 1 } });
    if (published.count !== 1) throw new Error("Refresh lineage unavailable");
  }
  return refreshToken;
}

async function issueAuthSession(args: TenantSessionContext & {
  predecessor?: { id: string; depth: number };
  userAgent?: string | null;
  ipAddress?: string | null;
}, tx: Prisma.TransactionClient | typeof prisma = prisma) {
  const token = signAccessToken({
    id: args.userId,
    membershipId: args.membershipId,
    companyMembershipId: args.companyMembershipId,
    companyId: args.companyId,
    tenantId: args.tenantId,
    tenantMembershipId: args.tenantMembershipId,
    branchId: args.branchId ?? null,
  });
  const refreshToken = await createRefreshSession({
    ...args,
    userAgent: args.userAgent ?? null,
    ipAddress: args.ipAddress ?? null,
  }, tx);
  return {
    token,
    refreshToken,
    accessTokenExpiresInSec: getTokenLifetimeSec(token),
  };
}

export async function loginUser(args: {
  email: string;
  password: string;
  companyMembershipId?: string | null;
  membershipId?: string | null;
  userAgent?: string | null;
  ipAddress?: string | null;
}) {
  const email = String(args.email || "").trim().toLowerCase();
  const password = String(args.password || "");
  if (!email || !password) throw new Error("Invalid email or password");

  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true, password: true },
  });
  const ok = await bcrypt.compare(password, user?.password ?? MISSING_USER_PASSWORD_HASH);
  if (!user || !ok) throw new Error("Invalid email or password");

  const companyMembershipId = String(args.companyMembershipId ?? "").trim();
  const compatibilityMembershipId = String(args.membershipId ?? "").trim();
  if (companyMembershipId && compatibilityMembershipId && companyMembershipId !== compatibilityMembershipId) {
    throw new InvalidMembershipSelectionError();
  }
  const context = await resolveLoginContext(user.id, companyMembershipId || compatibilityMembershipId);

  clearIdentityAccessCacheForUser(user.id);
  const access = await loadAccessSnapshot({
    userId: user.id,
    membershipId: context.membershipId,
    companyMembershipId: context.companyMembershipId,
    companyId: context.companyId,
    tenantId: context.tenantId,
    tenantMembershipId: context.tenantMembershipId,
    requireFresh: true,
  });
  if (!access) throw new InvalidMembershipSelectionError();
  const session = await prisma.$transaction(async tx => {
    const locked = await lockCredentialUser(tx, user.id);
    if (locked.password !== user.password) throw new Error("Invalid email or password");
    if (!sameSelectedContext(await resolveStoredContext(user.id, context.companyMembershipId, tx), context)) throw new InvalidMembershipSelectionError();
    return issueAuthSession({ ...context, userAgent: args.userAgent ?? null, ipAddress: args.ipAddress ?? null }, tx);
  }, refreshLineageTransactionOptions);
  return { ...session, user: access };
}

export async function refreshUserSession(args: {
  refreshToken: string;
  userAgent?: string | null;
  ipAddress?: string | null;
}) {
  const rawToken = String(args.refreshToken || "").trim();
  if (!rawToken) throw new Error("Refresh token is required");

  let decoded: RefreshTokenPayload;
  try {
    decoded = jwt.verify(rawToken, getRefreshTokenSecret()) as RefreshTokenPayload;
  } catch {
    throw new Error("Invalid refresh token");
  }
  if (!decoded?.id || !decoded?.sid || !decoded.companyMembershipId || !decoded.companyId
    || !decoded.tenantId || !decoded.tenantMembershipId || decoded.tokenType !== "refresh") {
    throw new Error("Refresh session requires fresh login");
  }
  const session = await prisma.userRefreshSession.findUnique({
    where: { id: decoded.sid },
    include: {
      user: {
        select: { id: true },
      },
    },
  });
  if (!session || session.userId !== decoded.id) throw new Error("Invalid refresh token");
  if (session.revokedAt) throw new Error("Refresh token revoked");
  if (session.expiresAt <= new Date()) throw new Error("Refresh token expired");
  if (session.tokenHash !== hashToken(rawToken)) throw new Error("Refresh token mismatch");
  if (!session.tenantId || !session.tenantMembershipId || !session.companyMembershipId) {
    throw new Error("Refresh session requires fresh login");
  }
  if (session.tenantId !== decoded.tenantId
    || session.tenantMembershipId !== decoded.tenantMembershipId
    || session.companyMembershipId !== decoded.companyMembershipId) {
    throw new Error("Refresh token context mismatch");
  }

  const context = await resolveStoredContext(decoded.id, session.companyMembershipId);
  if (!context || context.companyId !== decoded.companyId
    || context.tenantId !== session.tenantId
    || context.tenantMembershipId !== session.tenantMembershipId) {
    throw new Error("Refresh membership is no longer eligible");
  }
  clearIdentityAccessCacheForUser(decoded.id);
  const access = await loadAccessSnapshot({
    userId: decoded.id,
    membershipId: context.membershipId,
    companyMembershipId: context.companyMembershipId,
    companyId: context.companyId,
    tenantId: context.tenantId,
    tenantMembershipId: context.tenantMembershipId,
    requireFresh: true,
  });
  if (!access) throw new Error("Refresh membership is no longer eligible");
  if (!Number.isInteger(session.rotationDepth) || session.rotationDepth < 0 || session.rotationDepth >= MAX_REFRESH_ROTATION_DEPTH ||
      session.replacedBySessionId || session.replacementDepth !== null) throw new Error("Refresh session requires fresh login");
  const next = await prisma.$transaction(async (tx) => {
    await lockCredentialUser(tx, context.userId);
    await lockRefreshContext(tx, context);
    const consumedAt = new Date();
    const revoked = await tx.userRefreshSession.updateMany({
      where: {
        id: session.id,
        userId: decoded.id,
        tenantId: context.tenantId,
        tenantMembershipId: context.tenantMembershipId,
        companyMembershipId: context.companyMembershipId,
        tokenHash: hashToken(rawToken),
        rotationDepth: session.rotationDepth, replacedBySessionId: null, replacementDepth: null,
        revokedAt: null,
        expiresAt: { gt: consumedAt },
        tenant: { is: { id: context.tenantId, status: "active" } },
        companyMembership: { is: {
          id: context.companyMembershipId,
          userId: decoded.id,
          tenantId: context.tenantId,
          tenantMembershipId: context.tenantMembershipId,
          companyId: context.companyId,
          status: "active",
          company: { is: {
            id: context.companyId, tenantId: context.tenantId,
            type: "company", isActive: true,
          } },
          tenantMembership: { is: {
            id: context.tenantMembershipId, userId: decoded.id,
            tenantId: context.tenantId, status: "active",
          } },
        } },
      },
      data: { revokedAt: consumedAt },
    });
    if (revoked.count !== 1) throw new Error("Refresh token revoked");
    return issueAuthSession({
      ...context,
      predecessor: { id: session.id, depth: session.rotationDepth },
      userAgent: args.userAgent ?? null,
      ipAddress: args.ipAddress ?? null,
    }, tx);
  }, refreshLineageTransactionOptions);
  return { ...next, user: access };
}

export async function revokeRefreshSession(refreshToken: string) {
  const token = String(refreshToken || "").trim();
  if (!token) return;
  let decoded: RefreshTokenPayload;
  try {
    decoded = jwt.verify(token, getRefreshTokenSecret()) as RefreshTokenPayload;
  } catch {
    return;
  }
  const ids = [decoded?.sid, decoded?.id, decoded?.tenantId, decoded?.tenantMembershipId,
    decoded?.companyMembershipId, decoded?.companyId];
  if (decoded?.tokenType !== "refresh" || ids.some(value => typeof value !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value))) return;
  await prisma.$transaction(tx => revokeRecordedSuccessors(tx, decoded, hashToken(token)), refreshLineageTransactionOptions);
}

export async function changeUserPassword(args: {
  actor: AppUser;
  currentPassword: string;
  newPassword: string;
}) {
  const actor = args.actor;
  if (!actor?.id || !actor.tenantId || !actor.tenantMembershipId || !actor.companyId ||
      !actor.companyMembershipId || actor.membershipId !== actor.companyMembershipId) throw new Error("Unauthorized");
  const context: TenantSessionContext = { userId: actor.id, membershipId: actor.membershipId,
    companyMembershipId: actor.companyMembershipId, tenantMembershipId: actor.tenantMembershipId,
    tenantId: actor.tenantId, companyId: actor.companyId, branchId: actor.branchId };
  const access = await loadAccessSnapshot({ userId: actor.id, ...actor, requireFresh: true });
  if (!access) throw new Error("Unauthorized");
  const user = await prisma.user.findUnique({
    where: { id: actor.id },
    select: { id: true, password: true },
  });
  if (!user) throw new Error("Unauthorized");

  const ok = await bcrypt.compare(args.currentPassword, user.password);
  if (!ok) throw new Error("Current password is incorrect");

  const password = await bcrypt.hash(args.newPassword, 10);
  await prisma.$transaction(async tx => {
    const locked = await lockCredentialUser(tx, actor.id);
    if (locked.password !== user.password) throw new Error("Current password is incorrect");
    if (!sameSelectedContext(await resolveStoredContext(actor.id, actor.companyMembershipId, tx), context)) throw new Error("Unauthorized");
    const changed = await tx.user.updateMany({ where: { id: actor.id, password: user.password }, data: { password } });
    if (changed.count !== 1) throw new Error("Current password is incorrect");
    await tx.userRefreshSession.updateMany({ where: { userId: actor.id, revokedAt: null }, data: { revokedAt: new Date() } });
  }, refreshLineageTransactionOptions);
  clearIdentityAccessCacheForUser(actor.id);
}

export async function listUsersForCompany(args: {
  actor: AppUser;
  q?: string;
  page?: number;
  limit?: number;
}) {
  const context = await requireIdentityManagementContext(args.actor, "membership.invite");
  const page = Number.isFinite(args.page) ? Math.max(1, Math.floor(args.page as number)) : 1;
  const limit = Number.isFinite(args.limit)
    ? Math.min(100, Math.max(1, Math.floor(args.limit as number)))
    : 20;
  const whereSearch = String(args.q || "").trim();

  const where: Prisma.CompanyMembershipWhereInput = {
    companyId: context.companyId,
    tenantId: context.tenantId,
    tenantMembership: { is: { tenantId: context.tenantId, status: "active" } },
    status: MembershipStatus.active,
    ...(whereSearch
      ? {
          user: {
            OR: [
              { name: { contains: whereSearch, mode: "insensitive" } },
              { email: { contains: whereSearch, mode: "insensitive" } },
            ],
          },
        }
      : null),
  };

  const [rows, total] = await prisma.$transaction([
    prisma.companyMembership.findMany({
      where,
      skip: (page - 1) * limit,
      take: limit,
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        branchId: true,
        createdAt: true,
        user: {
          select: {
            id: true,
            name: true,
            email: true,


            driverType: true,
          },
        },
        roles: {
          where: { role: { is: { companyId: context.companyId, isSystem: false } } },
          select: {
            role: {
              select: {
                id: true,
                code: true,
                name: true,
                isSystem: true,
              },
            },
          },
        },
        scopes: {
          select: {
            scopeType: true,
            scopeRefId: true,
          },
        },
      },
    }),
    prisma.companyMembership.count({ where }),
  ]);

  return {
    items: rows.map((membership) => ({
      id: membership.user.id,
      membershipId: membership.id,
      name: membership.user.name,
      email: membership.user.email,
      warehouseId: null,
      customerEntityId: null,
      driverType: membership.user.driverType ?? null,
      branchId: membership.branchId ?? null,
      createdAt: membership.createdAt.toISOString(),
      roles: membership.roles.map((entry) => ({
        id: entry.role.id,
        code: entry.role.code,
        name: entry.role.name,
        isSystem: entry.role.isSystem,
      })),
      scopes: membership.scopes.map((scope) => ({
        scopeType: scope.scopeType,
        scopeRefId: scope.scopeRefId,
      })),
    })),
    total,
    page,
    limit,
  };
}

export async function updateUserAccessByCompanyAdmin(args: {
  companyId: string;
  userId: string;
  name?: string | null;
  email?: string | null;
  roleCodes?: string[] | null;
  branchId?: string | null;
  warehouseId?: string | null;
  customerEntityId?: string | null;
  driverType?: "local" | "linehaul" | null;
  scopes?: unknown;
}) {
  rejectAdministrativeMutation();
}

export async function createUserByCompanyAdmin(args: {
  companyId: string;
  name: string;
  email: string;
  password: string;
  roleCodes: string[];
  branchId?: string | null;
  warehouseId?: string | null;
  customerEntityId?: string | null;
  driverType?: "local" | "linehaul" | null;
  scopes?: unknown;
}) {
  rejectAdministrativeMutation();
}

export async function deleteUserMembershipFromCompany(args: {
  actorUserId: string;
  targetUserId: string;
  companyId: string;
}) {
  rejectAdministrativeMutation();
}
