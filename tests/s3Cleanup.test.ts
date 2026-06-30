import { collectS3ObjectKeys, normalizeS3ObjectKey } from "../src/utils/s3Cleanup";

describe("S3 cleanup key helpers", () => {
  it("normalizes object keys and ignores non-key values", () => {
    expect(normalizeS3ObjectKey(" /labels/a.pdf ")).toBe("labels/a.pdf");
    expect(normalizeS3ObjectKey("")).toBeNull();
    expect(normalizeS3ObjectKey(null)).toBeNull();
    expect(normalizeS3ObjectKey("https://carrier.example/label.pdf")).toBeNull();
    expect(normalizeS3ObjectKey("s3://bucket/invoices/a.pdf")).toBe("invoices/a.pdf");
  });

  it("deduplicates collected object keys", () => {
    expect(
      collectS3ObjectKeys([
        "labels/a.pdf",
        "/labels/a.pdf",
        "invoices/a.pdf",
        "https://carrier.example/label.pdf",
        null,
      ]),
    ).toEqual(["labels/a.pdf", "invoices/a.pdf"]);
  });
});
