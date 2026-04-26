"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.deleteUserAsManager = exports.listUsers = exports.createUserAsManager = exports.changeUserPassword = exports.loginUser = exports.registerUser = void 0;
const prismaClient_1 = __importDefault(require("../../config/prismaClient"));
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const bcryptjs_1 = __importDefault(require("bcryptjs"));
const client_1 = require("@prisma/client");
function getJwtSecret() {
    const secret = process.env.JWT_SECRET;
    if (!secret)
        throw new Error("JWT_SECRET not configured");
    return secret;
}
function signToken(payload) {
    return jsonwebtoken_1.default.sign(payload, getJwtSecret(), { expiresIn: "7d" });
}
function safeUser(user) {
    const { password, ...rest } = user;
    return {
        ...rest,
        warehouseId: rest.warehouseId ?? rest.warehouse?.id ?? null,
        customerEntityId: rest.customerEntityId ?? rest.customerEntity?.id ?? null,
        driverType: rest.role === client_1.AppRole.driver
            ? (rest.driverType ?? client_1.DriverType.local)
            : null,
    };
}
const registerUser = async (args) => {
    const name = args.name?.trim();
    const email = args.email?.trim().toLowerCase();
    const password = args.password;
    if (!name)
        throw new Error("Name is required");
    if (!email)
        throw new Error("Email is required");
    if (!password || password.length < 6)
        throw new Error("Password must be at least 6 characters");
    const role = args.role ?? client_1.AppRole.customer;
    // prevent duplicate
    const existing = await prismaClient_1.default.user.findUnique({ where: { email } });
    if (existing)
        throw new Error("Email already registered");
    const hashedPassword = await bcryptjs_1.default.hash(password, 10);
    // Create user (+ customer profile if role=customer)
    const user = await prismaClient_1.default.user.create({
        data: {
            name,
            email,
            password: hashedPassword,
            role,
            ...(role === client_1.AppRole.customer
                ? {
                    customerEntity: {
                        create: {
                            type: args.customerType ?? client_1.CustomerType.PERSON,
                            name: (args.customerType ?? client_1.CustomerType.PERSON) ===
                                client_1.CustomerType.COMPANY
                                ? args.companyName?.trim() || name
                                : name,
                            email,
                            phone: args.phone ?? null,
                        },
                    },
                }
                : {}),
        },
        include: {
            warehouse: true,
            customerEntity: true,
        },
    });
    const token = signToken({
        id: user.id,
        role: user.role,
        warehouseId: user.warehouse?.id ?? null,
        customerEntityId: user.customerEntity?.id ?? null,
    });
    return { token, user: safeUser(user) };
};
exports.registerUser = registerUser;
const loginUser = async (emailRaw, password) => {
    const email = emailRaw?.trim().toLowerCase();
    if (!email)
        throw new Error("Email is required");
    if (!password)
        throw new Error("Password is required");
    const user = await prismaClient_1.default.user.findUnique({
        where: { email },
        include: {
            warehouse: true,
            customerEntity: true,
        },
    });
    if (!user)
        throw new Error("Invalid email or password");
    const validPassword = await bcryptjs_1.default.compare(password, user.password);
    if (!validPassword)
        throw new Error("Invalid email or password");
    const token = signToken({
        id: user.id,
        role: user.role,
        warehouseId: user.warehouse?.id ?? null,
        customerEntityId: user.customerEntity?.id ?? null,
    });
    return { token, user: safeUser(user) };
};
exports.loginUser = loginUser;
const changeUserPassword = async (args) => {
    const userId = args.userId?.trim();
    const currentPassword = args.currentPassword;
    const newPassword = args.newPassword;
    if (!userId)
        throw new Error("User id is required");
    if (!currentPassword)
        throw new Error("Current password is required");
    if (!newPassword || newPassword.length < 6) {
        throw new Error("New password must be at least 6 characters");
    }
    if (currentPassword === newPassword) {
        throw new Error("New password must be different from current password");
    }
    const user = await prismaClient_1.default.user.findUnique({
        where: { id: userId },
        select: { id: true, password: true },
    });
    if (!user)
        throw new Error("User not found");
    const validPassword = await bcryptjs_1.default.compare(currentPassword, user.password);
    if (!validPassword)
        throw new Error("Current password is incorrect");
    const hashedPassword = await bcryptjs_1.default.hash(newPassword, 10);
    await prismaClient_1.default.user.update({
        where: { id: userId },
        data: { password: hashedPassword },
    });
    return { success: true };
};
exports.changeUserPassword = changeUserPassword;
const createUserAsManager = async (args) => {
    const name = args.name?.trim();
    const email = args.email?.trim().toLowerCase();
    const password = args.password;
    if (!name)
        throw new Error("Name is required");
    if (!email)
        throw new Error("Email is required");
    if (!password || password.length < 6)
        throw new Error("Password must be at least 6 characters");
    if (!args.role)
        throw new Error("Role is required");
    // prevent duplicate
    const existing = await prismaClient_1.default.user.findUnique({ where: { email } });
    if (existing)
        throw new Error("Email already registered");
    const hashedPassword = await bcryptjs_1.default.hash(password, 10);
    return prismaClient_1.default.$transaction(async (tx) => {
        // ✅ only customers may have customerEntity
        const isCustomer = args.role === client_1.AppRole.customer;
        let customerEntityConnectId = isCustomer
            ? (args.customerEntityId ?? null)
            : null;
        // ✅ validate provided customerEntityId (if any)
        if (isCustomer && customerEntityConnectId) {
            const entity = await tx.customerEntity.findUnique({
                where: { id: customerEntityConnectId },
                select: { id: true, type: true },
            });
            if (!entity) {
                const e = new Error("customerEntityId not found");
                e.statusCode = 400;
                throw e;
            }
            // Optional strict rule (recommended): only link customers to COMPANY entities
            // If you want to allow linking to PERSON too, delete this block.
            if (entity.type !== client_1.CustomerType.COMPANY) {
                const e = new Error("Only COMPANY customer entities can be linked");
                e.statusCode = 400;
                throw e;
            }
        }
        // ✅ auto-create PERSON entity when customerEntityId missing
        if (isCustomer && !customerEntityConnectId) {
            const createdEntity = await tx.customerEntity.create({
                data: {
                    type: client_1.CustomerType.PERSON,
                    name,
                    email,
                    phone: args.phone ?? null,
                },
                select: { id: true },
            });
            customerEntityConnectId = createdEntity.id;
        }
        // ✅ validate warehouseId only when role=warehouse (optional but clean)
        if ((args.role === client_1.AppRole.warehouse || args.role === client_1.AppRole.driver) &&
            args.warehouseId) {
            const wh = await tx.warehouse.findUnique({
                where: { id: args.warehouseId },
                select: { id: true },
            });
            if (!wh) {
                const e = new Error("warehouseId not found");
                e.statusCode = 400;
                throw e;
            }
        }
        const createData = {
            name,
            email,
            password: hashedPassword,
            role: args.role,
            ...(args.role === client_1.AppRole.driver
                ? {
                    driverType: args.driverType === "linehaul"
                        ? client_1.DriverType.linehaul
                        : client_1.DriverType.local,
                }
                : {}),
        };
        // ✅ attach warehouse ONLY when role=warehouse and warehouseId provided
        if ((args.role === client_1.AppRole.warehouse || args.role === client_1.AppRole.driver) &&
            args.warehouseId) {
            createData.warehouse = { connect: { id: args.warehouseId } };
        }
        if (isCustomer && customerEntityConnectId) {
            createData.customerEntity = { connect: { id: customerEntityConnectId } };
        }
        const user = await tx.user.create({
            data: createData,
            include: {
                warehouse: true,
                customerEntity: true,
            },
        });
        return safeUser(user);
    });
};
exports.createUserAsManager = createUserAsManager;
const listUsers = async (params) => {
    const q = params?.q?.trim();
    const role = params?.role;
    const page = params?.page ?? 1;
    const limit = Math.min(params?.limit ?? 20, 100);
    const skip = (page - 1) * limit;
    const where = {};
    if (role) {
        where.role = role;
    }
    if (q) {
        where.OR = [
            { name: { contains: q, mode: "insensitive" } },
            { email: { contains: q, mode: "insensitive" } },
        ];
    }
    const [rows, total] = await prismaClient_1.default.$transaction([
        prismaClient_1.default.user.findMany({
            where,
            include: {
                warehouse: true,
                customerEntity: true,
            },
            orderBy: { createdAt: "desc" },
            skip,
            take: limit,
        }),
        prismaClient_1.default.user.count({ where }),
    ]);
    return {
        data: rows.map((u) => {
            const { password, ...rest } = u;
            return rest;
        }),
        total,
        page,
        limit,
        pageCount: Math.ceil(total / limit),
    };
};
exports.listUsers = listUsers;
const deleteUserAsManager = async (args) => {
    const targetUserId = args.targetUserId?.trim();
    const actorUserId = args.actorUserId?.trim();
    if (!targetUserId)
        throw new Error("User id is required");
    if (!actorUserId)
        throw new Error("Actor id is required");
    if (targetUserId === actorUserId) {
        throw new Error("You cannot delete your own account");
    }
    const user = await prismaClient_1.default.user.findUnique({
        where: { id: targetUserId },
        select: { id: true, email: true, role: true },
    });
    if (!user)
        throw new Error("User not found");
    const [customerOrders, driverOrders, invoices, trackingEvents] = await prismaClient_1.default.$transaction([
        prismaClient_1.default.order.count({ where: { customerId: targetUserId } }),
        prismaClient_1.default.order.count({ where: { assignedDriverId: targetUserId } }),
        prismaClient_1.default.invoice.count({ where: { customerId: targetUserId } }),
        prismaClient_1.default.tracking.count({ where: { actorId: targetUserId } }),
    ]);
    const references = customerOrders + driverOrders + invoices + trackingEvents;
    if (references > 0) {
        throw new Error("User cannot be deleted because linked operational records already exist");
    }
    await prismaClient_1.default.user.delete({
        where: { id: targetUserId },
    });
    return { success: true };
};
exports.deleteUserAsManager = deleteUserAsManager;
