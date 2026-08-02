"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.normalizeS3ObjectKey = normalizeS3ObjectKey;
exports.collectS3ObjectKeys = collectS3ObjectKeys;
exports.deleteS3ObjectsBestEffort = deleteS3ObjectsBestEffort;
const client_s3_1 = require("@aws-sdk/client-s3");
const s3_1 = require("../config/s3");
function normalizeS3ObjectKey(value) {
    const key = String(value ?? "").trim();
    if (!key)
        return null;
    if (/^https?:\/\//i.test(key))
        return null;
    if (/^s3:\/\//i.test(key)) {
        const withoutScheme = key.slice("s3://".length);
        const slashIndex = withoutScheme.indexOf("/");
        return slashIndex >= 0 ? withoutScheme.slice(slashIndex + 1).trim() || null : null;
    }
    return key.replace(/^\/+/, "") || null;
}
function collectS3ObjectKeys(values) {
    const keys = new Set();
    for (const value of values) {
        const key = normalizeS3ObjectKey(value);
        if (key)
            keys.add(key);
    }
    return [...keys];
}
async function deleteS3ObjectsBestEffort(keysInput) {
    const keys = collectS3ObjectKeys(keysInput);
    const bucket = String(process.env.AWS_S3_BUCKET ?? "").trim();
    const result = {
        requested: keys.length,
        deleted: 0,
        failed: 0,
        skipped: 0,
        errors: [],
    };
    if (keys.length === 0)
        return result;
    if (!bucket) {
        result.skipped = keys.length;
        result.errors.push({ message: "AWS_S3_BUCKET is not configured" });
        return result;
    }
    for (let index = 0; index < keys.length; index += 1000) {
        const batch = keys.slice(index, index + 1000);
        try {
            const response = await s3_1.s3.send(new client_s3_1.DeleteObjectsCommand({
                Bucket: bucket,
                Delete: {
                    Objects: batch.map((Key) => ({ Key })),
                    Quiet: false,
                },
            }));
            const errors = response.Errors ?? [];
            result.deleted += response.Deleted?.length ?? Math.max(batch.length - errors.length, 0);
            result.failed += errors.length;
            for (const error of errors) {
                result.errors.push({
                    key: error.Key,
                    code: error.Code,
                    message: error.Message ?? "S3 object delete failed",
                });
            }
        }
        catch (error) {
            result.failed += batch.length;
            result.errors.push({
                message: error?.message ?? "S3 batch delete failed",
            });
        }
    }
    return result;
}
