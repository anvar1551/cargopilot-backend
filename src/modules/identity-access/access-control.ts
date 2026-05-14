import { AppRole, Prisma, ScopeResource, ScopeType } from "@prisma/client";
import prisma from "../../config/prismaClient";

type AuthUser = Express.User;
type PermissionCode =
  | "orders.read"
  | "support.read"
  | "support.create"
  | "support.update";

type ResolvedAccess = {
  hasBindings: boolean;
  permissions: Set<string>;
  orgIds: Set<string>;
  scopeRules: Map<ScopeResource, ScopeType[]>;
};

type AccessCacheEntry = {
  expiresAt: number;
  value: ResolvedAccess;
};

const accessCache = new Map<string, AccessCacheEntry>();
const accessCacheTtlMs = Math.max(
  15_000,
  Number(process.env.ACCESS_SCOPE_CACHE_TTL_MS || 120_000),
);

const accessCacheGc = setInterval(() => {
  const now = Date.now();
  for (const [key, value] of accessCache.entries()) {
    if (now >= value.expiresAt) {
      accessCache.delete(key);
    }
  }
}, 60_000);
accessCacheGc.unref();

const legacyRolePermissions: Record<AppRole, PermissionCode[]> = {
  customer: ["orders.read"],
  driver: ["orders.read"],
  warehouse: ["orders.read"],
  manager: ["orders.read", "support.read", "support.create", "support.update"],
};

function readAccessCache(userId: string) {
  const hit = accessCache.get(userId);
  if (!hit) return null;
  if (hit.expiresAt <= Date.now()) {
    accessCache.delete(userId);
    return null;
  }
  return hit.value;
}

function writeAccessCache(userId: string, value: ResolvedAccess) {
  accessCache.set(userId, {
    value,
    expiresAt: Date.now() + accessCacheTtlMs,
  });
}

async function loadResolvedAccess(user: AuthUser): Promise<ResolvedAccess> {
  const cached = readAccessCache(user.id);
  if (cached) return cached;

  const [profile, bindings] = await prisma.$transaction([
    prisma.user.findUnique({
      where: { id: user.id },
      select: { homeOrgId: true },
    }),
    prisma.userRoleBinding.findMany({
      where: { userId: user.id },
      select: {
        orgId: true,
        role: {
          select: {
            rolePermissions: {
              select: {
                permission: {
                  select: { code: true },
                },
              },
            },
            scopePolicies: {
              select: { resource: true, scopeType: true },
            },
          },
        },
      },
    }),
  ]);

  const permissions = new Set<string>();
  const orgIds = new Set<string>();
  const scopeRules = new Map<ScopeResource, ScopeType[]>();

  if (profile?.homeOrgId) {
    orgIds.add(profile.homeOrgId);
  }

  for (const binding of bindings) {
    orgIds.add(binding.orgId);
    for (const rp of binding.role.rolePermissions) {
      permissions.add(rp.permission.code);
    }
    for (const policy of binding.role.scopePolicies) {
      const existing = scopeRules.get(policy.resource) ?? [];
      if (!existing.includes(policy.scopeType)) {
        existing.push(policy.scopeType);
      }
      scopeRules.set(policy.resource, existing);
    }
  }

  const value: ResolvedAccess = {
    hasBindings: bindings.length > 0,
    permissions,
    orgIds,
    scopeRules,
  };
  writeAccessCache(user.id, value);
  return value;
}

export async function hasPermission(user: AuthUser, permission: PermissionCode) {
  const resolved = await loadResolvedAccess(user);
  if (!resolved.hasBindings) {
    return legacyRolePermissions[user.role]?.includes(permission) ?? false;
  }
  return resolved.permissions.has(permission);
}

function orWhere<T>(items: T[]): T | null {
  if (items.length === 0) return null;
  if (items.length === 1) return items[0];
  return { OR: items } as T;
}

function resolvedScopesOrFallback(
  resolved: ResolvedAccess,
  user: AuthUser,
  resource: ScopeResource,
): ScopeType[] {
  if (!resolved.hasBindings) {
    if (resource === ScopeResource.orders) {
      if (user.role === AppRole.customer) return [ScopeType.own];
      if (user.role === AppRole.driver) return [ScopeType.assigned];
      if (user.role === AppRole.warehouse) return [ScopeType.assigned];
      return [ScopeType.global];
    }
    if (resource === ScopeResource.support) {
      return user.role === AppRole.manager ? [ScopeType.global] : [ScopeType.assigned];
    }
  }
  return resolved.scopeRules.get(resource) ?? [];
}

export async function buildOrderScopeWhere(
  user: AuthUser,
): Promise<Prisma.OrderWhereInput | null> {
  const resolved = await loadResolvedAccess(user);
  const scopes = resolvedScopesOrFallback(resolved, user, ScopeResource.orders);
  const orgIds = Array.from(resolved.orgIds);

  if (scopes.includes(ScopeType.global)) return {};

  const clauses: Prisma.OrderWhereInput[] = [];
  for (const scope of scopes) {
    if (scope === ScopeType.own) {
      clauses.push({
        OR: [{ customerId: user.id }, { ownerOrgId: { in: orgIds } }],
      });
    }
    if (scope === ScopeType.assigned) {
      clauses.push({
        OR: [{ assignedDriverId: user.id }, { assignedOrgId: { in: orgIds } }],
      });
    }
    if (
      scope === ScopeType.organization ||
      scope === ScopeType.branch ||
      scope === ScopeType.subtree
    ) {
      clauses.push({
        OR: [{ ownerOrgId: { in: orgIds } }, { assignedOrgId: { in: orgIds } }],
      });
    }
  }

  return orWhere<Prisma.OrderWhereInput>(clauses) ?? { id: "__no_access__" };
}

export async function buildSupportScopeWhere(
  user: AuthUser,
): Promise<Prisma.SupportTicketWhereInput | null> {
  const resolved = await loadResolvedAccess(user);
  const scopes = resolvedScopesOrFallback(resolved, user, ScopeResource.support);
  const orgIds = Array.from(resolved.orgIds);

  if (scopes.includes(ScopeType.global)) return {};

  const clauses: Prisma.SupportTicketWhereInput[] = [];
  for (const scope of scopes) {
    if (scope === ScopeType.own) {
      clauses.push({ ownerId: user.id });
    }
    if (scope === ScopeType.assigned) {
      clauses.push({
        OR: [{ ownerId: user.id }, { assignedOrgId: { in: orgIds } }],
      });
    }
    if (
      scope === ScopeType.organization ||
      scope === ScopeType.branch ||
      scope === ScopeType.subtree
    ) {
      clauses.push({
        OR: [{ ownerOrgId: { in: orgIds } }, { assignedOrgId: { in: orgIds } }],
      });
    }
  }

  return orWhere<Prisma.SupportTicketWhereInput>(clauses) ?? { id: "__no_access__" };
}

