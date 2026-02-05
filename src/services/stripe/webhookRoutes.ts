import { Request, Response, Router, raw } from "express";
import { stripe } from "../../config/stripe";
import prisma from "../../config/prismaClient";
import { generateInvoicePDF } from "../../utils/pdfGenerator";
import { generateLabelPDF } from "../../features/label/labelService";
import { uploadLabel } from "../../utils/uploadLabel";
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

    if (event.type === "checkout.session.completed") {
      const session = event.data.object as any;

      // Prefer metadata (more reliable). Fall back to parsing success_url.
      const invoiceId =
        session.metadata?.invoiceId ||
        session.success_url?.split("invoice=")[1];

      if (invoiceId) {
        try {
          const updatedInvoice = await prisma.invoice.update({
            where: { id: invoiceId },
            data: { status: "paid" },
            include: { customer: true, order: true },
          });
          console.log("✅ Invoice marked as paid:", invoiceId);

          // 1️⃣ Generate invoice PDF
          const invoicePdfPath = await generateInvoicePDF({
            invoiceId: updatedInvoice.id,
            orderId: updatedInvoice.orderId,
            customerEmail:
              updatedInvoice.customer?.email ?? updatedInvoice.customerId,
            amount: updatedInvoice.amount,
            createdAt: updatedInvoice.createdAt,
          });

          const { key: invoiceKey } = await uploadInvoice(
            `${updatedInvoice.id}.pdf`,
          );

          // 2️⃣ Generate shipping label
          //     const labelPdfPath = await generateLabelPDF({
          //   parcelCode: updatedInvoice.order.parcelCode,
          //   pieceNo: updatedInvoice.order.pieceNo,
          //   pieceTotal: updatedInvoice.order.pieceTotal,

          //   pickupAddress: updatedInvoice.order.pickupAddress,
          //   dropoffAddress: updatedInvoice.order.dropoffAddress,
          //   destinationCity: updatedInvoice.order.destinationCity ?? undefined,
          //   weightKg: updatedInvoice.order.weightKg ?? updatedInvoice.order.weightKg ?? undefined,
          //   serviceType: updatedInvoice.order.serviceType ?? undefined,
          //   senderName: updatedInvoice.order.senderName ?? undefined,
          //   senderPhone: updatedInvoice.order.senderPhone ?? undefined,
          //   receiverName: updatedInvoice.order.receiverName ?? undefined,
          //   receiverPhone: updatedInvoice.order.receiverPhone ?? undefined,
          // });

          const { key: labelKey } = await uploadLabel(
            `${updatedInvoice.order.id}.pdf`,
          );

          // 3️⃣ Save URLs
          await prisma.$transaction([
            prisma.invoice.update({
              where: { id: updatedInvoice.id },
              data: { invoiceKey }, // or invoiceUrl: invoiceKey (temp)
            }),
            prisma.order.update({
              where: { id: updatedInvoice.order.id },
              data: {
                labelKey, // or labelUrl: labelKey (temp)
                status: "pending",
                tracking: {
                  create: {
                    status: "pending",
                    region: null,
                    warehouseId: null,
                  },
                },
              },
            }),
          ]);
        } catch (dbErr: any) {
          console.error("❌ Failed to update invoice:", dbErr.message || dbErr);
        }
      } else {
        console.warn(
          "⚠️ checkout.session.completed received but no invoiceId found on session:",
          {
            sessionId: session.id,
            metadata: session.metadata,
            success_url: session.success_url,
          },
        );
      }
    }

    // Respond quickly
    res.json({ received: true });
  } catch (err: any) {
    console.error("❌ Webhook error:", err.message);
    res.status(400).send(`Webhook Error: ${err.message}`);
  }
});

export default router;
