import { publishCargoPilotDomainEvent } from "../modules/analytics-core/realtime/analyticsEvents";

export async function emitAnalyticsInvalidationForMutation(args: {
  reason: "order_mutation" | "cash_mutation";
}) {
  await publishCargoPilotDomainEvent({
    type: "manual_refresh",
    tenantScope: "global",
    entityId: null,
    payload: { reason: args.reason },
  });
}
