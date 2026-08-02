"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const s3Cleanup_1 = require("../src/utils/s3Cleanup");
describe("S3 cleanup key helpers", () => {
    it("normalizes object keys and ignores non-key values", () => {
        expect((0, s3Cleanup_1.normalizeS3ObjectKey)(" /labels/a.pdf ")).toBe("labels/a.pdf");
        expect((0, s3Cleanup_1.normalizeS3ObjectKey)("")).toBeNull();
        expect((0, s3Cleanup_1.normalizeS3ObjectKey)(null)).toBeNull();
        expect((0, s3Cleanup_1.normalizeS3ObjectKey)("https://carrier.example/label.pdf")).toBeNull();
        expect((0, s3Cleanup_1.normalizeS3ObjectKey)("s3://bucket/invoices/a.pdf")).toBe("invoices/a.pdf");
    });
    it("deduplicates collected object keys", () => {
        expect((0, s3Cleanup_1.collectS3ObjectKeys)([
            "labels/a.pdf",
            "/labels/a.pdf",
            "invoices/a.pdf",
            "https://carrier.example/label.pdf",
            null,
        ])).toEqual(["labels/a.pdf", "invoices/a.pdf"]);
    });
});
