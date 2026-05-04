import { NextFunction, Request, Response } from "express";
import {
  publishCargoPilotDomainEvent,
  type CargoPilotDomainEventType,
} from "../features/manager/analyticsEvents";
import { publishAnalyticsInvalidation } from "../features/manager/analyticsV2Realtime";

type Reason = "order_mutation" | "invoice_mutation" | "cash_mutation";
type ReasonResolver = Reason | ((req: Request) => Reason);

function isMutatingMethod(method: string) {
  return method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE";
}

function getTenantScope(req: Request) {
  const user = (req as any)?.user as { role?: string; warehouseId?: string | null } | undefined;
  if (user?.role === "warehouse" && user.warehouseId) {
    return `warehouse:${user.warehouseId}`;
  }
  if (user?.role) return `role:${user.role}`;
  return "global";
}

function inferEventType(reason: Reason, req: Request): CargoPilotDomainEventType {
  const path = req.path.toLowerCase();

  if (reason === "cash_mutation") {
    if (path.includes("/settle")) return "cash_settled";
    if (path.includes("/handoff")) return "cash_handoff";
    return "order_status_changed";
  }

  if (reason === "order_mutation") {
    if (req.method === "POST" && path === "/") return "order_created";
    return "order_status_changed";
  }

  if (reason === "invoice_mutation") return "order_status_changed";

  return "manual_refresh";
}

export function analyticsInvalidateOnSuccess(reason: ReasonResolver) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!isMutatingMethod(req.method)) {
      return next();
    }

    res.on("finish", () => {
      if (res.statusCode < 200 || res.statusCode >= 400) return;
      const resolved = typeof reason === "function" ? reason(req) : reason;
      const directInvalidation = process.env.ANALYTICS_DIRECT_INVALIDATION === "true";
      const legacyEventPublishing =
        process.env.ANALYTICS_LEGACY_MIDDLEWARE_EVENTS === "true";
      if (directInvalidation) {
        void publishAnalyticsInvalidation(resolved, { source: "api" });
      }
      if (legacyEventPublishing) {
        void publishCargoPilotDomainEvent({
          type: inferEventType(resolved, req),
          tenantScope: getTenantScope(req),
          entityId:
            typeof req.params?.id === "string" && req.params.id.trim()
              ? req.params.id
              : null,
          payload: {
            reason: resolved,
            method: req.method,
            path: req.path,
          },
        });
      }
    });

    return next();
  };
}
