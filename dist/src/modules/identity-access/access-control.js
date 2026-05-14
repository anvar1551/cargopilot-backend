"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.hasPermission = hasPermission;
exports.buildOrderScopeWhere = buildOrderScopeWhere;
exports.buildSupportScopeWhere = buildSupportScopeWhere;
const client_1 = require("@prisma/client");
const prismaClient_1 = __importDefault(require("../../config/prismaClient"));
const accessCache = new Map();
const accessCacheTtlMs = Math.max(15000, Number(process.env.ACCESS_SCOPE_CACHE_TTL_MS || 120000));
const accessCacheGc = setInterval(() => {
    const now = Date.now();
    for (const [key, value] of accessCache.entries()) {
        if (now >= value.expiresAt) {
            accessCache.delete(key);
        }
    }
}, 60000);
accessCacheGc.unref();
const legacyRolePermissions = {
    customer: ["orders.read"],
    driver: ["orders.read"],
    warehouse: ["orders.read"],
    manager: ["orders.read", "support.read", "support.create", "support.update"],
};
function readAccessCache(userId) {
    const hit = accessCache.get(userId);
    if (!hit)
        return null;
    if (hit.expiresAt <= Date.now()) {
        accessCache.delete(userId);
        return null;
    }
    return hit.value;
}
function writeAccessCache(userId, value) {
    accessCache.set(userId, {
        value,
        expiresAt: Date.now() + accessCacheTtlMs,
    });
}
async function loadResolvedAccess(user) {
    const cached = readAccessCache(user.id);
    if (cached)
        return cached;
    const [profile, bindings] = await prismaClient_1.default.$transaction([
        prismaClient_1.default.user.findUnique({
            where: { id: user.id },
            select: { homeOrgId: true },
        }),
        prismaClient_1.default.userRoleBinding.findMany({
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
    const permissions = new Set();
    const orgIds = new Set();
    const scopeRules = new Map();
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
    const value = {
        hasBindings: bindings.length > 0,
        permissions,
        orgIds,
        scopeRules,
    };
    writeAccessCache(user.id, value);
    return value;
}
async function hasPermission(user, permission) {
    const resolved = await loadResolvedAccess(user);
    if (!resolved.hasBindings) {
        return legacyRolePermissions[user.role]?.includes(permission) ?? false;
    }
    return resolved.permissions.has(permission);
}
function orWhere(items) {
    if (items.length === 0)
        return null;
    if (items.length === 1)
        return items[0];
    return { OR: items };
}
function resolvedScopesOrFallback(resolved, user, resource) {
    if (!resolved.hasBindings) {
        if (resource === client_1.ScopeResource.orders) {
            if (user.role === client_1.AppRole.customer)
                return [client_1.ScopeType.own];
            if (user.role === client_1.AppRole.driver)
                return [client_1.ScopeType.assigned];
            if (user.role === client_1.AppRole.warehouse)
                return [client_1.ScopeType.assigned];
            return [client_1.ScopeType.global];
        }
        if (resource === client_1.ScopeResource.support) {
            return user.role === client_1.AppRole.manager ? [client_1.ScopeType.global] : [client_1.ScopeType.assigned];
        }
    }
    return resolved.scopeRules.get(resource) ?? [];
}
async function buildOrderScopeWhere(user) {
    const resolved = await loadResolvedAccess(user);
    const scopes = resolvedScopesOrFallback(resolved, user, client_1.ScopeResource.orders);
    const orgIds = Array.from(resolved.orgIds);
    if (scopes.includes(client_1.ScopeType.global))
        return {};
    const clauses = [];
    for (const scope of scopes) {
        if (scope === client_1.ScopeType.own) {
            clauses.push({
                OR: [{ customerId: user.id }, { ownerOrgId: { in: orgIds } }],
            });
        }
        if (scope === client_1.ScopeType.assigned) {
            clauses.push({
                OR: [{ assignedDriverId: user.id }, { assignedOrgId: { in: orgIds } }],
            });
        }
        if (scope === client_1.ScopeType.organization ||
            scope === client_1.ScopeType.branch ||
            scope === client_1.ScopeType.subtree) {
            clauses.push({
                OR: [{ ownerOrgId: { in: orgIds } }, { assignedOrgId: { in: orgIds } }],
            });
        }
    }
    return orWhere(clauses) ?? { id: "__no_access__" };
}
async function buildSupportScopeWhere(user) {
    const resolved = await loadResolvedAccess(user);
    const scopes = resolvedScopesOrFallback(resolved, user, client_1.ScopeResource.support);
    const orgIds = Array.from(resolved.orgIds);
    if (scopes.includes(client_1.ScopeType.global))
        return {};
    const clauses = [];
    for (const scope of scopes) {
        if (scope === client_1.ScopeType.own) {
            clauses.push({ ownerId: user.id });
        }
        if (scope === client_1.ScopeType.assigned) {
            clauses.push({
                OR: [{ ownerId: user.id }, { assignedOrgId: { in: orgIds } }],
            });
        }
        if (scope === client_1.ScopeType.organization ||
            scope === client_1.ScopeType.branch ||
            scope === client_1.ScopeType.subtree) {
            clauses.push({
                OR: [{ ownerOrgId: { in: orgIds } }, { assignedOrgId: { in: orgIds } }],
            });
        }
    }
    return orWhere(clauses) ?? { id: "__no_access__" };
}
