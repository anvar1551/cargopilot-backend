"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.markAsPaid = exports.listInvoice = exports.getInvoiceByOrder = exports.createInvoice = exports.createStripePayment = void 0;
const prismaClient_1 = __importDefault(require("../../config/prismaClient"));
const stripe_1 = require("../../config/stripe");
const createStripePayment = async (orderId, invoiceId, amount, email) => {
    const stripe = (0, stripe_1.requireStripe)();
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
    }
    catch (e) {
        // ignore logging errors
    }
    return session.url;
};
exports.createStripePayment = createStripePayment;
const createInvoice = async (orderId, customerId, amount) => {
    return await prismaClient_1.default.invoice.create({
        data: {
            orderId,
            customerId,
            amount,
        },
    });
};
exports.createInvoice = createInvoice;
const getInvoiceByOrder = async (orderId) => {
    return prismaClient_1.default.invoice.findUnique({
        where: { orderId },
    });
};
exports.getInvoiceByOrder = getInvoiceByOrder;
const listInvoice = async () => {
    return prismaClient_1.default.invoice.findMany({
        orderBy: { createdAt: "desc" },
    });
};
exports.listInvoice = listInvoice;
const markAsPaid = async (invoiceId) => {
    return prismaClient_1.default.invoice.update({
        where: { id: invoiceId },
        data: { status: "paid" },
    });
};
exports.markAsPaid = markAsPaid;
