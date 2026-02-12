import { Router, raw } from "express";
import { stripe } from "../../config/stripe";
import prisma from "../../config/prismaClient";
import { generateInvoicePDF } from "../../utils/pdfGenerator";
import { uploadInvoice } from "../../utils/uploadInvoice";

const router = Router();

// ⚠️ Stripe requires raw body, not parsed JSON
router.post("/stripe", raw({ type: "application/json" }), async (req, res) => {
  const sig = req.headers["stripe-signature"] as string;

  try {
    const event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET!,
    );

    console.log("Stripe event received:", { id: event.id, type: event.type });

    // Respond quickly to Stripe no matter what.
    // We'll still await processing, but keep code efficient.
    if (event.type !== "checkout.session.completed") {
      return res.json({ received: true });
    }

    const session = event.data.object as any;

    // Prefer metadata (recommended). Fall back to parsing success_url.
    const invoiceId =
      session.metadata?.invoiceId || session.success_url?.split("invoice=")[1];

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
    const existing = await prisma.invoice.findUnique({
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
    const updatedInvoice = await prisma.invoice.update({
      where: { id: invoiceId },
      data: { status: "paid" },
      include: { customer: true, order: true },
    });

    console.log("✅ Invoice marked as paid:", invoiceId);

    // 1️⃣ Generate invoice PDF (local file)
    await generateInvoicePDF({
      invoiceId: updatedInvoice.id,
      orderId: updatedInvoice.orderId,
      customerEmail:
        updatedInvoice.customer?.email ?? updatedInvoice.customerId,
      amount: updatedInvoice.amount,
      createdAt: updatedInvoice.createdAt,
    });

    // 2️⃣ Upload invoice PDF to S3
    const { key: invoiceKey } = await uploadInvoice(`${updatedInvoice.id}.pdf`);

    // 3️⃣ Save invoiceKey
    await prisma.invoice.update({
      where: { id: updatedInvoice.id },
      data: { invoiceKey },
    });

    // ✅ Labels are already generated in createOrder (Option B) per parcel.
    // So webhook should NOT upload labels anymore.

    return res.json({ received: true });
  } catch (err: any) {
    console.error("❌ Webhook error:", err.message || err);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }
});

export default router;
