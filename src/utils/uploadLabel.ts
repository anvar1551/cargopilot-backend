// import { uploadToS3 } from "./uploadToS3";

// export function uploadLabel(fileName: string) {
//   return uploadToS3({
//     localDir: "labels",
//     fileName,
//     s3Folder: "labels",
//   });
// }

import { PutObjectCommand } from "@aws-sdk/client-s3";
import fs from "fs";
import path from "path";
import { s3 } from "../config/s3";

export async function uploadLabel(fileName: string) {
  const safeFileName = path.basename(fileName);
  const filePath = path.join("labels", safeFileName);
  const fileContent = await fs.promises.readFile(filePath);

  const key = `labels/${safeFileName}`;

  await s3.send(
    new PutObjectCommand({
      Bucket: process.env.AWS_S3_BUCKET!,
      Key: key,
      Body: fileContent,
      ContentType: "application/pdf",
    }),
  );

  return { key };
}
