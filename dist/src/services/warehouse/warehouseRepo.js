"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getWarehouseById = exports.listWarehouses = exports.updateWarehouse = exports.createWarehouse = void 0;
const prismaClient_1 = __importDefault(require("../../config/prismaClient"));
const createWarehouse = async (name, type, location, region) => {
    return prismaClient_1.default.warehouse.create({
        data: {
            name,
            type,
            location,
            region: region ?? null,
        },
    });
};
exports.createWarehouse = createWarehouse;
const updateWarehouse = async (id, args) => {
    return prismaClient_1.default.warehouse.update({
        where: { id },
        data: {
            name: args.name,
            type: args.type,
            location: args.location,
            region: args.region ?? null,
        },
    });
};
exports.updateWarehouse = updateWarehouse;
const listWarehouses = async () => {
    return prismaClient_1.default.warehouse.findMany({
        orderBy: { createdAt: "desc" },
    });
};
exports.listWarehouses = listWarehouses;
const getWarehouseById = async (id) => {
    return prismaClient_1.default.warehouse.findUnique({
        where: { id },
        include: {
            users: true,
            orders: true,
        },
    });
};
exports.getWarehouseById = getWarehouseById;
