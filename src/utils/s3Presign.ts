import { GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { s3 } from "../config/s3";

export async function presignGetObject(key: string, expiresInSeconds = 60 * 5) {
  const Bucket = process.env.AWS_S3_BUCKET!;
  const command = new GetObjectCommand({ Bucket, Key: key });

  return getSignedUrl(s3, command, { expiresIn: expiresInSeconds });
}