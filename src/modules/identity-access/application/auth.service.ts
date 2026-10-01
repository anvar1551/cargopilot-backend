import bcrypt from "bcryptjs";
import { rejectGlobalWarehouseAssignments } from "../../warehouse-core/application/warehouseAccess";
import jwt from "jsonwebtoken";
import { randomUUID, createHash } from "crypto";
import { MembershipStatus, Prisma } from "@prisma/client";
import prisma from "../../../config/prismaClient";
import { RefreshTokenPayload } from "../types";
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

function cleanRoleCodes(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  return Array.from(
    new Set(
      input
        .map((value) => String(value || "").trim().toLowerCase())
        .filter(Boolean),
    ),
  );
}

function roleCodesAllowCustomerEntity(roleCodes: string[]) {
  return roleCodes.some((code) => {
    const normalized = String(code || "").toLowerCase();
    return normalized === "customer" || normalized === "client" || normalized.includes("customer");
  });
}

function cleanScopeInput(
  input: unknown,
): Array<{
  scopeType:
    | "company"
    | "branch"
    | "warehouse"
    | "agent"
    | "pickup_point"
    | "carrier"
    | "client";
  scopeRefId: string;
}> {
  if (!Array.isArray(input)) return [];
  const normalized = input
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const scopeType = String((item as any).scopeType || "").trim().toLowerCase();
      const scopeRefId = String((item as any).scopeRefId || "").trim();
      if (!scopeType || !scopeRefId) return null;
      if (
        scopeType !== "company" &&
        scopeType !== "branch" &&
        scopeType !== "warehouse" &&
        scopeType !== "agent" &&
        scopeType !== "pickup_point" &&
        scopeType !== "carrier" &&
        scopeType !== "client"
      ) {
        return null;
      }
      return {
        scopeType: scopeType as
          | "company"
          | "branch"
          | "warehouse"
          | "agent"
          | "pickup_point"
          | "carrier"
          | "client",
        scopeRefId,
      };
    })
    .filter((value): value is NonNullable<typeof value> => Boolean(value));
  const dedupe = new Map<string, (typeof normalized)[number]>();
  for (const item of normalized) {
    dedupe.set(`${item.scopeType}:${item.scopeRefId}`, item);
  }
  return Array.from(dedupe.values());
}

async function resolveRoleIdsForCompany(args: {
  tx: Prisma.TransactionClient;
  companyId: string;
  roleCodes: string[];
}) {
  if (args.roleCodes.length === 0) return [];
  const roles = await args.tx.role.findMany({
    where: {
      code: { in: args.roleCodes },
      OR: [{ companyId: null }, { companyId: args.companyId }],
    },
    select: { id: true, code: true },
  });
  const roleMap = new Map(roles.map((item) => [item.code, item.id] as const));
  const resolved: string[] = [];
  for (const code of args.roleCodes) {
    const id = roleMap.get(code);
    if (!id) throw new Error(`Role '${code}' was not found for this company`);
    resolved.push(id);
  }
  return resolved;
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

async function resolveStoredContext(userId: string, companyMembershipId: string) {
  const selected = await prisma.companyMembership.findFirst({
    where: { id: companyMembershipId, userId },
    select: tenantSessionMembershipSelect,
  });
  return toTenantSessionContext(selected);
}

async function createRefreshSession(args: TenantSessionContext & {
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
      tokenHash: hashToken(refreshToken),
      expiresAt: getTokenExpiryDate(refreshToken),
      userAgent: args.userAgent ?? null,
      ipAddress: args.ipAddress ?? null,
    },
  });
  return refreshToken;
}

