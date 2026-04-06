"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.listAllDrivers = void 0;
const prismaClient_1 = __importDefault(require("../../config/prismaClient"));
const listAllDrivers = async () => {
    return await prismaClient_1.default.user.findMany({
        where: { role: "driver" },
        select: { id: true, name: true, email: true, role: true },
    });
};
exports.listAllDrivers = listAllDrivers;
