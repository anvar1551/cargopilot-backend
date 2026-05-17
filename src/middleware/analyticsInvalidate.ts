import {
  publishCargoPilotDomainEvent,
  type CargoPilotDomainEventType,
} from "../modules/analytics-core/realtime/analyticsEvents";
import { publishAnalyticsInvalidation } from "../modules/analytics-core/realtime/analyticsV2Realtime";

type Reason = "order_mutation" | "invoice_mutation" | "cash_mutation";
type MutationRequestView = { method: string; path: string };

function inferEventType(reason: Reason, req: MutationRequestView): CargoPilotDomainEventType {
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
      type: inferEventType(args.reason, { method: args.method, path: args.path }),
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
