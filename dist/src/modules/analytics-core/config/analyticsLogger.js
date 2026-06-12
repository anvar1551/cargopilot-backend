"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.analyticsLogger = void 0;
const analyticsConfig_1 = require("./analyticsConfig");
const levelWeight = {
    debug: 10,
    info: 20,
    warn: 30,
    error: 40,
    off: 100,
};
const throttleState = new Map();
function enabled(level) {
    return levelWeight[level] >= levelWeight[analyticsConfig_1.analyticsConfig.logLevel];
}
function normalizeError(err) {
    if (!err)
        return undefined;
    if (err instanceof Error) {
        return {
            message: err.message,
            name: err.name,
        };
    }
    return { message: String(err) };
}
function write(level, message, meta, error) {
    if (!enabled(level))
        return;
    const payload = {
        ts: new Date().toISOString(),
        scope: "analytics",
        level,
        message,
        ...(meta ? { meta } : {}),
        ...(error ? { error: normalizeError(error) } : {}),
    };
    const line = JSON.stringify(payload);
    if (level === "error") {
        console.error(line);
    }
    else if (level === "warn") {
        console.warn(line);
    }
    else {
        console.log(line);
    }
}
function throttled(level, key, message, args) {
    const throttleMs = Math.max(1000, args?.throttleMs ?? 30000);
    const now = Date.now();
    const current = throttleState.get(key);
    if (current && now - current.lastAt < throttleMs) {
        current.suppressed += 1;
        throttleState.set(key, current);
        return;
    }
    const suppressed = current?.suppressed ?? 0;
    throttleState.set(key, { lastAt: now, suppressed: 0 });
    write(level, message, { ...(args?.meta || {}), suppressed }, args?.error);
}
exports.analyticsLogger = {
    debug: (message, meta) => write("debug", message, meta),
    info: (message, meta) => write("info", message, meta),
    warn: (message, meta) => write("warn", message, meta),
    error: (message, error, meta) => write("error", message, meta, error),
    throttledWarn: (key, message, args) => throttled("warn", key, message, args),
    throttledError: (key, message, args) => throttled("error", key, message, args),
};
