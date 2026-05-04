import { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import prisma from "../config/prismaClient";
import { AppRole } from "@prisma/client";

type JwtPayload = {
  id: string;
  role?: AppRole;
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
  if (!Object.values(AppRole).includes(decoded.role)) return null;

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

function getBearerToken(req: Request) {
  const header = req.headers.authorization;
  if (!header) return null;

  const [scheme, token] = header.split(" ");
  if (scheme !== "Bearer" || !token) return null;

  return token;
}

export function auth(requiredRoles: AppRole[] = []) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const token = getBearerToken(req);
    if (!token)
      return res.status(401).json({ error: "Invalid or missing token" });

    const secret = process.env.JWT_SECRET;
    if (!secret) {
      // fail fast (especially important in prod)
      return res.status(500).json({ error: "JWT_SECRET not configured" });
    }

    try {
      const decoded = jwt.verify(token, secret) as JwtPayload;
      if (!decoded?.id) {
        return res.status(401).json({ error: "Unauthorized" });
      }
      if (decoded?.tokenType && decoded.tokenType !== "access") {
        return res.status(401).json({ error: "Unauthorized" });
      }

      const lookupMode = resolveLookupMode();
      const tokenUser = buildUserFromToken(decoded);
      let user: Express.User | null = null;

      if (lookupMode === "always") {
        user = await loadUserFromDb(decoded.id);
      } else if (lookupMode === "cache_first") {
        user = readCachedUser(decoded.id) ?? (await loadUserFromDb(decoded.id));
      } else {
        // token_or_cache
        if (tokenUser?.email && tokenUser?.name) {
          user = tokenUser;
          writeCachedUser(user);
        } else {
          user = readCachedUser(decoded.id) ?? (await loadUserFromDb(decoded.id));
        }
      }

      if (!user) return res.status(401).json({ error: "Unauthorized" });

      req.user = user;

      if (requiredRoles.length > 0 && !requiredRoles.includes(user.role)) {
        return res.status(403).json({ error: "Forbidden" });
      }

      next();
    } catch (e) {
      return res.status(401).json({ error: "Unauthorized" });
    }
  };
}
