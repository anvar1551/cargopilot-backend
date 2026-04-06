"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getNextOrderNumber = getNextOrderNumber;
const prismaClient_1 = __importDefault(require("../config/prismaClient"));
async function getNextOrderNumber() {
    // one row in Counter: { key: "orderNumber", value: 0 }
    const counter = await prismaClient_1.default.counter.upsert({
        where: { key: "orderNumber" },
        update: { value: { increment: 1 } },
        create: { key: "orderNumber", value: 1 },
    });
    // Example format: 99 + 6 digits => 99000001
    const seq = String(counter.value).padStart(10, "0");
    return `99${seq}`;
}
