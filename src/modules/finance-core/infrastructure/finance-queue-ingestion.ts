import prisma from "../../../config/prismaClient";
import { FinanceService } from "../application/finance.service";
import { financeConflict } from "../domain/finance.errors";
import { ingestAcceptedCashOutbox } from "./cash-finance-authority";
import { prismaFinanceRepository } from "./prisma-finance.repository";

const service = new FinanceService(prismaFinanceRepository);
/** Redis carries a durable event identifier only; all business fields are ignored. */
export async function ingestDurableFinanceEnvelope(envelope: { id?: unknown; type?: unknown } | null) {
  if (envelope?.type !== "finance_source_event") return;
  if (typeof envelope.id !== "string" || envelope.id.length > 200 || !envelope.id.startsWith("finance:")) {
    throw financeConflict("Durable finance outbox identifier required", "FINANCE_OUTBOX_BINDING_REJECTED");
  }
  if (envelope.id.startsWith("finance:cash:")) return ingestAcceptedCashOutbox(envelope.id);
  const outbox = await prisma.analyticsDomainEventOutbox.findUnique({ where: { eventId: envelope.id } });
  const payload = outbox?.payload as any;
  if (!outbox || outbox.type !== "finance_source_event" || outbox.eventId !== `finance:${payload?.sourceEventId}` ||
      outbox.tenantScope !== `company:${payload?.companyId}` || payload?.sourceType === "cash_custody") {
    throw financeConflict("Durable finance outbox binding rejected", "FINANCE_OUTBOX_BINDING_REJECTED");
  }
  // Non-cash source policies are unchanged; they now use their existing committed outbox.
  return service.ingestSourceEvent(payload);
}
