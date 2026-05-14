"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createOrderForActor = createOrderForActor;
const prismaClient_1 = __importDefault(require("../../../config/prismaClient"));
const invoiceRepo_1 = require("../../../services/invoice/invoiceRepo");
const repo_1 = require("../repo");
const orderCreate_mapper_1 = require("../domain/orderCreate.mapper");
const shared_1 = require("../shared");
const label_1 = require("../label");
async function createOrderForActor(args) {
    const { user, body } = args;
    const paymentsEnabled = process.env.PAYMENTS_ENABLED === "true";
    const rawLabelMode = process.env.ORDER_LABEL_MODE;
    const labelMode = rawLabelMode === "async" || rawLabelMode === "queue" || rawLabelMode === "sync"
        ? rawLabelMode
        : "queue";
    const blockLabelWork = process.env.ORDER_LABEL_BLOCKING === "true";
    if (!user?.id) {
        const err = new Error("Unauthorized");
        err.statusCode = 401;
        throw err;
    }
    const actor = (0, shared_1.requireOrderActor)(user);
    const mapped = await (0, orderCreate_mapper_1.mapCreateOrderDtoToRepoPayload)(body);
    mapped.customerEntityId = mapped.customerEntityId ?? user.customerEntityId ?? null;
    const { amount, ...repoPayload } = mapped;
    const order = await (0, repo_1.createOrder)(user.id, repoPayload, actor);
    let labelWarning = null;
    const runLabelWork = async () => {
        if (labelMode === "queue") {
            await (0, label_1.enqueueOrderLabelJob)(order.id);
        }
        else {
            await (0, label_1.generateAndAttachParcelLabelsForOrder)(order.id);
        }
    };
    if (blockLabelWork) {
        try {
            await runLabelWork();
        }
        catch (labelErr) {
            labelWarning =
                labelErr?.message ??
                    "Order created, but parcel label generation failed";
            console.error(`Label generation failed for order ${order.id}:`, labelErr);
        }
    }
    else {
        void runLabelWork().catch((labelErr) => {
            console.error(`Label generation failed for order ${order.id}:`, labelErr);
        });
    }
    if (!paymentsEnabled) {
        return {
            statusCode: 201,
            payload: {
                order,
                warning: labelWarning,
                message: blockLabelWork
                    ? labelWarning
                        ? "Order created (manual payment) + parcel labels pending retry"
                        : "Order created (manual payment) + parcel labels generated"
                    : labelMode === "async" || labelMode === "sync"
                        ? "Order created (manual payment) + parcel labels scheduled"
                        : labelMode === "queue"
                            ? "Order created (manual payment) + parcel labels queued"
                            : "Order created (manual payment)",
            },
        };
    }
    if (typeof amount !== "number" || amount <= 0) {
        const err = new Error("amount must be > 0 when PAYMENTS_ENABLED=true");
        err.statusCode = 400;
        throw err;
    }
    const invoice = await (0, invoiceRepo_1.createInvoice)(order.id, user.id, amount);
    const paymentUrl = await (0, invoiceRepo_1.createStripePayment)(order.id, invoice.id, amount, user.email);
    await prismaClient_1.default.invoice.update({
        where: { id: invoice.id },
        data: { paymentUrl },
    });
    const fresh = await (0, repo_1.getOrderById)(order.id);
    return {
        statusCode: 201,
        payload: {
            order: fresh,
            invoice,
            paymentUrl,
            warning: labelWarning,
            message: blockLabelWork
                ? labelWarning
                    ? "Order + invoice created successfully (parcel labels pending retry)"
                    : "Order + parcel labels + invoice created successfully"
                : labelMode === "async" || labelMode === "sync"
                    ? "Order + invoice created successfully (parcel labels scheduled)"
                    : labelMode === "queue"
                        ? "Order + invoice created successfully (parcel labels queued)"
                        : "Order + invoice created successfully",
        },
    };
}
