import type { AppUser } from "../../../types/app-user";
import { getAnalyticsSummaryV2 } from "../../analytics-core/application/analyticsV2";
import { analyticsConfig } from "../../analytics-core/config/analyticsConfig";
import { listDriversView } from "../../driver-core/application/driverProfileService";

export type ManagerOverviewPayload = {
  totalOrders: number;
  pending: number;
  inTransit: number;
  delivered: number;
  totalRevenue: number | null;
  overdueOpenOrders: number;
  dueSoonOpenOrders: number;
  staleOpenOrders: number;
  exceptionOpenOrders: number;
  slaRiskOrders: number;
};

export type DriverListPayload = Awaited<ReturnType<typeof listDriversView>>;

async function buildManagerOverviewPayload(actor: AppUser): Promise<ManagerOverviewPayload> {
  const summary = await getAnalyticsSummaryV2({
    rangeDays: analyticsConfig.defaults.rangeDays,
    actor,
  });

  const summaryPayload = summary.payload;
  return {
    totalOrders: summaryPayload.overview.totalOrders,
    pending: summaryPayload.operations.pendingOrders,
    inTransit: summaryPayload.operations.inTransitOrders,
    delivered: summaryPayload.overview.deliveredInRange,
    totalRevenue: summaryPayload.finance.invoicedPaidAmount,
    overdueOpenOrders: summaryPayload.sla.overdueOpenOrders,
    dueSoonOpenOrders: summaryPayload.sla.dueSoonOpenOrders,
    staleOpenOrders: summaryPayload.operations.staleOpenOrders,
    exceptionOpenOrders: summaryPayload.overview.exceptionOpenOrders,
    slaRiskOrders:
      summaryPayload.sla.overdueOpenOrders +
      summaryPayload.operations.staleOpenOrders +
      summaryPayload.overview.exceptionOpenOrders,
  };
}

export async function getManagerOverviewPayload(args: { actor: AppUser }): Promise<{ payload: ManagerOverviewPayload; cache: "MISS"; ttlMs: number }> {
  return { payload: await buildManagerOverviewPayload(args.actor), cache: "MISS", ttlMs: 0 };
}

export async function listDriversPayload(args: { actor: AppUser; query?: unknown }): Promise<{ payload: DriverListPayload; cache: "MISS"; ttlMs: number }> {
  return { payload: await listDriversView(args.actor, args.query ?? {}), cache: "MISS", ttlMs: 0 };
}
