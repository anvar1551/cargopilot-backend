import { NextFunction, Request, Response } from "express";
import { publishAnalyticsInvalidation } from "../features/manager/analyticsV2Realtime";

type Reason = "order_mutation" | "invoice_mutation" | "cash_mutation";
type ReasonResolver = Reason | ((req: Request) => Reason);

function isMutatingMethod(method: string) {
  return method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE";
}

export function analyticsInvalidateOnSuccess(reason: ReasonResolver) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!isMutatingMethod(req.method)) {
      return next();
    }

    res.on("finish", () => {
      if (res.statusCode < 200 || res.statusCode >= 400) return;
      const resolved = typeof reason === "function" ? reason(req) : reason;
      void publishAnalyticsInvalidation(resolved);
    });

    return next();
  };
}
