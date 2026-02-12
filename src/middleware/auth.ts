import { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import prisma from "../config/prismaClient";
import { AppRole } from "@prisma/client";

type JwtPayload = { id: string };

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

      const user = await prisma.user.findUnique({
        where: { id: decoded.id },
        select: {
          id: true,
          role: true,
          customerEntityId: true,
          email: true,
          name: true,
          warehouseId: true,
        },
      });

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
