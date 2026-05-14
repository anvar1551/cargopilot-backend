"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.confirmImport = exports.previewImport = exports.downloadImportTemplate = exports.create = void 0;
const __1 = require("..");
/** Creates a new order, optional invoice/payment, and generated parcel labels. */
const create = async (req, res) => {
    try {
        const result = await (0, __1.createOrderForActor)({ user: req.user, body: req.body });
        return res.status(result.statusCode).json(result.payload);
    }
    catch (err) {
        const code = err?.statusCode ?? 500;
        console.error("Create order failed:", err?.message || err);
        return res
            .status(code)
            .json({ error: err?.message ?? "Failed to create order" });
    }
};
exports.create = create;
/** Downloads the supported CSV template for bulk order import. */
const downloadImportTemplate = async (_req, res) => {
    const csv = (0, __1.getOrderImportTemplateCsv)();
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="order-import-template-v1.csv"');
    return res.status(200).send(csv);
};
exports.downloadImportTemplate = downloadImportTemplate;
/** Parses CSV and validates rows against the standard create-order schema. */
const previewImport = async (req, res) => {
    try {
        if (!req.user?.id || !req.user.role) {
            return res.status(401).json({ error: "Unauthorized" });
        }
        const csvText = typeof req.body?.csvText === "string" ? req.body.csvText : "";
        const customerEntityId = typeof req.body?.customerEntityId === "string"
            ? req.body.customerEntityId
            : req.user.customerEntityId ?? null;
        if (!csvText.trim()) {
            return res.status(400).json({ error: "csvText is required" });
        }
        if (req.user.role === "manager" && !customerEntityId) {
            return res.status(400).json({
                error: "customerEntityId is required for manager bulk import",
            });
        }
        const preview = await (0, __1.previewOrderImport)({
            csvText,
            customerEntityId,
        });
        return res.json(preview);
    }
    catch (err) {
        return res.status(400).json({ error: err?.message ?? "Failed to preview import" });
    }
};
exports.previewImport = previewImport;
/** Confirms a validated CSV import and creates all orders through the same repo flow. */
const confirmImport = async (req, res) => {
    try {
        if (!req.user?.id || !req.user.role) {
            return res.status(401).json({ error: "Unauthorized" });
        }
        const csvText = typeof req.body?.csvText === "string" ? req.body.csvText : "";
        const customerEntityId = typeof req.body?.customerEntityId === "string"
            ? req.body.customerEntityId
            : req.user.customerEntityId ?? null;
        if (!csvText.trim()) {
            return res.status(400).json({ error: "csvText is required" });
        }
        if (req.user.role === "manager" && !customerEntityId) {
            return res.status(400).json({
                error: "customerEntityId is required for manager bulk import",
            });
        }
        const result = await (0, __1.importOrdersFromCsv)({
            actor: req.user,
            csvText,
            customerEntityId,
        });
        return res.status(201).json({
            success: true,
            count: result.count,
            orders: result.orders,
        });
    }
    catch (err) {
        const code = err?.statusCode ?? 400;
        return res.status(code).json({ error: err?.message ?? "Failed to import orders" });
    }
};
exports.confirmImport = confirmImport;
