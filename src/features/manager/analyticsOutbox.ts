import {
  buildCargoPilotDomainEvent,
  type CargoPilotDomainEvent,
} from "./analyticsEvents";

type DomainEventInput = Omit<CargoPilotDomainEvent, "id" | "occurredAt" | "schemaVersion"> & {
  id?: string;
  occurredAt?: string;
};

function toOutboxCreateInput(event: CargoPilotDomainEvent) {
  return {
    eventId: event.id,
    type: event.type,
    tenantScope: event.tenantScope,
    entityId: event.entityId ?? null,
    schemaVersion: event.schemaVersion,
    occurredAt: new Date(event.occurredAt),
    payload: event.payload as any,
  };
}

export function buildOutboxDomainEvent(input: DomainEventInput) {
  return buildCargoPilotDomainEvent(input);
}

export async function enqueueCargoPilotDomainEventTx(
  tx: any,
  input: DomainEventInput,
) {
  const event = buildOutboxDomainEvent(input);
  await tx.analyticsDomainEventOutbox.create({
    data: toOutboxCreateInput(event),
  });
  return event;
}

export async function enqueueCargoPilotDomainEventsTx(
  tx: any,
  inputs: DomainEventInput[],
) {
  if (!inputs.length) return [];
  const events = inputs.map(buildOutboxDomainEvent);
  await tx.analyticsDomainEventOutbox.createMany({
    data: events.map(toOutboxCreateInput),
  });
  return events;
}
