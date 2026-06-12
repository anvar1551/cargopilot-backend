"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.integrationOutboxLogger = void 0;
const scope = "integrations-outbox";
const throttleMap = new Map();
function toMessage(message, meta) {
    return JSON.stringify({
        ts: new Date().toISOString(),
        scope,
        message,
        ...(meta ? { meta } : {}),
    });
}
function log(level, message, meta) {
    const line = toMessage(message, meta);
    if (level === "error") {
        console.error(line);
        return;
    }
    if (level === "warn") {
        console.warn(line);
        return;
    }
    console.log(line);
}
exports.integrationOutboxLogger = {
    info(message, meta) {
        log("info", message, meta);
    },
    warn(message, meta) {
        log("warn", message, meta);
    },
    error(message, meta) {
        log("error", message, meta);
    },
    throttledWarn(key, message, throttleMs, meta) {
        const now = Date.now();
        const last = throttleMap.get(key) || 0;
        if (now - last < throttleMs)
            return;
        throttleMap.set(key, now);
        log("warn", message, meta);
    },
    throttledError(key, message, throttleMs, meta) {
        const now = Date.now();
        const last = throttleMap.get(key) || 0;
        if (now - last < throttleMs)
            return;
        throttleMap.set(key, now);
        log("error", message, meta);
    },
};
