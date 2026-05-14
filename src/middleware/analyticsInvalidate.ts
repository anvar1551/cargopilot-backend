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

type FastMutationEmitArgs = {
  reason: Reason;
  method: string;
  path: string;
  user?: { role?: string; warehouseId?: string | null } | null;
  entityId?: string | null;
};

export async function emitAnalyticsInvalidationForMutation(args: FastMutationEmitArgs) {
  const directInvalidation = process.env.ANALYTICS_DIRECT_INVALIDATION === "true";
  const legacyEventPublishing =
    process.env.ANALYTICS_LEGACY_MIDDLEWARE_EVENTS === "true";

  if (!directInvalidation && !legacyEventPublishing) return;

  if (directInvalidation) {
    await publishAnalyticsInvalidation(args.reason, { source: "api" });
  }

  if (legacyEventPublishing) {
    const role = String(args.user?.role ?? "").trim().toLowerCase();
    const tenantScope =
      role === "warehouse" && args.user?.warehouseId
        ? `warehouse:${args.user.warehouseId}`
        : role
          ? `role:${role}`
          : "global";

    await publishCargoPilotDomainEvent({
      type: inferEventType(args.reason, {
        method: args.method,
        path: args.path,
      } as Request),
      tenantScope,
      entityId: args.entityId?.trim() || null,
      payload: {
        reason: args.reason,
        method: args.method,
        path: args.path,
      },
    });
  }
}

export function analyticsInvalidateOnSuccess(reason: ReasonResolver) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!isMutatingMethod(req.method)) {
      return next();
    }

    res.on("finish", () => {
      if (res.statusCode < 200 || res.statusCode >= 400) return;
      const resolved = typeof reason === "function" ? reason(req) : reason;
      void emitAnalyticsInvalidationForMutation({
        reason: resolved,
        method: req.method,
        path: req.path,
        user: req.user,
        entityId:
          typeof req.params?.id === "string" && req.params.id.trim()
            ? req.params.id
            : null,
      });
    });

    return next();
  };
}
