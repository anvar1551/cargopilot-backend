"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveAuthenticatedUserFromAuthHeader = resolveAuthenticatedUserFromAuthHeader;
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const prismaClient_1 = __importDefault(require("../config/prismaClient"));
const identity_access_1 = require("../modules/identity-access");
const authUserCache = new Map();
const authCacheTtlMs = Math.max(10000, Number(process.env.AUTH_USER_CACHE_TTL_MS || 300000));
const authCacheCleanup = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of authUserCache.entries()) {
        if (entry.expiresAt <= now) {
            authUserCache.delete(key);
        }
    }
}, 60000);
authCacheCleanup.unref();
function readCachedUser(userId) {
    const hit = authUserCache.get(userId);
    if (!hit)
        return null;
    if (hit.expiresAt <= Date.now()) {
        authUserCache.delete(userId);
        return null;
    }
    return hit.user;
}
function writeCachedUser(user) {
    authUserCache.set(user.id, {
        user,
        expiresAt: Date.now() + authCacheTtlMs,
    });
}
function resolveLookupMode() {
    const value = String(process.env.AUTH_DB_LOOKUP_MODE || "token_or_cache")
        .trim()
        .toLowerCase();
    if (value === "always" || value === "cache_first" || value === "token_or_cache") {
        return value;
    }
    return "token_or_cache";
}
function buildUserFromToken(decoded) {
    if (!decoded?.id || !decoded?.role)
        return null;
    if (!(0, identity_access_1.isActorRole)(decoded.role))
        return null;
    return {
        id: decoded.id,
        role: decoded.role,
        customerEntityId: typeof decoded.customerEntityId === "string" ? decoded.customerEntityId : null,
        email: typeof decoded.email === "string" ? decoded.email : "",
        name: typeof decoded.name === "string" ? decoded.name : "",
        warehouseId: typeof decoded.warehouseId === "string" ? decoded.warehouseId : null,
    };
}
async function loadUserFromDb(userId) {
    const user = await prismaClient_1.default.user.findUnique({
        where: { id: userId },
        select: {
            id: true,
            role: true,
            customerEntityId: true,
            email: true,
            name: true,
            warehouseId: true,
        },
    });
    if (!user)
        return null;
    writeCachedUser(user);
    return user;
}
function getBearerTokenFromHeader(header) {
    if (!header)
        return null;
    const [scheme, token] = header.split(" ");
    if (scheme !== "Bearer" || !token)
        return null;
    return token;
}
async function resolveUserFromToken(token) {
    const secret = process.env.JWT_SECRET;
    if (!secret) {
        const e = new Error("JWT_SECRET not configured");
        e.statusCode = 500;
        throw e;
    }
    try {
        const decoded = jsonwebtoken_1.default.verify(token, secret);
        if (!decoded?.id)
            return null;
        if (decoded?.tokenType && decoded.tokenType !== "access")
            return null;
        const lookupMode = resolveLookupMode();
        const tokenUser = buildUserFromToken(decoded);
        if (lookupMode === "always") {
            return await loadUserFromDb(decoded.id);
        }
        if (lookupMode === "cache_first") {
            return readCachedUser(decoded.id) ?? (await loadUserFromDb(decoded.id));
        }
        // token_or_cache
        if (tokenUser?.email && tokenUser?.name) {
            writeCachedUser(tokenUser);
            return tokenUser;
        }
        return readCachedUser(decoded.id) ?? (await loadUserFromDb(decoded.id));
    }
    catch {
        return null;
    }
}
async function resolveAuthenticatedUserFromAuthHeader(authorizationHeader) {
    const token = getBearerTokenFromHeader(authorizationHeader);
    if (!token)
        return null;
    return resolveUserFromToken(token);
}
