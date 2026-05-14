"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.uploadDeliveryProofFiles = void 0;
exports.submitDeliveryProof = submitDeliveryProof;
exports.submitOrderProof = submitOrderProof;
exports.getOrderProofLinks = getOrderProofLinks;
const __1 = require("..");
Object.defineProperty(exports, "uploadDeliveryProofFiles", { enumerable: true, get: function () { return __1.uploadDeliveryProofFiles; } });
/** Backward-compatible endpoint for delivery proof uploads. */
async function submitDeliveryProof(req, res) {
    try {
        const actor = (0, __1.requireOrderActor)(req.user);
        const result = await (0, __1.submitProofForActor)({
            actor,
            orderId: String(req.params?.id ?? "").trim(),
            body: req.body ?? {},
            file: req.file,
            forcedStage: "delivery",
        });
        return res.json(result);
    }
    catch (err) {
        const code = err.statusCode ?? 400;
        return res.status(code).json({ error: err.message ?? "Failed" });
    }
}
/** Generic endpoint for pickup/delivery proof uploads. */
async function submitOrderProof(req, res) {
    try {
        const actor = (0, __1.requireOrderActor)(req.user);
        const result = await (0, __1.submitProofForActor)({
            actor,
            orderId: String(req.params?.id ?? "").trim(),
            body: req.body ?? {},
            file: req.file,
        });
        return res.json(result);
    }
    catch (err) {
        const code = err.statusCode ?? 400;
        return res.status(code).json({ error: err.message ?? "Failed" });
    }
}
/** Lazily resolves signed URLs for order proof artifacts grouped by stage. */
async function getOrderProofLinks(req, res) {
    try {
        const user = req.user;
        const result = await (0, __1.listOrderProofLinksForActor)({
            user,
            orderId: String(req.params?.id ?? "").trim(),
            query: req.query ?? {},
        });
        return res.json(result);
    }
    catch (err) {
        const code = err.statusCode ?? 400;
        return res.status(code).json({ error: err.message ?? "Failed" });
    }
}
