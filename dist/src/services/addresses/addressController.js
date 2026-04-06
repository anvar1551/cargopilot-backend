"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.list = list;
exports.create = create;
const client_1 = require("@prisma/client");
const addressRepo_1 = require("./addressRepo");
const prismaClient_1 = __importDefault(require("../../config/prismaClient"));
const zod_1 = require("zod");
async function list(req, res) {
    try {
        if (!req.user?.id)
            return res.status(401).json({ error: "Unauthorized" });
        const role = req.user.role;
        if (role !== client_1.AppRole.manager && role !== client_1.AppRole.customer) {
            return res.status(403).json({ error: "Forbidden" });
        }
        const q = typeof req.query.q === "string" ? req.query.q : undefined;
        const take = req.query.take ? Number(req.query.take) : undefined;
        const queryCustomerEntityId = typeof req.query.customerEntityId === "string"
            ? req.query.customerEntityId
            : undefined;
        const customerEntityId = role === client_1.AppRole.manager
            ? queryCustomerEntityId
            : (req.user.customerEntityId ?? undefined);
        const rows = await (0, addressRepo_1.listAddresses)({
            customerEntityId,
            q,
            take,
        });
        return res.json(rows);
    }
    catch (e) {
        return res
            .status(500)
            .json({ error: e.message ?? "Failed to fetch addresses" });
    }
}
const addressCreateSchema = zod_1.z.object({
    customerEntityId: zod_1.z.string().uuid().optional().nullable(),
    country: zod_1.z.string().optional().nullable(),
    city: zod_1.z.string().optional().nullable(),
    neighborhood: zod_1.z.string().optional().nullable(),
    street: zod_1.z.string().optional().nullable(),
    addressLine1: zod_1.z.string().optional().nullable(),
    addressLine2: zod_1.z.string().optional().nullable(),
    building: zod_1.z.string().optional().nullable(),
    apartment: zod_1.z.string().optional().nullable(),
    floor: zod_1.z.string().optional().nullable(),
    landmark: zod_1.z.string().optional().nullable(),
    postalCode: zod_1.z.string().optional().nullable(),
    addressType: zod_1.z.enum(["RESIDENTIAL", "BUSINESS"]).optional().nullable(),
    isSaved: zod_1.z.boolean().optional().default(true),
});
async function create(req, res) {
    try {
        if (!req.user?.id || !req.user?.role) {
            return res.status(401).json({ error: "Unauthorized" });
        }
        const role = req.user.role;
        if (role !== client_1.AppRole.manager && role !== client_1.AppRole.customer) {
            return res.status(403).json({ error: "Forbidden" });
        }
        const dto = addressCreateSchema.parse(req.body);
        // Managers may specify a target customer entity.
        // Customers can only write into their own customer entity.
        let ownerCustomerEntityId = null;
        if (role === client_1.AppRole.manager) {
            ownerCustomerEntityId =
                dto.customerEntityId ?? req.user.customerEntityId ?? null;
        }
        else {
            const myCustomerEntityId = req.user.customerEntityId ?? null;
            if (dto.customerEntityId && dto.customerEntityId !== myCustomerEntityId) {
                return res.status(403).json({
                    error: "Customers can only create addresses for their own entity",
                });
            }
            ownerCustomerEntityId = myCustomerEntityId;
        }
        if (!ownerCustomerEntityId) {
            return res.status(400).json({
                error: "customerEntityId is required to create an address",
            });
        }
        const created = await prismaClient_1.default.address.create({
            data: {
                customerEntityId: ownerCustomerEntityId,
                country: dto.country ?? null,
                city: dto.city ?? null,
                neighborhood: dto.neighborhood ?? null,
                street: dto.street ?? null,
                addressLine1: dto.addressLine1 ?? null,
                addressLine2: dto.addressLine2 ?? null,
                building: dto.building ?? null,
                apartment: dto.apartment ?? null,
                floor: dto.floor ?? null,
                landmark: dto.landmark ?? null,
                postalCode: dto.postalCode ?? null,
                addressType: dto.addressType ?? null,
                isSaved: dto.isSaved ?? true,
            },
        });
        return res.status(201).json(created);
    }
    catch (err) {
        return res.status(400).json({ error: err?.message ?? "Bad request" });
    }
}
