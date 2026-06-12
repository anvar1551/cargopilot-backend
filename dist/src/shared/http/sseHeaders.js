"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.applySseHeaders = applySseHeaders;
const SSE_HEADERS = {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
};
function applySseHeaders(request, reply) {
    const origin = String(request.headers.origin || "");
    const headers = { ...SSE_HEADERS };
    if (origin) {
        headers["Access-Control-Allow-Origin"] = origin;
        headers["Access-Control-Allow-Credentials"] = "true";
        headers.Vary = "Origin";
    }
    for (const [key, value] of Object.entries(headers)) {
        reply.header(key, value);
        if (!reply.raw.headersSent) {
            reply.raw.setHeader(key, value);
        }
    }
}
