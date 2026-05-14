import { NextFunction, Request, Response } from "express";
import { authorize } from "../modules/identity-access";

export function requirePermission(permission: string) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.user) {
        return res.status(401).json({ error: "Unauthorized" });
      }
      await authorize(req.user, permission);
      return next();
    } catch (err: any) {
      const code = err?.statusCode ?? 403;
      return res.status(code).json({ error: err?.message ?? "Forbidden" });
    }
  };
}
