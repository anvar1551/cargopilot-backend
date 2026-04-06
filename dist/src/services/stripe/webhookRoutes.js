"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const stripe_1 = require("../../config/stripe");
const prismaClient_1 = __importDefault(require("../../config/prismaClient"));
const pdfGenerator_1 = require("../../utils/pdfGenerator");
const uploadInvoice_1 = require("../../utils/uploadInvoice");
const router = (0, express_1.Router)();
// ⚠️ Stripe requires raw body, not parsed JSON
router.post("/stripe", (0, express_1.raw)({ type: "application/json" }), async (req, res) => {
    const sig = req.headers["stripe-signature"];
    try {
        const event = stripe_1.stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
        console.log("Stripe event received:", { id: event.id, type: event.type });
        // Respond quickly to Stripe no matter what.
        // We'll still await processing, but keep code efficient.
        if (event.type !== "checkout.session.completed") {
            return res.json({ received: true });
        }
        const session = event.data.object;
        // Prefer metadata (recommended). Fall back to parsing success_url.
        const invoiceId = session.metadata?.invoiceId || session.success_url?.split("invoice=")[1];
        if (!invoiceId) {
            console.warn("checkout.session.completed but no invoiceId found", {
                sessionId: session.id,
                metadata: session.metadata,
                success_url: session.success_url,
            });
            return res.json({ received: true });
        }
        // ✅ Make webhook idempotent:
        // If already paid + invoiceKey exists, do nothing.
        const existing = await prismaClient_1.default.invoice.findUnique({
            where: { id: invoiceId },
            select: { id: true, status: true, invoiceKey: true, orderId: true },
        });
        if (!existing) {
            console.warn("Invoice not found:", invoiceId);
            return res.json({ received: true });
        }
        if (existing.status === "paid" && existing.invoiceKey) {
            console.log("Webhook duplicate: invoice already processed:", invoiceId);
            return res.json({ received: true });
        }
        // Mark invoice paid (and fetch needed data)
        const updatedInvoice = await prismaClient_1.default.invoice.update({
            where: { id: invoiceId },
            data: { status: "paid" },
            include: { customer: true, order: true },
        });
        console.log("✅ Invoice marked as paid:", invoiceId);
        // 1️⃣ Generate invoice PDF (local file)
        await (0, pdfGenerator_1.generateInvoicePDF)({
            invoiceId: updatedInvoice.id,
            orderId: updatedInvoice.orderId,
            customerEmail: updatedInvoice.customer?.email ?? updatedInvoice.customerId,
            amount: updatedInvoice.amount,
            createdAt: updatedInvoice.createdAt,
        });
        // 2️⃣ Upload invoice PDF to S3
        const { key: invoiceKey } = await (0, uploadInvoice_1.uploadInvoice)(`${updatedInvoice.id}.pdf`);
        // 3️⃣ Save invoiceKey
        await prismaClient_1.default.invoice.update({
            where: { id: updatedInvoice.id },
            data: { invoiceKey },
        });
        // ✅ Labels are already generated in createOrder (Option B) per parcel.
        // So webhook should NOT upload labels anymore.
        return res.json({ received: true });
    }
    catch (err) {
        console.error("❌ Webhook error:", err.message || err);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }
});
exports.default = router;
