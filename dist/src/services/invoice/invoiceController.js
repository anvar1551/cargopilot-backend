"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getInvoicePdfUrl = getInvoicePdfUrl;
const prismaClient_1 = __importDefault(require("../../config/prismaClient"));
const s3Presign_1 = require("../../utils/s3Presign");
async function getInvoicePdfUrl(req, res) {
    const idParam = req.params.id;
    const user = req.user; // from auth middleware
    // Primary lookup by orderId because route is /orders/:id/url.
    // Fallback to invoice id for backward compatibility.
    let invoice = await prismaClient_1.default.invoice.findUnique({
        where: { orderId: idParam },
        include: { order: true },
    });
    if (!invoice) {
        invoice = await prismaClient_1.default.invoice.findUnique({
            where: { id: idParam },
            include: { order: true },
        });
    }
    if (!invoice)
        return res.status(404).json({ error: "Invoice not found" });
    if (!invoice.invoiceKey)
        return res.status(404).json({ error: "Invoice PDF not available yet" });
    // Authorization:
    // - manager can access all
    // - customer can access only their own invoice
    if (user.role !== "manager" && invoice.customerId !== user.id) {
        return res.status(403).json({ error: "Forbidden" });
    }
    const url = await (0, s3Presign_1.presignGetObject)(invoice.invoiceKey, 60 * 5);
    return res.json({ url });
}
