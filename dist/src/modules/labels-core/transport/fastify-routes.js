"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const prismaClient_1 = __importDefault(require("../../../config/prismaClient"));
const fastify_auth_1 = require("../../../modules/identity-access/transport/fastify-auth");
const identity_access_1 = require("../../identity-access");
const s3Presign_1 = require("../../../utils/s3Presign");
const labelsFastifyRoutes = async (fastify) => {
    fastify.get("/orders/:id/url", { preHandler: (0, fastify_auth_1.fastifyAuth)({ permission: "shipment.view" }) }, async (request, reply) => {
        try {
            const orderId = String(request.params?.id || "").trim();
            const user = request.user;
            const scopedWhere = await (0, identity_access_1.buildOrderScopeWhere)(user);
            if (!scopedWhere) {
                return reply.code(403).send({ error: "Forbidden" });
            }
            const order = await prismaClient_1.default.order.findFirst({
                where: { id: orderId, ...scopedWhere },
                select: {
                    id: true,
                    customerId: true,
                    customerEntityId: true,
                    assignedDriverId: true,
                    currentWarehouseId: true,
                    labelKey: true,
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
                return reply.code(404).send({ error: "Order not found" });
            const parcelLabels = order.parcels.filter((p) => Boolean(p.labelKey));
            if (parcelLabels.length === 0 && order.labelKey) {
                const url = await (0, s3Presign_1.presignGetObject)(order.labelKey, 300);
                return reply.send({ url });
            }
            if (parcelLabels.length === 0) {
                return reply.code(404).send({ error: "Label not available yet" });
            }
            const urls = await Promise.all(parcelLabels.map(async (parcel) => ({
                parcelId: parcel.id,
                parcelCode: parcel.parcelCode,
                pieceNo: parcel.pieceNo,
                pieceTotal: parcel.pieceTotal,
                url: await (0, s3Presign_1.presignGetObject)(parcel.labelKey, 300),
            })));
            return reply.send({ url: urls[0].url, urls });
        }
        catch (err) {
            return reply.code(500).send({ error: err?.message || "Failed to load label" });
        }
    });
};
exports.default = labelsFastifyRoutes;
