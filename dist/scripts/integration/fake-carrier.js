"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const crypto_1 = require("crypto");
const http_1 = __importDefault(require("http"));
const port = Number(process.env.FAKE_CARRIER_PORT || 4100);
const shipments = new Map();
function jsonResponse(response, statusCode, body) {
    const text = JSON.stringify(body);
    response.writeHead(statusCode, {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(text, "utf8"),
    });
    response.end(text);
}
function readBody(request) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        request.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        request.on("error", reject);
    });
}
function parseJson(raw) {
    if (!raw.trim())
        return {};
    return JSON.parse(raw);
}
function signWebhook(rawBody, secret, timestamp) {
    return (0, crypto_1.createHmac)("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
}
async function sendSignedWebhook(args) {
    const rawBody = JSON.stringify(args.payload);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = signWebhook(rawBody, args.secret, timestamp);
    const response = await fetch(args.url, {
        method: "POST",
        headers: {
            "content-type": "application/json",
            "x-signature": signature,
            "x-signature-timestamp": timestamp,
        },
        body: rawBody,
    });
    return {
        status: response.status,
        body: await response.text(),
    };
}
const server = http_1.default.createServer(async (request, response) => {
    try {
        const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
        const method = request.method || "GET";
        if (method === "GET" && url.pathname === "/health") {
            return jsonResponse(response, 200, {
                status: "ok",
                shipments: shipments.size,
            });
        }
        if (method === "POST" && url.pathname === "/shipments") {
            const raw = await readBody(request);
            const body = parseJson(raw);
            const forcedStatus = String(request.headers["x-fake-carrier-status"] || "").trim();
            if (forcedStatus) {
                return jsonResponse(response, Number(forcedStatus), {
                    error: `forced ${forcedStatus}`,
                });
            }
            const id = `fake_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
            const trackingNumber = `FCT${Date.now().toString().slice(-8)}`;
            const now = new Date().toISOString();
            shipments.set(id, {
                id,
                trackingNumber,
                statusCode: "booked",
                requestBody: body,
                createdAt: now,
                updatedAt: now,
            });
            return jsonResponse(response, 201, {
                partnerShipmentId: id,
                trackingNumber,
                labelUrl: `https://fake-carrier.local/labels/${id}.pdf`,
            });
        }
        const trackMatch = url.pathname.match(/^\/shipments\/([^/]+)\/track$/);
        if (method === "GET" && trackMatch) {
            const shipment = shipments.get(decodeURIComponent(trackMatch[1]));
            if (!shipment)
                return jsonResponse(response, 404, { error: "not found" });
            return jsonResponse(response, 200, {
                statusCode: shipment.statusCode,
                statusLabel: shipment.statusCode,
                trackingNumber: shipment.trackingNumber,
                happenedAt: shipment.updatedAt,
            });
        }
        if (method === "GET" && url.pathname === "/shipments/track") {
            const trackingNumber = String(url.searchParams.get("trackingNumber") || "").trim();
            const shipment = Array.from(shipments.values()).find((item) => item.trackingNumber === trackingNumber);
            if (!shipment)
                return jsonResponse(response, 404, { error: "not found" });
            return jsonResponse(response, 200, {
                statusCode: shipment.statusCode,
                statusLabel: shipment.statusCode,
                trackingNumber: shipment.trackingNumber,
                partnerShipmentId: shipment.id,
                happenedAt: shipment.updatedAt,
            });
        }
        const cancelMatch = url.pathname.match(/^\/shipments\/([^/]+)\/cancel$/);
        if (method === "POST" && cancelMatch) {
            const shipment = shipments.get(decodeURIComponent(cancelMatch[1]));
            if (!shipment)
                return jsonResponse(response, 404, { error: "not found" });
            shipment.statusCode = "cancelled";
            shipment.updatedAt = new Date().toISOString();
            return jsonResponse(response, 200, {
                partnerShipmentId: shipment.id,
                statusCode: shipment.statusCode,
            });
        }
        if (method === "POST" && url.pathname === "/webhooks/simulate") {
            const body = parseJson(await readBody(request));
            const targetUrl = String(body.targetUrl || process.env.FAKE_CARRIER_WEBHOOK_URL || "").trim();
            const secret = String(body.secret || process.env.FAKE_CARRIER_WEBHOOK_SECRET || "").trim();
            if (!targetUrl || !secret) {
                return jsonResponse(response, 400, {
                    error: "targetUrl and secret are required",
                });
            }
            const payload = (body.payload && typeof body.payload === "object" ? body.payload : body);
            const result = await sendSignedWebhook({
                url: targetUrl,
                secret,
                payload,
            });
            return jsonResponse(response, 200, result);
        }
        return jsonResponse(response, 404, { error: "not found" });
    }
    catch (error) {
        return jsonResponse(response, 500, {
            error: String(error?.message || error),
        });
    }
});
server.listen(port, () => {
    console.log(`[fake-carrier] listening on http://localhost:${port}`);
});
process.on("SIGINT", () => server.close(() => process.exit(0)));
process.on("SIGTERM", () => server.close(() => process.exit(0)));
