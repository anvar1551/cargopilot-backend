import prisma from "../../config/prismaClient";
import { stripe } from "../../config/stripe";

export const createStripePayment = async (
  orderId: string,
  invoiceId: string,
  amount: number,
  email: string
) => {
  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    payment_method_types: ["card"],
    customer_email: email,
    line_items: [
      {
        price_data: {
          currency: "eur",
          product_data: { name: "Cargopilot shipment" },
          unit_amount: Math.round(amount * 100),
        },
        quantity: 1,
      },
    ],
    metadata: {
      invoiceId,
      orderId,
    },
    success_url: `${process.env.CLIENT_URL}/dashboard/customer/orders/${orderId}?payment=success`,
    cancel_url: `${process.env.CLIENT_URL}/dashboard/customer/orders/${orderId}?payment=cancel`,
    // include invoiceId in metadata so webhooks can reliably access it
  });

  // Debug: log the created session id so you can match it with webhook events
  try {
    console.log("Stripe checkout session created:", {
      id: session.id,
      metadata: session.metadata,
    });
  } catch (e) {
    // ignore logging errors
  }

  return session.url;
};

export const createInvoice = async (
  orderId: string,
  customerId: string,
  amount: number
) => {
  return await prisma.invoice.create({
    data: {
      orderId,
      customerId,
      amount,
    },
  });
};

export const getInvoiceByOrder = async (orderId: string) => {
  return prisma.invoice.findUnique({
    where: { orderId },
  });
};

export const listInvoice = async () => {
  return prisma.invoice.findMany({
    orderBy: { createdAt: "desc" },
  });
};

export const markAsPaid = async (invoiceId: string) => {
  return prisma.invoice.update({
    where: { id: invoiceId },
    data: { status: "paid" },
  });
};
