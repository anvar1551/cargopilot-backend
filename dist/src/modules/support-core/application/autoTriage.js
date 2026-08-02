"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createSystemSupportTicket = createSystemSupportTicket;
exports.createCarrierFailureSupportTicket = createCarrierFailureSupportTicket;
exports.createPaymentFailureSupportTicket = createPaymentFailureSupportTicket;
exports.createPaymentWebhookSupportTicket = createPaymentWebhookSupportTicket;
exports.createLabelFailureSupportTicket = createLabelFailureSupportTicket;
const client_1 = require("@prisma/client");
const supportService_1 = require("./supportService");
const systemActor = {
    id: "",
    permissionCodes: [],
    name: "CargoPilot Auto Triage",
    email: "system@cargopilot.local",
};
function trim(value, max = 1000) {
    return String(value ?? "").trim().slice(0, max);
}
function normalizeSourceKeyPart(value) {
    return trim(value, 160).replace(/[^a-zA-Z0-9_.:-]+/g, "_") || "unknown";
}
async function createSystemSupportTicket(input) {
    if (process.env.SUPPORT_AUTO_TRIAGE_ENABLED === "false")
        return null;
    return (0, supportService_1.createSupportTicket)({
        orderId: input.orderId ?? null,
        orderNumber: input.orderNumber ?? null,
        companyId: input.companyId ?? null,
        title: trim(input.title, 240),
        summary: input.summary ? trim(input.summary, 2000) : null,
        priority: input.priority ?? client_1.SupportTicketPriority.high,
        source: client_1.SupportTicketSource.system_alert,
        sourceKey: trim(input.sourceKey, 500),
        routingKey: input.routingKey ? trim(input.routingKey, 80) : null,
    }, systemActor).catch((err) => {
        console.error(`[support-auto-triage] ticket creation failed: ${err?.message || "unknown"}`);
        return null;
    });
}
async function createCarrierFailureSupportTicket(input) {
    const provider = normalizeSourceKeyPart(input.providerCode);
    const status = normalizeSourceKeyPart(input.status || (input.terminal ? "terminal_failure" : "booking_failed"));
    const sourceKey = `carrier:${input.terminal ? "status" : "booking"}:${input.legId}:${provider}:${status}:v1`;
    const title = input.terminal
        ? "Carrier reported shipment exception"
        : "Carrier booking failed";
    const summary = [
        `Provider: ${input.providerCode || "-"}`,
        `Leg ID: ${input.legId}`,
        input.status ? `Status: ${input.status}` : null,
        input.reason ? `Reason: ${input.reason}` : null,
    ].filter(Boolean).join("\n");
    return createSystemSupportTicket({
        sourceKey,
        orderId: input.orderId,
        title,
        summary,
        priority: input.terminal ? client_1.SupportTicketPriority.urgent : client_1.SupportTicketPriority.high,
        routingKey: "carrier",
    });
}
async function createPaymentFailureSupportTicket(input) {
    const status = normalizeSourceKeyPart(input.status || "failed");
    const sourceKey = `payment:intent:${input.paymentIntentId || input.orderId}:${input.provider}:${status}:v1`;
    return createSystemSupportTicket({
        sourceKey,
        orderId: input.orderId,
        companyId: input.companyId ?? null,
        title: "Online payment needs support attention",
        summary: [
            `Provider: ${input.provider}`,
            input.environment ? `Environment: ${input.environment}` : null,
            input.paymentIntentId ? `Payment intent: ${input.paymentIntentId}` : null,
            input.status ? `Status: ${input.status}` : null,
            input.reason ? `Reason: ${input.reason}` : null,
        ].filter(Boolean).join("\n"),
        priority: client_1.SupportTicketPriority.high,
        routingKey: "payment",
    });
}
async function createPaymentWebhookSupportTicket(input) {
    const sourceKey = `payment:webhook:${input.provider}:${input.environment}:${normalizeSourceKeyPart(input.idempotencyKey)}:v1`;
    return createSystemSupportTicket({
        sourceKey,
        companyId: input.companyId ?? null,
        title: "Payment webhook rejected",
        summary: [
            `Provider: ${input.provider}`,
            `Environment: ${input.environment}`,
            input.paymentIntentId ? `Payment intent: ${input.paymentIntentId}` : null,
            `Webhook key: ${input.idempotencyKey}`,
            `Reason: ${input.reason}`,
        ].filter(Boolean).join("\n"),
        priority: client_1.SupportTicketPriority.urgent,
        routingKey: "payment",
    });
}
async function createLabelFailureSupportTicket(input) {
    const sourceKey = input.exhausted
        ? `label:failed:${input.orderId}:exhausted:v1`
        : `label:failed:${input.orderId}:inline:v1`;
    return createSystemSupportTicket({
        sourceKey,
        orderId: input.orderId,
        title: input.exhausted ? "Shipping label generation exhausted retries" : "Shipping label generation failed",
        summary: [
            input.jobId ? `Label job: ${input.jobId}` : null,
            input.reason ? `Reason: ${input.reason}` : null,
        ].filter(Boolean).join("\n"),
        priority: input.exhausted ? client_1.SupportTicketPriority.urgent : client_1.SupportTicketPriority.high,
        routingKey: "label",
    });
}
