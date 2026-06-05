export type IntegrationEventType =
  | "order.created"
  | "order.status.changed"
  | "shipment.assigned"
  | "shipment.delivered"
  | "payment.intent.created"
  | "payment.paid"
  | "support.ticket.created"
  | "sms.delivery.updated"
  | "carrier.status.updated";

export type IntegrationEventEnvelope = {
  eventId: string;
  eventType: IntegrationEventType;
  occurredAt: string;
  companyId: string;
  aggregateType: "order" | "payment_intent" | "support_ticket" | "shipment";
  aggregateId: string;
  payload: Record<string, unknown>;
  schemaVersion: number;
  source: "orders-core" | "payments-core" | "support-core" | "carrier-webhook" | "sms-webhook";
};
