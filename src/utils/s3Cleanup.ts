import { DeleteObjectsCommand } from "@aws-sdk/client-s3";
import { s3 } from "../config/s3";

export type S3CleanupResult = {
  requested: number;
  deleted: number;
  failed: number;
  skipped: number;
  errors: Array<{ key?: string; code?: string; message: string }>;
};

export function normalizeS3ObjectKey(value: unknown): string | null {
  const key = String(value ?? "").trim();
  if (!key) return null;
  if (/^https?:\/\//i.test(key)) return null;
  if (/^s3:\/\//i.test(key)) {
    const withoutScheme = key.slice("s3://".length);
    const slashIndex = withoutScheme.indexOf("/");
    return slashIndex >= 0 ? withoutScheme.slice(slashIndex + 1).trim() || null : null;
  }
  return key.replace(/^\/+/, "") || null;
}

export function collectS3ObjectKeys(values: Iterable<unknown>): string[] {
  const keys = new Set<string>();
  for (const value of values) {
    const key = normalizeS3ObjectKey(value);
    if (key) keys.add(key);
  }
  return [...keys];
}

export async function deleteS3ObjectsBestEffort(keysInput: Iterable<unknown>): Promise<S3CleanupResult> {
  const keys = collectS3ObjectKeys(keysInput);
  const bucket = String(process.env.AWS_S3_BUCKET ?? "").trim();
  const result: S3CleanupResult = {
    requested: keys.length,
    deleted: 0,
    failed: 0,
    skipped: 0,
    errors: [],
  };

  if (keys.length === 0) return result;

  if (!bucket) {
    result.skipped = keys.length;
    result.errors.push({ message: "AWS_S3_BUCKET is not configured" });
    return result;
  }

  for (let index = 0; index < keys.length; index += 1000) {
    const batch = keys.slice(index, index + 1000);
    try {
      const response = await s3.send(
        new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: {
            Objects: batch.map((Key) => ({ Key })),
            Quiet: false,
          },
        }),
      );

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
    } catch (error: any) {
      result.failed += batch.length;
      result.errors.push({
        message: error?.message ?? "S3 batch delete failed",
      });
    }
  }

  return result;
}
