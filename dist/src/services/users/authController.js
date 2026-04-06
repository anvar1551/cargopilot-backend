"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createByManager = exports.login = exports.register = exports.listUsersController = void 0;
const zod_1 = require("zod");
const client_1 = require("@prisma/client");
const userRepo_1 = require("./userRepo");
const userRepo_2 = require("./userRepo");
const userRepo_3 = require("./userRepo");
const listUsersController = async (req, res) => {
    try {
        const q = typeof req.query.q === "string" ? req.query.q : undefined;
        const role = typeof req.query.role === "string"
            ? req.query.role
            : undefined;
        const page = req.query.page ? Number(req.query.page) : 1;
        const limit = req.query.limit ? Number(req.query.limit) : 20;
        const result = await (0, userRepo_3.listUsers)({ q, role, page, limit });
        return res.json(result);
    }
    catch (err) {
        return res.status(400).json({ error: err?.message ?? "Failed" });
    }
};
exports.listUsersController = listUsersController;
const register = async (req, res) => {
    try {
        const { name, email, password, role, 
        // optional customer profile fields
        customerType, companyName, phone, } = req.body;
        // Public registration is customer-only.
        if (role && role !== client_1.AppRole.customer) {
            return res
                .status(403)
                .json({ error: "Public registration is customer-only" });
        }
        const parsedRole = client_1.AppRole.customer;
        const parsedCustomerType = customerType && Object.values(client_1.CustomerType).includes(customerType)
            ? customerType
            : undefined;
        const result = await (0, userRepo_1.registerUser)({
            name,
            email,
            password,
            role: parsedRole,
            customerType: parsedCustomerType,
            companyName: companyName ?? null,
            phone: phone ?? null,
        });
        return res.status(201).json(result);
    }
    catch (err) {
        console.error("register error:", err?.message || err);
        const msg = err?.message || "Registration failed";
        const code = msg.includes("JWT_SECRET not configured") ? 500 : 400;
        return res.status(code).json({ error: msg });
    }
};
exports.register = register;
const login = async (req, res) => {
    try {
        const { email, password } = req.body;
        const result = await (0, userRepo_1.loginUser)(email, password);
        return res.json(result);
    }
    catch (err) {
        console.error("login error:", err?.message || err);
        // invalid login should be 401, not 500
        const msg = err?.message || "Login failed";
        const code = msg.includes("Invalid email or password")
            ? 401
            : msg.includes("JWT_SECRET not configured")
                ? 500
                : 400;
        return res.status(code).json({ error: msg });
    }
};
exports.login = login;
const createUserByManagerSchema = zod_1.z
    .object({
    name: zod_1.z.string().min(2),
    email: zod_1.z.email(),
    password: zod_1.z.string().min(6),
    role: zod_1.z.enum(Object.values(client_1.AppRole)),
    warehouseId: zod_1.z.uuid().optional().nullable(),
    customerEntityId: zod_1.z.uuid().optional().nullable(),
    phone: zod_1.z.string().optional().nullable(),
})
    .superRefine((v, ctx) => {
    // ✅ warehouseId only allowed for warehouse role
    const supportsWarehouse = v.role === client_1.AppRole.warehouse || v.role === client_1.AppRole.driver;
    if (!supportsWarehouse && v.warehouseId) {
        ctx.addIssue({
            code: "custom",
            path: ["warehouseId"],
            message: "warehouseId is only allowed when role is WAREHOUSE or DRIVER",
        });
    }
    // ✅ require warehouseId when role=warehouse (recommended)
    if (v.role === client_1.AppRole.warehouse && !v.warehouseId) {
        ctx.addIssue({
            code: "custom",
            path: ["warehouseId"],
            message: "warehouseId is required when role is WAREHOUSE",
        });
    }
    // ✅ customerEntityId only meaningful for customers (optional strictness)
    if (v.role !== client_1.AppRole.customer && v.customerEntityId) {
        ctx.addIssue({
            code: "custom",
            path: ["customerEntityId"],
            message: "customerEntityId is only allowed when role is CUSTOMER",
        });
    }
});
const createByManager = async (req, res) => {
    try {
        const dto = createUserByManagerSchema.parse(req.body);
        const user = await (0, userRepo_2.createUserAsManager)({
            name: dto.name,
            email: dto.email,
            password: dto.password,
            role: dto.role,
            warehouseId: dto.warehouseId ?? null,
            customerEntityId: dto.customerEntityId ?? null,
            phone: dto.phone ?? null,
        });
        return res.status(201).json({ user });
    }
    catch (err) {
        const code = err?.statusCode ?? 400;
        return res.status(code).json({ error: err?.message ?? "Bad request" });
    }
};
exports.createByManager = createByManager;
