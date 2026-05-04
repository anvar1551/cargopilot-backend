"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildOutboxDomainEvent = buildOutboxDomainEvent;
exports.enqueueCargoPilotDomainEventTx = enqueueCargoPilotDomainEventTx;
exports.enqueueCargoPilotDomainEventsTx = enqueueCargoPilotDomainEventsTx;
const analyticsEvents_1 = require("./analyticsEvents");
function toOutboxCreateInput(event) {
    return {
        eventId: event.id,
        type: event.type,
        tenantScope: event.tenantScope,
        entityId: event.entityId ?? null,
        schemaVersion: event.schemaVersion,
        occurredAt: new Date(event.occurredAt),
        payload: event.payload,
    };
}
function buildOutboxDomainEvent(input) {
    return (0, analyticsEvents_1.buildCargoPilotDomainEvent)(input);
}
async function enqueueCargoPilotDomainEventTx(tx, input) {
    const event = buildOutboxDomainEvent(input);
    await tx.analyticsDomainEventOutbox.create({
        data: toOutboxCreateInput(event),
    });
    return event;
}
async function enqueueCargoPilotDomainEventsTx(tx, inputs) {
    if (!inputs.length)
        return [];
    const events = inputs.map(buildOutboxDomainEvent);
    await tx.analyticsDomainEventOutbox.createMany({
        data: events.map(toOutboxCreateInput),
    });
    return events;
}
