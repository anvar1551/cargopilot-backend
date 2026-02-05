// import { uploadToS3 } from "./uploadToS3";

// export function uploadInvoice(fileName: string) {
//   return uploadToS3({
//     localDir: "invoices",
//     fileName,
//     s3Folder: "invoices",
//   });
// }

import { PutObjectCommand } from "@aws-sdk/client-s3";
import fs from "fs";
import path from "path";
import { s3 } from "../config/s3";

export async function uploadInvoice(fileName: string) {
  const filePath = path.join("invoices", fileName);
  const fileContent = fs.readFileSync(filePath);

  const key = `invoices/${fileName}`;

  await s3.send(
    new PutObjectCommand({
      Bucket: process.env.AWS_S3_BUCKET!,
      Key: key,
      Body: fileContent,
      ContentType: "application/pdf",
    })
  );

  return { key };
}
