"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PaymeProviderAdapter = void 0;
const client_1 = require("@prisma/client");
const money_1 = require("../../shared/money");
const PAYME_CHECKOUT_BASE = {
    TEST: "https://test.paycom.uz",
    PRODUCTION: "https://checkout.paycom.uz",
};
function parseRecord(input) {
    if (!input)
        return {};
    if (typeof input === "string") {
        try {
            return JSON.parse(input);
        }
        catch {
            return {};
        }
    }
    if (typeof input === "object")
        return input;
    return {};
}
function parseJsonRpcBody(input) {
    const body = parseRecord(input);
    return {
        jsonrpc: typeof body.jsonrpc === "string" ? body.jsonrpc : "2.0",
        id: typeof body.id === "string" || typeof body.id === "number" || body.id === null
            ? body.id
            : null,
        method: typeof body.method === "string" ? body.method : undefined,
        params: typeof body.params === "object" && body.params ? body.params : {},
    };
}
function readString(record, key) {
    const value = record[key];
    if (typeof value === "string")
        return value;
    if (typeof value === "number" || typeof value === "bigint")
        return String(value);
    return "";
}
function readNumber(record, key) {
    const text = readString(record, key);
    if (!text)
        return null;
    const parsed = Number(text);
    return Number.isFinite(parsed) ? parsed : null;
}
function getAuthorization(headers) {
    const value = headers.authorization ?? headers.Authorization ?? headers["x-auth"];
    if (Array.isArray(value))
        return value[0] ?? "";
    return value ?? "";
}
function validateAuth(headers, secretPlain) {
    const auth = getAuthorization(headers);
    if (!auth)
        return false;
    if (auth.toLowerCase().startsWith("basic ")) {
        const encoded = auth.slice(6).trim();
        try {
            const decoded = Buffer.from(encoded, "base64").toString("utf8");
            const [, password] = decoded.split(":");
            return Boolean(password) && password === secretPlain;
        }
        catch {
            return false;
        }
    }
    if (auth.startsWith("Paycom:")) {
        return auth.slice("Paycom:".length) === secretPlain;
    }
    return false;
}
function mapIntentStatusByMethod(method, rpcParams) {
    if (method === "PerformTransaction")
        return "succeeded";
    if (method === "CancelTransaction") {
        const reason = readNumber(rpcParams, "reason");
        if (reason === 5)
            return "refunded";
        return "canceled";
    }
    if (method === "CheckTransaction") {
        const state = readNumber(rpcParams, "state");
        if (state === 2)
            return "succeeded";
        if (state === -1)
            return "canceled";
    }
    return "pending";
}
function buildRpcError(id, code, message) {
    return {
        jsonrpc: "2.0",
        id: id ?? null,
        error: {
            code,
            message,
        },
    };
}
function buildRpcResult(id, payload) {
    return {
        jsonrpc: "2.0",
        id: id ?? null,
        result: payload,
    };
}
function buildResultByMethod(args) {
    const nowMs = Date.now();
    const transaction = readString(args.params, "id") || args.intent?.providerPaymentId || args.intent?.id || "";
    const createTime = args.intent?.createdAt?.getTime?.() ?? nowMs;
    const performTime = args.method === "PerformTransaction" || args.intent?.status === "SUCCEEDED" ? nowMs : 0;
    const cancelTime = args.method === "CancelTransaction" || args.intent?.status === "CANCELED" ? nowMs : 0;
    switch (args.method) {
        case "CheckPerformTransaction":
            return buildRpcResult(args.id, { allow: Boolean(args.intent) });
        case "CreateTransaction":
            if (!args.intent)
                return buildRpcError(args.id, -31050, "Order not found");
            return buildRpcResult(args.id, {
                create_time: createTime,
                transaction,
                state: 1,
            });
        case "PerformTransaction":
            if (!args.intent)
                return buildRpcError(args.id, -31050, "Order not found");
            return buildRpcResult(args.id, {
                transaction,
                perform_time: performTime,
                state: 2,
            });
        case "CancelTransaction":
            if (!args.intent)
                return buildRpcError(args.id, -31050, "Order not found");
            return buildRpcResult(args.id, {
                transaction,
                cancel_time: cancelTime || nowMs,
                state: -1,
            });
        case "CheckTransaction":
            if (!args.intent)
                return buildRpcError(args.id, -31050, "Order not found");
            return buildRpcResult(args.id, {
                create_time: createTime,
                perform_time: performTime,
                cancel_time: cancelTime,
                transaction,
                state: args.intent.status === "SUCCEEDED" ? 2 : args.intent.status === "CANCELED" ? -1 : 1,
                reason: null,
            });
        default:
            return buildRpcError(args.id, -32601, "Method not found");
    }
}
class PaymeProviderAdapter {
    constructor() {
        this.provider = client_1.PaymentProvider.PAYME;
    }
    async createPayment(input) {
        if (!input.config.merchantId) {
            throw new Error("Payme provider config requires merchantId");
        }
        const amount = (0, money_1.formatProviderAmount)(input.intent.amountMinor, input.intent.currency, "PAYME");
        const accountField = input.config.accountId?.trim() || "order_id";
        const params = `m=${input.config.merchantId};ac.${accountField}=${input.intent.id};a=${String(amount)}`;
        const encoded = Buffer.from(params).toString("base64");
        const base = input.config.environment === "PRODUCTION"
            ? PAYME_CHECKOUT_BASE.PRODUCTION
            : PAYME_CHECKOUT_BASE.TEST;
        return {
            providerPaymentId: input.intent.id,
            checkoutUrl: `${base}/${encoded}`,
            rawResponse: {
                provider: "payme",
                params,
                accountField,
            },
        };
    }
    async getStatus(_input) {
        return {
            status: "pending",
            rawResponse: { reason: "payme_status_pull_not_configured_use_webhook" },
        };
    }
    async refund(_input) {
        return {
            status: "failed",
            rawResponse: { reason: "payme_refund_not_implemented" },
        };
    }
    async verifyWebhook(input) {
        const rpc = parseJsonRpcBody(input.body);
        const method = rpc.method ?? "";
        const params = rpc.params ?? {};
        const isValid = validateAuth(input.headers, input.config.secretPlain);
        const txId = readString(params, "id") || input.intent?.id || `${input.provider}:${Date.now()}`;
        const mappedStatus = isValid ? mapIntentStatusByMethod(method, params) : undefined;
        const responsePayload = isValid
            ? buildResultByMethod({
                method,
                id: rpc.id,
                intent: input.intent ?? null,
                params,
            })
            : buildRpcError(rpc.id, -32504, "Insufficient privilege");
        return {
            isValid,
            idempotencyKey: txId,
            mappedStatus,
            providerPaymentId: txId,
            externalEventId: txId,
            rawEvent: rpc,
            responsePayload,
        };
    }
}
exports.PaymeProviderAdapter = PaymeProviderAdapter;
