import jwt from "jsonwebtoken";
import prisma from "../config/prismaClient";
import { isActorRole } from "../modules/identity-access";

type JwtPayload = {
  id: string;
  role?: string;
  customerEntityId?: string | null;
  email?: string;
  name?: string;
  warehouseId?: string | null;
  tokenType?: "access" | "refresh";
};

type AuthCacheEntry = {
  expiresAt: number;
  user: Express.User;
};

const authUserCache = new Map<string, AuthCacheEntry>();
const authCacheTtlMs = Math.max(
  10_000,
  Number(process.env.AUTH_USER_CACHE_TTL_MS || 300_000),
);

const authCacheCleanup = setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of authUserCache.entries()) {
    if (entry.expiresAt <= now) {
      authUserCache.delete(key);
    }
  }
}, 60_000);
authCacheCleanup.unref();

function readCachedUser(userId: string) {
  const hit = authUserCache.get(userId);
  if (!hit) return null;
  if (hit.expiresAt <= Date.now()) {
    authUserCache.delete(userId);
    return null;
  }
  return hit.user;
}

function writeCachedUser(user: Express.User) {
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

function buildUserFromToken(decoded: JwtPayload): Express.User | null {
  if (!decoded?.id || !decoded?.role) return null;
  if (!isActorRole(decoded.role)) return null;

  return {
    id: decoded.id,
    role: decoded.role,
    customerEntityId:
      typeof decoded.customerEntityId === "string" ? decoded.customerEntityId : null,
    email: typeof decoded.email === "string" ? decoded.email : "",
    name: typeof decoded.name === "string" ? decoded.name : "",
    warehouseId: typeof decoded.warehouseId === "string" ? decoded.warehouseId : null,
  };
}

async function loadUserFromDb(userId: string) {
  const user = await prisma.user.findUnique({
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
  if (!user) return null;
  writeCachedUser(user);
  return user;
}

function getBearerTokenFromHeader(header: string | undefined) {
  if (!header) return null;

  const [scheme, token] = header.split(" ");
  if (scheme !== "Bearer" || !token) return null;

  return token;
}

async function resolveUserFromToken(token: string): Promise<Express.User | null> {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    const e = new Error("JWT_SECRET not configured") as Error & { statusCode: number };
    e.statusCode = 500;
    throw e;
  }

  try {
    const decoded = jwt.verify(token, secret) as JwtPayload;
    if (!decoded?.id) return null;
    if (decoded?.tokenType && decoded.tokenType !== "access") return null;

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
  } catch {
    return null;
  }
}

export async function resolveAuthenticatedUserFromAuthHeader(
  authorizationHeader: string | undefined,
) {
  const token = getBearerTokenFromHeader(authorizationHeader);
  if (!token) return null;
  return resolveUserFromToken(token);
}
