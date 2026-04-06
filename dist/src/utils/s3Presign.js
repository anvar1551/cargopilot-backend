"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.presignGetObject = presignGetObject;
const client_s3_1 = require("@aws-sdk/client-s3");
const s3_request_presigner_1 = require("@aws-sdk/s3-request-presigner");
const s3_1 = require("../config/s3");
async function presignGetObject(key, expiresInSeconds = 60 * 5) {
    const Bucket = process.env.AWS_S3_BUCKET;
    const command = new client_s3_1.GetObjectCommand({ Bucket, Key: key });
    return (0, s3_request_presigner_1.getSignedUrl)(s3_1.s3, command, { expiresIn: expiresInSeconds });
}
