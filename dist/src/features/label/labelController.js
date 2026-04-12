"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getLabelPdfUrl = getLabelPdfUrl;
const prismaClient_1 = __importDefault(require("../../config/prismaClient"));
const s3Presign_1 = require("../../utils/s3Presign");
async function getLabelPdfUrl(req, res) {
    const orderId = req.params.id;
    const user = req.user;
    const order = await prismaClient_1.default.order.findUnique({
        where: { id: orderId },
        select: {
            id: true,
            customerId: true,
            customerEntityId: true,
            assignedDriverId: true,
            currentWarehouseId: true,
            labelKey: true, // legacy fallback
            parcels: {
                select: {
                    id: true,
                    pieceNo: true,
                    pieceTotal: true,
                    parcelCode: true,
                    labelKey: true,
                },
                orderBy: { pieceNo: "asc" },
            },
        },
    });
    if (!order)
        return res.status(404).json({ error: "Order not found" });
    if (user.role === "manager") {
        // allowed
    }
    else if (user.role === "customer" &&
        !((user.customerEntityId && order.customerEntityId === user.customerEntityId) ||
            order.customerId === user.id)) {
        return res.status(403).json({ error: "Forbidden" });
    }
    else if (user.role === "driver" && order.assignedDriverId !== user.id) {
        return res.status(403).json({ error: "Forbidden" });
    }
    else if (user.role === "warehouse") {
        // Optional strict warehouse check can be added here.
    }
    const parcelLabels = order.parcels.filter((p) => Boolean(p.labelKey));
    // Backward-compatible fallback for older rows that stored order-level labelKey.
    if (parcelLabels.length === 0 && order.labelKey) {
        const url = await (0, s3Presign_1.presignGetObject)(order.labelKey, 300);
        return res.json({ url });
    }
    if (parcelLabels.length === 0) {
        return res.status(404).json({ error: "Label not available yet" });
    }
    const urls = await Promise.all(parcelLabels.map(async (parcel) => ({
        parcelId: parcel.id,
        parcelCode: parcel.parcelCode,
        pieceNo: parcel.pieceNo,
        pieceTotal: parcel.pieceTotal,
        url: await (0, s3Presign_1.presignGetObject)(parcel.labelKey, 300),
    })));
    // Keep `url` for backward compatibility when consumers expect a single string.
    return res.json({ url: urls[0].url, urls });
}
