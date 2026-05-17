import { FastifyPluginAsync } from "fastify";
import prisma from "../../../config/prismaClient";
import { requireStripe } from "../../../config/stripe";
import { generateInvoicePDF } from "../../../utils/pdfGenerator";
import { uploadInvoice } from "../../../utils/uploadInvoice";

const webhooksFastifyRoutes: FastifyPluginAsync = async (fastify) => {
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
      const stripe = requireStripe();
      const bodyBuffer = Buffer.isBuffer(request.body)
        ? request.body
        : Buffer.from(String(request.body ?? ""));

      const event = stripe.webhooks.constructEvent(
        bodyBuffer,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET!,
      );

      if (event.type !== "checkout.session.completed") {
        return reply.send({ received: true });
      }

      const session = event.data.object as any;
      const invoiceId = session.metadata?.invoiceId || session.success_url?.split("invoice=")[1];
      if (!invoiceId) return reply.send({ received: true });

      const existing = await prisma.invoice.findUnique({
        where: { id: invoiceId },
        select: { id: true, status: true, invoiceKey: true },
      });
      if (!existing) return reply.send({ received: true });
      if (existing.status === "paid" && existing.invoiceKey) {
        return reply.send({ received: true });
      }

      const updatedInvoice = await prisma.invoice.update({
        where: { id: invoiceId },
        data: { status: "paid" },
        include: { customer: true, order: true },
      });

      await generateInvoicePDF({
        invoiceId: updatedInvoice.id,
        orderId: updatedInvoice.orderId,
        customerEmail: updatedInvoice.customer?.email ?? updatedInvoice.customerId,
        amount: updatedInvoice.amount,
        createdAt: updatedInvoice.createdAt,
      });

      const { key: invoiceKey } = await uploadInvoice(`${updatedInvoice.id}.pdf`);
      await prisma.invoice.update({
        where: { id: updatedInvoice.id },
        data: { invoiceKey },
      });

      return reply.send({ received: true });
    } catch (err: any) {
      console.error("[webhooks] stripe webhook error:", err?.message || err);
      return reply.code(400).send(`Webhook Error: ${err?.message || "unknown"}`);
    }
  });
};

export default webhooksFastifyRoutes;
