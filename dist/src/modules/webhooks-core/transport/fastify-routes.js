"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const prismaClient_1 = __importDefault(require("../../../config/prismaClient"));
const stripe_1 = require("../../../config/stripe");
const pdfGenerator_1 = require("../../../utils/pdfGenerator");
const uploadInvoice_1 = require("../../../utils/uploadInvoice");
const webhooksFastifyRoutes = async (fastify) => {
    fastify.removeAllContentTypeParsers();
    fastify.addContentTypeParser("*", { parseAs: "buffer" }, (_req, body, done) => {
        done(null, body);
    });
    fastify.post("/stripe", async (request, reply) => {
        const sig = String(request.headers["stripe-signature"] || "").trim();
        if (!sig) {
            return reply.code(400).send("Webhook Error: Missing stripe signature");
        }
        try {
            const stripe = (0, stripe_1.requireStripe)();
            const bodyBuffer = Buffer.isBuffer(request.body)
                ? request.body
                : Buffer.from(String(request.body ?? ""));
            const event = stripe.webhooks.constructEvent(bodyBuffer, sig, process.env.STRIPE_WEBHOOK_SECRET);
            if (event.type !== "checkout.session.completed") {
                return reply.send({ received: true });
            }
            const session = event.data.object;
            const invoiceId = session.metadata?.invoiceId || session.success_url?.split("invoice=")[1];
            if (!invoiceId)
                return reply.send({ received: true });
            const existing = await prismaClient_1.default.invoice.findUnique({
                where: { id: invoiceId },
                select: { id: true, status: true, invoiceKey: true },
            });
            if (!existing)
                return reply.send({ received: true });
            if (existing.status === "paid" && existing.invoiceKey) {
                return reply.send({ received: true });
            }
            const updatedInvoice = await prismaClient_1.default.invoice.update({
                where: { id: invoiceId },
                data: { status: "paid" },
                include: { customer: true, order: true },
            });
            await (0, pdfGenerator_1.generateInvoicePDF)({
                invoiceId: updatedInvoice.id,
                orderId: updatedInvoice.orderId,
                customerEmail: updatedInvoice.customer?.email ?? updatedInvoice.customerId,
                amount: updatedInvoice.amount,
                createdAt: updatedInvoice.createdAt,
            });
            const { key: invoiceKey } = await (0, uploadInvoice_1.uploadInvoice)(`${updatedInvoice.id}.pdf`);
            await prismaClient_1.default.invoice.update({
                where: { id: updatedInvoice.id },
                data: { invoiceKey },
            });
            return reply.send({ received: true });
        }
        catch (err) {
            console.error("[webhooks] stripe webhook error:", err?.message || err);
            return reply.code(400).send(`Webhook Error: ${err?.message || "unknown"}`);
        }
    });
};
exports.default = webhooksFastifyRoutes;
