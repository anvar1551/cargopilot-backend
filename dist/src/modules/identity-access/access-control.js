"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.clearIdentityAccessCacheForUser = clearIdentityAccessCacheForUser;
exports.loadAccessSnapshot = loadAccessSnapshot;
exports.hasPermission = hasPermission;
exports.hasAnyPermissionSync = hasAnyPermissionSync;
exports.scopedIdsFor = scopedIdsFor;
exports.authorize = authorize;
exports.buildOrderScopeWhere = buildOrderScopeWhere;
exports.buildSupportScopeWhere = buildSupportScopeWhere;
exports.buildCustomerEntityScopeWhere = buildCustomerEntityScopeWhere;
exports.buildOrganizationScopeWhere = buildOrganizationScopeWhere;
const client_1 = require("@prisma/client");
const prismaClient_1 = __importDefault(require("../../config/prismaClient"));
const accessCache = new Map();
const accessCacheTtlMs = Math.max(15000, Number(process.env.ACCESS_SCOPE_CACHE_TTL_MS || 120000));
const accessCacheGc = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of accessCache.entries()) {
        if (now >= entry.expiresAt) {
            accessCache.delete(key);
        }
    }
}, 60000);
accessCacheGc.unref();
function cacheKey(userId, membershipId) {
    return `${userId}:${membershipId}`;
}
function readAccessCache(userId, membershipId) {
    const key = cacheKey(userId, membershipId);
    const hit = accessCache.get(key);
    if (!hit)
        return null;
    if (hit.expiresAt <= Date.now()) {
        accessCache.delete(key);
        return null;
    }
    return hit.value;
}
function writeAccessCache(value) {
    accessCache.set(cacheKey(value.userId, value.membershipId), {
        value,
        expiresAt: Date.now() + accessCacheTtlMs,
    });
}
function clearIdentityAccessCacheForUser(userId) {
    const normalized = String(userId || "").trim();
    if (!normalized)
        return;
    for (const key of accessCache.keys()) {
        if (key.startsWith(`${normalized}:`)) {
            accessCache.delete(key);
        }
    }
}
function orWhere(items) {
    if (items.length === 0)
        return null;
    if (items.length === 1)
        return items[0];
    return { OR: items };
}
function uniqueScopeRefs(scopes, scopeType) {
    return Array.from(new Set(scopes
        .filter((item) => item.scopeType === scopeType)
        .map((item) => item.scopeRefId)
        .filter(Boolean)));
}
async function loadAccessSnapshot(args) {
    const userId = String(args.userId || "").trim();
    const membershipId = String(args.membershipId || "").trim();
    if (!userId || !membershipId)
        return null;
    const cached = readAccessCache(userId, membershipId);
    if (cached)
        return cached;
    const membership = await prismaClient_1.default.companyMembership.findFirst({
        where: {
            id: membershipId,
            userId,
            status: client_1.MembershipStatus.active,
        },
        select: {
            id: true,
            companyId: true,
            branchId: true,
            user: {
                select: {
                    id: true,
                    name: true,
                    email: true,
                    warehouseId: true,
                    customerEntityId: true,
                },
            },
            scopes: {
                select: {
                    scopeType: true,
                    scopeRefId: true,
                },
            },
            roles: {
                select: {
                    role: {
                        select: {
                            code: true,
                            rolePermissions: {
                                select: {
                                    permission: {
                                        select: { key: true },
                                    },
                                },
                            },
                        },
                    },
                },
            },
        },
    });
    if (!membership)
        return null;
    const permissionCodes = Array.from(new Set(membership.roles.flatMap((item) => item.role.rolePermissions.map((rp) => rp.permission.key))));
    const roleCodes = Array.from(new Set(membership.roles.map((item) => item.role.code)));
    const scopes = membership.scopes.length > 0
        ? membership.scopes.map((item) => ({
            scopeType: item.scopeType,
            scopeRefId: item.scopeRefId,
        }))
        : [
            {
                scopeType: "company",
                scopeRefId: membership.companyId,
            },
        ];
    const snapshot = {
        userId: membership.user.id,
        membershipId: membership.id,
        companyId: membership.companyId,
        branchId: membership.branchId ?? null,
        warehouseId: membership.user.warehouseId ?? null,
        customerEntityId: membership.user.customerEntityId ?? null,
        email: membership.user.email ?? "",
        name: membership.user.name ?? "",
        roleCodes,
        permissionCodes,
        scopes,
    };
    writeAccessCache(snapshot);
    return snapshot;
}
async function hasPermission(user, permission) {
    if (Array.isArray(user.permissionCodes) && user.permissionCodes.includes(permission)) {
        return true;
    }
    const snapshot = await loadAccessSnapshot({
        userId: user.id,
        membershipId: user.membershipId,
    });
    if (!snapshot)
        return false;
    return snapshot.permissionCodes.includes(permission);
}
function hasAnyPermissionSync(user, permissions) {
    const set = new Set(Array.isArray(user.permissionCodes) ? user.permissionCodes : []);
    return permissions.some((permission) => set.has(permission));
}
function scopedIdsFor(user, scopeType) {
    if (!Array.isArray(user.scopes))
        return [];
    return Array.from(new Set(user.scopes
        .filter((scope) => scope.scopeType === scopeType)
        .map((scope) => scope.scopeRefId)
        .filter(Boolean)));
}
function collectOrganizationScopeIds(scopes) {
    return Array.from(new Set(scopes
        .filter((item) => item.scopeType === "company" ||
        item.scopeType === "branch" ||
        item.scopeType === "agent" ||
        item.scopeType === "pickup_point" ||
        item.scopeType === "carrier" ||
        item.scopeType === "client")
        .map((item) => item.scopeRefId)
        .filter(Boolean)));
}
async function expandOrganizationScopeIds(seedIds) {
    const normalized = Array.from(new Set(seedIds.map((value) => String(value || "").trim()).filter(Boolean)));
    if (normalized.length === 0)
        return [];
    const seen = new Set(normalized);
    let frontier = normalized;
    let depth = 0;
    // Guard against accidental cycles and pathological trees.
    while (frontier.length > 0 && depth < 16) {
        const rows = await prismaClient_1.default.organization.findMany({
            where: { parentOrgId: { in: frontier } },
            select: { id: true },
        });
        const next = [];
        for (const row of rows) {
            if (!seen.has(row.id)) {
                seen.add(row.id);
                next.push(row.id);
            }
        }
        frontier = next;
        depth += 1;
    }
    return Array.from(seen);
}
async function authorize(user, permission) {
    const ok = await hasPermission(user, permission);
    if (ok)
        return;
    const err = new Error("Forbidden");
    err.statusCode = 403;
    throw err;
}
function buildOrgScopedOrderWhere(scopes) {
    const orgIds = Array.from(new Set(scopes
        .filter((item) => item.scopeType === "company" ||
        item.scopeType === "branch" ||
        item.scopeType === "agent" ||
        item.scopeType === "pickup_point" ||
        item.scopeType === "carrier" ||
        item.scopeType === "client")
        .map((item) => item.scopeRefId)));
    if (orgIds.length === 0)
        return null;
    return {
        OR: [{ ownerOrgId: { in: orgIds } }, { assignedOrgId: { in: orgIds } }],
    };
}
function hasRoleCode(snapshot, predicate) {
    return snapshot.roleCodes.some((code) => predicate(String(code || "").toLowerCase()));
}
function isCustomerWorkspaceOnly(snapshot) {
    const hasCustomerRole = hasRoleCode(snapshot, (code) => code === "customer" || code === "client" || code.includes("customer"));
    if (!hasCustomerRole)
        return false;
    const hasOperationalRole = hasRoleCode(snapshot, (code) => code === "admin" ||
        code === "super_admin" ||
        code === "superadmin" ||
        code === "owner" ||
        code === "manager" ||
        code.includes("manager") ||
        code.includes("warehouse") ||
        code.includes("driver") ||
        code.includes("courier") ||
        code.includes("dispatcher") ||
        code.includes("support") ||
        code.includes("accountant"));
    return !hasOperationalRole;
}
async function buildOrderScopeWhere(user) {
    const snapshot = await loadAccessSnapshot({
        userId: user.id,
        membershipId: user.membershipId,
    });
    if (!snapshot)
        return { id: "__no_access__" };
    if (isCustomerWorkspaceOnly(snapshot)) {
        return snapshot.customerEntityId
            ? { customerEntityId: snapshot.customerEntityId }
            : { id: "__no_access__" };
    }
    const clauses = [];
    const orgScope = buildOrgScopedOrderWhere(snapshot.scopes);
    if (orgScope)
        clauses.push(orgScope);
    const warehouseIds = uniqueScopeRefs(snapshot.scopes, "warehouse");
    if (warehouseIds.length > 0) {
        clauses.push({ currentWarehouseId: { in: warehouseIds } });
    }
    if (snapshot.permissionCodes.includes("shipment.view") &&
        snapshot.warehouseId) {
        clauses.push({ currentWarehouseId: snapshot.warehouseId });
    }
    if (snapshot.permissionCodes.includes("shipment.assignCourier")) {
        clauses.push({ assignedDriverId: user.id });
    }
    if ((snapshot.permissionCodes.includes("shipment.view") ||
        snapshot.permissionCodes.includes("shipment.update")) &&
        snapshot.customerEntityId) {
        clauses.push({ customerEntityId: snapshot.customerEntityId });
    }
    return orWhere(clauses) ?? { id: "__no_access__" };
}
async function buildSupportScopeWhere(user) {
    const snapshot = await loadAccessSnapshot({
        userId: user.id,
        membershipId: user.membershipId,
    });
    if (!snapshot)
        return { id: "__no_access__" };
    if (isCustomerWorkspaceOnly(snapshot)) {
        return snapshot.customerEntityId
            ? { customerEntityId: snapshot.customerEntityId }
            : { id: "__no_access__" };
    }
    const clauses = [];
    const orgIds = Array.from(new Set(snapshot.scopes
        .filter((item) => item.scopeType === "company" ||
        item.scopeType === "branch" ||
        item.scopeType === "agent" ||
        item.scopeType === "pickup_point" ||
        item.scopeType === "carrier" ||
        item.scopeType === "client")
        .map((item) => item.scopeRefId)));
    if (orgIds.length > 0) {
        clauses.push({
            OR: [{ ownerOrgId: { in: orgIds } }, { assignedOrgId: { in: orgIds } }],
        });
    }
    if (snapshot.permissionCodes.includes("support.assign")) {
        clauses.push({ ownerId: user.id });
    }
    if (snapshot.customerEntityId) {
        clauses.push({ customerEntityId: snapshot.customerEntityId });
    }
    return orWhere(clauses) ?? { id: "__no_access__" };
}
async function buildCustomerEntityScopeWhere(user) {
    const snapshot = await loadAccessSnapshot({
        userId: user.id,
        membershipId: user.membershipId,
    });
    if (!snapshot)
        return { id: { in: [] } };
    if (isCustomerWorkspaceOnly(snapshot)) {
        return snapshot.customerEntityId
            ? { id: snapshot.customerEntityId }
            : { id: { in: [] } };
    }
    // System override can read all customer entities.
    if (snapshot.permissionCodes.includes("policy.override")) {
        return null;
    }
    const agentOrgIds = uniqueScopeRefs(snapshot.scopes, "agent");
    const clientOrgIds = uniqueScopeRefs(snapshot.scopes, "client");
    const clauses = [];
    if (snapshot.customerEntityId) {
        clauses.push({ id: snapshot.customerEntityId });
    }
    if (agentOrgIds.length > 0 || clientOrgIds.length > 0) {
        const orgIds = Array.from(new Set([...agentOrgIds, ...clientOrgIds]));
        clauses.push({
            orders: {
                some: {
                    OR: [{ ownerOrgId: { in: orgIds } }, { assignedOrgId: { in: orgIds } }],
                },
            },
        });
    }
    // If user has customer read/write permissions at company scope but no direct
    // customer linkage yet, do not collapse to empty.
    const hasCustomerPermission = snapshot.permissionCodes.includes("customers.read") ||
        snapshot.permissionCodes.includes("customers.write");
    const hasOrgScope = snapshot.scopes.some((item) => item.scopeType === "company" ||
        item.scopeType === "branch" ||
        item.scopeType === "agent" ||
        item.scopeType === "pickup_point" ||
        item.scopeType === "carrier" ||
        item.scopeType === "client");
    if (hasCustomerPermission && hasOrgScope) {
        return null;
    }
    return orWhere(clauses) ?? { id: { in: [] } };
}
async function buildOrganizationScopeWhere(user) {
    const snapshot = await loadAccessSnapshot({
        userId: user.id,
        membershipId: user.membershipId,
    });
    if (!snapshot)
        return { id: { in: [] } };
    if (snapshot.permissionCodes.includes("policy.override")) {
        return null;
    }
    const scopedOrgIds = collectOrganizationScopeIds(snapshot.scopes);
    const seedIds = scopedOrgIds.length > 0
        ? scopedOrgIds
        : snapshot.companyId
            ? [snapshot.companyId]
            : [];
    const expandedIds = await expandOrganizationScopeIds(seedIds);
    if (expandedIds.length === 0) {
        return { id: { in: [] } };
    }
    return { id: { in: expandedIds } };
}
