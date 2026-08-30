import { Prisma } from "@prisma/client";
import {
  financeSourceEventHash,
  normalizeFinanceSourceEvent,
  type CanonicalFinanceSourceEventInput,
} from "../domain/source-event";

export async function createFinanceSourceEvent(
  tx: Prisma.TransactionClient,
  legalEntityId: string,
  input: CanonicalFinanceSourceEventInput,
) {
  const event = normalizeFinanceSourceEvent(input);
  return tx.financeSourceEvent.create({
    data: {
      companyId: event.companyId,
      legalEntityId,
      sourceEventId: event.sourceEventId,
      sourceType: event.sourceType,
      eventType: event.eventType,
      sourceId: event.sourceId,
      schemaVersion: event.schemaVersion,
      status: "pending",
      occurredAt: event.occurredAt,
      postingDate: event.postingDate,
      payloadHash: financeSourceEventHash(event),
      payloadJson: JSON.parse(JSON.stringify(event)) as Prisma.InputJsonValue,
    },
  });
}