async function issueAuthSession(args: TenantSessionContext & {
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
  const session = await issueAuthSession({
    ...context,
    userAgent: args.userAgent ?? null,
    ipAddress: args.ipAddress ?? null,
  });
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
  const next = await prisma.$transaction(async (tx) => {
    const revoked = await tx.userRefreshSession.updateMany({
      where: {
        id: session.id,
        userId: decoded.id,
        tenantId: context.tenantId,
        tenantMembershipId: context.tenantMembershipId,
        companyMembershipId: context.companyMembershipId,
        tokenHash: hashToken(rawToken),
        revokedAt: null,
      },
      data: { revokedAt: new Date() },
    });
    if (revoked.count !== 1) throw new Error("Refresh token revoked");
    return issueAuthSession({
      ...context,
      userAgent: args.userAgent ?? null,
      ipAddress: args.ipAddress ?? null,
    }, tx);
  });
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
  if (!decoded?.sid) return;
  await prisma.userRefreshSession.updateMany({
    where: { id: decoded.sid, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

export async function changeUserPassword(args: {
  userId: string;
  currentPassword: string;
  newPassword: string;
}) {
  const user = await prisma.user.findUnique({
    where: { id: args.userId },
    select: { id: true, password: true },
  });
  if (!user) throw new Error("Unauthorized");

  const ok = await bcrypt.compare(args.currentPassword, user.password);
  if (!ok) throw new Error("Current password is incorrect");

  const password = await bcrypt.hash(args.newPassword, 10);
  await prisma.user.update({
    where: { id: args.userId },
    data: { password },
  });
  await prisma.userRefreshSession.updateMany({
    where: { userId: args.userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

export async function listUsersForCompany(args: {
  companyId: string;
  q?: string;
  page?: number;
  limit?: number;
}) {
  const page = Number.isFinite(args.page) ? Math.max(1, Math.floor(args.page as number)) : 1;
  const limit = Number.isFinite(args.limit)
    ? Math.min(100, Math.max(1, Math.floor(args.limit as number)))
    : 20;
  const whereSearch = String(args.q || "").trim();

  const where: Prisma.CompanyMembershipWhereInput = {
    companyId: args.companyId,
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
            warehouseId: true,
            customerEntityId: true,
            driverType: true,
          },
        },
        roles: {
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
      warehouseId: membership.user.warehouseId ?? null,
      customerEntityId: membership.user.customerEntityId ?? null,
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
  rejectGlobalWarehouseAssignments(args);
  const userId = String(args.userId || "").trim();
  if (!userId) throw new Error("userId is required");

  const membership = await prisma.companyMembership.findFirst({
    where: {
      companyId: args.companyId,
      userId,
      status: MembershipStatus.active,
    },
    select: { id: true },
  });
  if (!membership) throw new Error("Membership not found");

  const nextName =
    args.name === undefined ? undefined : String(args.name || "").trim();
  const nextEmail =
    args.email === undefined
      ? undefined
      : String(args.email || "").trim().toLowerCase();
  if (nextName !== undefined && !nextName) throw new Error("Name is required");
  if (nextEmail !== undefined && !nextEmail) throw new Error("Email is required");

  const nextRoleCodes =
    args.roleCodes == null ? null : cleanRoleCodes(args.roleCodes);
  if (nextRoleCodes && nextRoleCodes.length === 0) {
    throw new Error("At least one role is required");
  }
  const nextScopes = args.scopes === undefined ? undefined : cleanScopeInput(args.scopes);
  const currentRoleCodes =
    nextRoleCodes == null && args.customerEntityId !== undefined
      ? (
          await prisma.membershipRole.findMany({
            where: { membershipId: membership.id },
            select: { role: { select: { code: true } } },
          })
        ).map((entry) => entry.role.code)
      : null;
  const roleCodesForCustomerLink = nextRoleCodes ?? currentRoleCodes;
  const nextCustomerEntityId =
    args.customerEntityId === undefined
      ? undefined
      : roleCodesForCustomerLink && roleCodesAllowCustomerEntity(roleCodesForCustomerLink)
        ? args.customerEntityId
        : null;

  await prisma.$transaction(async (tx) => {
    if (nextName !== undefined || nextEmail !== undefined || args.warehouseId !== undefined || args.customerEntityId !== undefined || args.driverType !== undefined) {
      await tx.user.update({
        where: { id: userId },
        data: {
          ...(nextName !== undefined ? { name: nextName } : {}),
          ...(nextEmail !== undefined ? { email: nextEmail } : {}),
          ...(args.warehouseId !== undefined ? { warehouseId: args.warehouseId } : {}),
          ...(nextCustomerEntityId !== undefined ? { customerEntityId: nextCustomerEntityId } : {}),
          ...(args.driverType !== undefined ? { driverType: args.driverType } : {}),
        },
      });
    }

    if (args.branchId !== undefined) {
      await tx.companyMembership.update({
        where: { id: membership.id },
        data: { branchId: args.branchId },
      });
    }

    if (nextRoleCodes) {
      const roleIds = await resolveRoleIdsForCompany({
        tx,
        companyId: args.companyId,
        roleCodes: nextRoleCodes,
      });
      await tx.membershipRole.deleteMany({
        where: { membershipId: membership.id },
      });
      for (const roleId of roleIds) {
        await tx.membershipRole.create({
          data: { membershipId: membership.id, roleId },
        });
      }
    }

    if (nextScopes !== undefined) {
      const scopeList =
        nextScopes.length > 0
          ? nextScopes
          : [
              {
                scopeType: "company" as const,
                scopeRefId: args.companyId,
              },
            ];
      await tx.membershipScope.deleteMany({
        where: { membershipId: membership.id },
      });
      for (const scope of scopeList) {
        await tx.membershipScope.create({
          data: {
            membershipId: membership.id,
            scopeType: scope.scopeType,
            scopeRefId: scope.scopeRefId,
          },
        });
      }
    }
  });

  clearIdentityAccessCacheForUser(userId);
  const access = await loadAccessSnapshot({
    userId,
    membershipId: membership.id,
  });
  return access;
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
  rejectGlobalWarehouseAssignments(args);
  const name = String(args.name || "").trim();
  const email = String(args.email || "").trim().toLowerCase();
  const password = String(args.password || "");
  if (!name) throw new Error("Name is required");
  if (!email) throw new Error("Email is required");
  if (password.length < 6) throw new Error("Password must be at least 6 characters");

  const existing = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  if (existing) throw new Error("Email already registered");
  const roleCodes = cleanRoleCodes(args.roleCodes);
  if (roleCodes.length === 0) throw new Error("roleCodes is required");
  const scopes = cleanScopeInput(args.scopes);
  const customerEntityId = roleCodesAllowCustomerEntity(roleCodes)
    ? args.customerEntityId ?? null
    : null;
  const hashedPassword = await bcrypt.hash(password, 10);

  const created = await prisma.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: {
        name,
        email,
        password: hashedPassword,
        warehouseId: args.warehouseId ?? null,
        customerEntityId,
        driverType: args.driverType ?? null,
      },
      select: { id: true },
    });

    const membership = await tx.companyMembership.create({
      data: {
        userId: user.id,
        companyId: args.companyId,
        branchId: args.branchId ?? null,
        status: MembershipStatus.active,
      },
      select: { id: true, companyId: true, branchId: true },
    });

    const roleIds = await resolveRoleIdsForCompany({
      tx,
      companyId: args.companyId,
      roleCodes,
    });
    for (const roleId of roleIds) {
      await tx.membershipRole.create({
        data: { membershipId: membership.id, roleId },
      });
    }

    const scopeList =
      scopes.length > 0
        ? scopes
        : [
            {
              scopeType: "company" as const,
              scopeRefId: args.companyId,
            },
          ];
    for (const scope of scopeList) {
      await tx.membershipScope.create({
        data: {
          membershipId: membership.id,
          scopeType: scope.scopeType,
          scopeRefId: scope.scopeRefId,
        },
      });
    }

    return {
      userId: user.id,
      membershipId: membership.id,
      companyId: membership.companyId,
      branchId: membership.branchId,
    };
  });

  clearIdentityAccessCacheForUser(created.userId);
  const access = await loadAccessSnapshot({
    userId: created.userId,
    membershipId: created.membershipId,
  });
  return access;
}

export async function deleteUserMembershipFromCompany(args: {
  actorUserId: string;
  targetUserId: string;
  companyId: string;
}) {
  if (args.actorUserId === args.targetUserId) {
    throw new Error("You cannot delete yourself");
  }

  const membership = await prisma.companyMembership.findFirst({
    where: { userId: args.targetUserId, companyId: args.companyId },
    select: { id: true },
  });
  if (!membership) throw new Error("Membership not found");

  const [
    otherMemberships,
    customerOrders,
    driverOrders,
    invoices,
    trackingEvents,
    heldCashCollections,
    cashCollectionEvents,
  ] = await prisma.$transaction([
    prisma.companyMembership.count({
      where: {
        userId: args.targetUserId,
        id: { not: membership.id },
      },
    }),
    prisma.order.count({ where: { customerId: args.targetUserId } }),
    prisma.order.count({ where: { assignedDriverId: args.targetUserId } }),
    prisma.invoice.count({ where: { customerId: args.targetUserId } }),
    prisma.tracking.count({ where: { actorId: args.targetUserId } }),
    prisma.cashCollection.count({ where: { currentHolderUserId: args.targetUserId } }),
    prisma.cashCollectionEvent.count({ where: { actorId: args.targetUserId } }),
  ]);
  const hasOperationalHistory =
    otherMemberships > 0 ||
    customerOrders > 0 ||
    driverOrders > 0 ||
    invoices > 0 ||
    trackingEvents > 0 ||
    heldCashCollections > 0 ||
    cashCollectionEvents > 0;

  await prisma.$transaction(async (tx) => {
    await tx.userRefreshSession.updateMany({
      where: { userId: args.targetUserId, revokedAt: null },
      data: { revokedAt: new Date() },
    });

    if (hasOperationalHistory) {
      await tx.companyMembership.update({
        where: { id: membership.id },
        data: { status: MembershipStatus.suspended },
      });
      return;
    }

    await tx.user.delete({ where: { id: args.targetUserId } });
  });
  clearIdentityAccessCacheForUser(args.targetUserId);
  return { deleted: !hasOperationalHistory };
}
