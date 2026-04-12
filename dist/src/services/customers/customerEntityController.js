"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.list = list;
exports.create = create;
exports.getOne = getOne;
const client_1 = require("@prisma/client");
const zod_1 = require("zod");
const customerEntityRepo_1 = require("./customerEntityRepo");
// ---------------- LIST ----------------
async function list(req, res) {
    try {
        if (!req.user?.id) {
            return res.status(401).json({ error: "Unauthorized" });
        }
        if (req.user.role !== client_1.AppRole.manager &&
            req.user.role !== client_1.AppRole.customer) {
            return res.status(403).json({ error: "Forbidden" });
        }
        const q = typeof req.query.q === "string" ? req.query.q : undefined;
        const type = typeof req.query.type === "string"
            ? req.query.type
            : undefined;
        const page = req.query.page ? Number(req.query.page) : undefined;
        const limit = req.query.limit ? Number(req.query.limit) : undefined;
        const result = await (0, customerEntityRepo_1.listCustomerEntities)({
            q,
            type,
            page,
            limit,
        });
        return res.json(result);
    }
    catch (err) {
        return res
            .status(500)
            .json({ error: err.message ?? "Failed to fetch customers" });
    }
}
// ---------------- CREATE ----------------
const createCustomerSchema = zod_1.z
    .object({
    type: zod_1.z.enum(["PERSON", "COMPANY"]),
    name: zod_1.z.string().min(2),
    email: zod_1.z.email().optional().nullable(),
    phone: zod_1.z.string().optional().nullable(),
    altPhone1: zod_1.z.string().optional().nullable(),
    altPhone2: zod_1.z.string().optional().nullable(),
    companyName: zod_1.z.string().optional().nullable(),
    taxId: zod_1.z.string().optional().nullable(),
})
    .superRefine((v, ctx) => {
    if (v.type === "COMPANY") {
        if (!v.companyName) {
            ctx.addIssue({
                code: "custom",
                path: ["companyName"],
                message: "Company name is required",
            });
        }
        if (!v.taxId) {
            ctx.addIssue({
                code: "custom",
                path: ["taxId"],
                message: "Tax ID is required",
            });
        }
    }
});
async function create(req, res) {
    try {
        if (!req.user?.id) {
            return res.status(401).json({ error: "Unauthorized" });
        }
        if (req.user.role !== client_1.AppRole.manager) {
            return res.status(403).json({ error: "Forbidden" });
        }
        const dto = createCustomerSchema.parse(req.body);
        const created = await (0, customerEntityRepo_1.createCustomerEntity)(dto);
        return res.status(201).json(created);
    }
    catch (err) {
        return res
            .status(400)
            .json({ error: err.message ?? "Failed to create customer" });
    }
}
async function getOne(req, res) {
    try {
        if (!req.user?.id) {
            return res.status(401).json({ error: "Unauthorized" });
        }
        if (req.user.role !== client_1.AppRole.manager &&
            req.user.role !== client_1.AppRole.customer) {
            return res.status(403).json({ error: "Forbidden" });
        }
        const customer = await (0, customerEntityRepo_1.getCustomerEntityById)(req.params.id);
        if (!customer) {
            return res.status(404).json({ error: "Not found" });
        }
        return res.json(customer);
    }
    catch (err) {
        return res
            .status(500)
            .json({ error: err.message ?? "Failed to fetch customer" });
    }
}
