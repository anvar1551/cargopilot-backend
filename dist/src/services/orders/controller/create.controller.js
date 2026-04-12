"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.confirmImport = exports.previewImport = exports.downloadImportTemplate = exports.create = void 0;
const prismaClient_1 = __importDefault(require("../../../config/prismaClient"));
const invoiceRepo_1 = require("../../invoice/invoiceRepo");
const repo_1 = require("../repo");
const orderCreate_mapper_1 = require("../orderCreate.mapper");
const orderAddress_shared_1 = require("../orderAddress.shared");
const orderService_shared_1 = require("../orderService.shared");
const workflow_1 = require("../workflow");
async function saveAddressToBookIfRequested(args) {
    if (!args.enabled || args.existingAddressId)
        return null;
    if (!args.ownerCustomerEntityId) {
        throw new Error(args.missingCustomerEntityError);
    }
    if (!args.snapshot) {
        throw new Error(args.missingSnapshotError);
    }
    const created = await prismaClient_1.default.address.create({
        data: {
            customerEntityId: args.ownerCustomerEntityId,
            isSaved: true,
            ...args.snapshot,
        },
    });
    return {
        id: created.id,
        addressText: (0, orderAddress_shared_1.buildAddressText)(created),
        city: created.city ?? null,
    };
}
/** Creates a new order, optional invoice/payment, and generated parcel labels. */
const create = async (req, res) => {
    try {
        const paymentsEnabled = process.env.PAYMENTS_ENABLED === "true";
        const rawLabelMode = process.env.ORDER_LABEL_MODE;
        const labelMode = rawLabelMode === "async" || rawLabelMode === "queue" ? rawLabelMode : "sync";
        if (!req.user?.id)
            return res.status(401).json({ error: "Unauthorized" });
        const actor = (0, orderService_shared_1.requireOrderActor)(req.user);
        const mapped = await (0, orderCreate_mapper_1.mapCreateOrderDtoToRepoPayload)(req.body);
        const ownerCustomerEntityId = mapped.customerEntityId ?? req.user.customerEntityId ?? null;
        try {
            const savedPickup = await saveAddressToBookIfRequested({
                enabled: mapped.savePickupToAddressBook === true,
                existingAddressId: mapped.senderAddressId,
                ownerCustomerEntityId,
                snapshot: mapped.senderAddressSnapshot,
                missingCustomerEntityError: "customerEntityId is required to save pickup address",
                missingSnapshotError: "senderAddress (structured) is required to save pickup address",
            });
            if (savedPickup) {
                mapped.senderAddressId = savedPickup.id;
                mapped.pickupAddress = savedPickup.addressText;
            }
            const savedDropoff = await saveAddressToBookIfRequested({
                enabled: mapped.saveDropoffToAddressBook === true,
                existingAddressId: mapped.receiverAddressId,
                ownerCustomerEntityId,
                snapshot: mapped.receiverAddressSnapshot,
                missingCustomerEntityError: "customerEntityId is required to save dropoff address",
                missingSnapshotError: "receiverAddress (structured) is required to save dropoff address",
            });
            if (savedDropoff) {
                mapped.receiverAddressId = savedDropoff.id;
                mapped.dropoffAddress = savedDropoff.addressText;
                if (!mapped.destinationCity && savedDropoff.city) {
                    mapped.destinationCity = savedDropoff.city;
                }
            }
        }
        catch (addressErr) {
            return res.status(400).json({
                error: addressErr?.message ??
                    "Failed to process address-book save request",
            });
        }
        const { amount, ...repoPayload } = mapped;
        const order = await (0, repo_1.createOrder)(req.user.id, repoPayload, actor);
        if (labelMode === "queue") {
            await (0, workflow_1.enqueueOrderLabelJob)(order.id);
        }
        else if (labelMode === "async") {
            void (0, workflow_1.generateAndAttachParcelLabelsForOrder)(order.id).catch((labelErr) => {
                console.error(`Label generation failed for order ${order.id}:`, labelErr);
            });
        }
        else {
            await (0, workflow_1.generateAndAttachParcelLabelsForOrder)(order.id);
        }
        if (!paymentsEnabled) {
            const fresh = await (0, repo_1.getOrderById)(order.id);
            return res.status(201).json({
                order: fresh,
                message: labelMode === "async"
                    ? "Order created (manual payment) + parcel labels scheduled"
                    : labelMode === "queue"
                        ? "Order created (manual payment) + parcel labels queued"
                        : "Order created (manual payment) + parcel labels generated",
            });
        }
        if (typeof amount !== "number" || amount <= 0) {
            return res
                .status(400)
                .json({ error: "amount must be > 0 when PAYMENTS_ENABLED=true" });
        }
        const invoice = await (0, invoiceRepo_1.createInvoice)(order.id, req.user.id, amount);
        const paymentUrl = await (0, invoiceRepo_1.createStripePayment)(order.id, invoice.id, amount, req.user.email);
        await prismaClient_1.default.invoice.update({
            where: { id: invoice.id },
            data: { paymentUrl },
        });
        const fresh = await (0, repo_1.getOrderById)(order.id);
        return res.status(201).json({
            order: fresh,
            invoice,
            paymentUrl,
            message: labelMode === "async"
                ? "Order + invoice created successfully (parcel labels scheduled)"
                : labelMode === "queue"
                    ? "Order + invoice created successfully (parcel labels queued)"
                    : "Order + parcel labels + invoice created successfully",
        });
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
    const csv = (0, workflow_1.getOrderImportTemplateCsv)();
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
        const preview = await (0, workflow_1.previewOrderImport)({
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
        const result = await (0, workflow_1.importOrdersFromCsv)({
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
