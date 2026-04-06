"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const client_1 = require("@prisma/client");
const adapter_pg_1 = require("@prisma/adapter-pg");
const accelerateUrl = process.env.PRISMA_ACCELERATE_URL;
let clientOptions = {};
if (accelerateUrl) {
    clientOptions.accelerateUrl = accelerateUrl;
}
else if (process.env.DATABASE_URL) {
    clientOptions.adapter = new adapter_pg_1.PrismaPg({
        connectionString: process.env.DATABASE_URL,
    });
}
else {
    throw new Error("Prisma requires either PRISMA_ACCELERATE_URL or DATABASE_URL to be set in the environment");
}
const prisma = new client_1.PrismaClient(clientOptions);
exports.default = prisma;
