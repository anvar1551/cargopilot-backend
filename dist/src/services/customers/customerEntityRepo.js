"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.listCustomerEntities = listCustomerEntities;
exports.createCustomerEntity = createCustomerEntity;
exports.getCustomerEntityById = getCustomerEntityById;
const prismaClient_1 = __importDefault(require("../../config/prismaClient"));
async function listCustomerEntities(params) {
    const q = params?.q?.trim();
    const type = params?.type;
    const page = params?.page ?? 1;
    const limit = Math.min(params?.limit ?? 20, 100);
    const skip = (page - 1) * limit;
    const where = {};
    if (type) {
        where.type = type;
    }
    if (q) {
        where.OR = [
            { name: { contains: q, mode: "insensitive" } },
            { companyName: { contains: q, mode: "insensitive" } },
            { email: { contains: q, mode: "insensitive" } },
            { phone: { contains: q, mode: "insensitive" } },
            { taxId: { contains: q, mode: "insensitive" } },
        ];
    }
    const [rows, total] = await prismaClient_1.default.$transaction([
        prismaClient_1.default.customerEntity.findMany({
            where,
            include: {
                defaultAddress: true,
                _count: {
                    select: {
                        orders: true,
                        users: true,
                        addresses: true,
                    },
                },
            },
            orderBy: { createdAt: "desc" },
            skip,
            take: limit,
        }),
        prismaClient_1.default.customerEntity.count({ where }),
    ]);
    return {
        data: rows,
        total,
        page,
        limit,
        pageCount: Math.ceil(total / limit),
    };
}
async function createCustomerEntity(dto) {
    return prismaClient_1.default.customerEntity.create({
        data: {
            type: dto.type,
            name: dto.name,
            email: dto.email ?? null,
            phone: dto.phone ?? null,
            altPhone1: dto.altPhone1 ?? null,
            altPhone2: dto.altPhone2 ?? null,
            companyName: dto.companyName ?? null,
            taxId: dto.taxId ?? null,
        },
        include: {
            defaultAddress: true,
            _count: {
                select: {
                    orders: true,
                    users: true,
                    addresses: true,
                },
            },
        },
    });
}
async function getCustomerEntityById(id) {
    return prismaClient_1.default.customerEntity.findUnique({
        where: { id },
        include: {
            defaultAddress: true,
            addresses: {
                where: { isSaved: true },
                orderBy: { createdAt: "desc" },
                take: 8,
            },
            _count: {
                select: {
                    orders: true,
                    users: true,
                    addresses: true,
                },
            },
        },
    });
}
