"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.userLiteSelect = void 0;
exports.isUuid = isUuid;
exports.looksLikeOrderNumber = looksLikeOrderNumber;
exports.looksLikeParcelCode = looksLikeParcelCode;
/** Common user projection reused in order read/write includes. */
exports.userLiteSelect = { id: true, name: true, email: true, role: true };
function isUuid(value) {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
function looksLikeOrderNumber(value) {
    return /^[0-9]{6,20}$/.test(value);
}
function looksLikeParcelCode(value) {
    return /^[0-9]{6,20}-[0-9]+\/[0-9]+$/i.test(value);
}
