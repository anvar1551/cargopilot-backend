"use strict";
// import { uploadToS3 } from "./uploadToS3";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.uploadLabel = uploadLabel;
// export function uploadLabel(fileName: string) {
//   return uploadToS3({
//     localDir: "labels",
//     fileName,
//     s3Folder: "labels",
//   });
// }
const client_s3_1 = require("@aws-sdk/client-s3");
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const s3_1 = require("../config/s3");
async function uploadLabel(fileName) {
    const safeFileName = path_1.default.basename(fileName);
    const filePath = path_1.default.join("labels", safeFileName);
    const fileContent = await fs_1.default.promises.readFile(filePath);
    const key = `labels/${safeFileName}`;
    await s3_1.s3.send(new client_s3_1.PutObjectCommand({
        Bucket: process.env.AWS_S3_BUCKET,
        Key: key,
        Body: fileContent,
        ContentType: "application/pdf",
    }));
    return { key };
}
