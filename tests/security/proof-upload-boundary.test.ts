jest.mock("../../src/config/prismaClient", () => ({ __esModule: true, default: require("./fixtures").database }));
jest.mock("../../src/config/s3", () => ({ s3: { send: jest.fn(async () => ({})) } }));
jest.mock("../../src/modules/identity-access", () => ({ buildOrderScopeWhere: jest.fn(async () => ({ ownerOrgId: "company-a" })) }));
jest.mock("../../src/utils/s3Presign", () => ({ presignGetObject: jest.fn(async () => "https://example.test/proof") }));
jest.mock("../../src/modules/orders-core/repo", () => ({ getOrderById: jest.fn() }));

import { EventEmitter } from "events";
const threads: typeof import("worker_threads") = require("worker_threads");
import { database as db } from "./fixtures";
import { s3 } from "../../src/config/s3";
import { presignGetObject } from "../../src/utils/s3Presign";
import { getOrderById } from "../../src/modules/orders-core/repo";
import { submitProofForActor, listOrderProofLinksForActor } from "../../src/modules/orders-core/proofs/proof";
import { MAX_PROOF_BYTES, processProofRaster, validateProofPng } from "../../src/modules/orders-core/proofs/raster-processing";
const { PNG } = require("pngjs");
const fixtureImage = () => PNG.sync.write({ width: 20, height: 10, data: Buffer.alloc(20 * 10 * 4, 255) }, { deflateLevel: 0 });
const actor: any = { id: "driver-a", membershipId: "membership-a", companyId: "company-a" };
const originalBucket = process.env.AWS_S3_BUCKET;
const input = () => ({ actor, orderId: "order-a", body: { signedBy: "Recipient", signaturePaths: ["1,2;30,40"] }, file: { buffer: fixtureImage(), size: 1, originalname: "camera.png", mimetype: "image/png" } });
beforeEach(() => {
  jest.clearAllMocks(); process.env.AWS_S3_BUCKET = "fixture-bucket-never-contacted";
  db.companyMembership.findFirst.mockResolvedValue({ companyId: "company-a", scopes: [], roles: [{ role: { companyId: "company-a", isSystem: false, rolePermissions: [{ permission: { key: "shipment.update" } }] } }] });
  db.order.findUnique.mockResolvedValue({ id: "order-a", ownerOrgId: "company-a", assignedDriverId: actor.id, currentWarehouseId: "warehouse-a" });
  db.$transaction.mockImplementation(async (work: any) => work(db));
  db.orderAttachment.create.mockImplementation(async ({ data }: any) => ({ id: "attachment-a", ...data }));
  db.tracking.create.mockResolvedValue({ id: "tracking-a" });
});
afterEach(() => { jest.restoreAllMocks(); jest.useRealTimers(); });
afterAll(() => { if (originalBucket === undefined) delete process.env.AWS_S3_BUCKET; else process.env.AWS_S3_BUCKET = originalBucket; });
function noEffects() { expect(s3.send).not.toHaveBeenCalled(); expect(db.orderAttachment.create).not.toHaveBeenCalled(); expect(db.tracking.create).not.toHaveBeenCalled(); }

it("decodes and re-encodes PNG pixels and produces a raster signature using the installed codec", async () => {
  const original = fixtureImage(); const result = await processProofRaster(original, ["1,2;30,40"]);
  expect(result.photo.equals(original)).toBe(false);
  expect(PNG.sync.read(result.photo).data).toEqual(PNG.sync.read(original).data);
  expect(PNG.sync.read(result.signature).width).toBe(328);
  expect(result.signature.includes(Buffer.from("<svg"))).toBe(false);
});

it("uses server receipt time and company/order keys; labels client capture time separately", async () => {
  const receivedAt = new Date("2026-09-06T12:00:00.000Z");
  const request = input(); Object.assign(request.body, { savedAt: "2099-01-01T01:00:00.000Z" });
  const result = await submitProofForActor({ ...request, receivedAt });
  expect(result.proof).toMatchObject({ savedAt: receivedAt.toISOString(), clientCapturedAt: "2099-01-01T01:00:00.000Z" });
  expect(db.tracking.create.mock.calls[0][0].data.timestamp).toEqual(receivedAt);
  const commands = (s3.send as jest.Mock).mock.calls.map(([command]) => command.input);
  expect(commands).toHaveLength(2);
  for (const command of commands) {
    expect(command.Key).toMatch(/^delivery-proofs\/company-a\/order-a\/.+\/.+\.png$/);
    expect(command).toMatchObject({ ContentType: "image/png", ContentDisposition: "attachment", Metadata: { companyid: "company-a", receivedat: receivedAt.toISOString(), clientcapturedat: "2099-01-01T01:00:00.000Z" } });
    expect(() => PNG.sync.read(command.Body)).not.toThrow();
  }
  expect(db.orderAttachment.create.mock.calls[0][0].data.size).toBe(commands[0].Body.length);
});

it.each([
  ["unassigned driver", (request: any) => { request.actor = { ...actor, id: "other-driver" }; }],
  ["missing identity", (request: any) => { request.actor = { id: "" }; }],
  ["foreign company", () => { db.order.findUnique.mockResolvedValue({ id: "order-a", ownerOrgId: "company-b", assignedDriverId: actor.id }); }],
  ["revoked membership", () => { db.companyMembership.findFirst.mockResolvedValue(null); }],
  ["provided SVG signature", (request: any) => { request.body.signatureSvg = '<svg onload="alert(1)"/>'; }],
  ["SVG photo with spoofed MIME", (request: any) => { request.file.buffer = Buffer.from('<svg onload="alert(1)"/>'); }],
  ["SVG filename", (request: any) => { request.file.originalname = "photo.SVG"; }],
  ["unsupported JPEG", (request: any) => { request.file.mimetype = "image/jpeg"; }],
  ["PNG-labelled JPEG bytes", (request: any) => { request.file.buffer = Buffer.from([255, 216, 255, 224, 0, 0]); }],
  ["oversized bytes", (request: any) => { request.file.buffer = Buffer.alloc(MAX_PROOF_BYTES + 1); }],
  ["oversized dimensions", (request: any) => { request.file.buffer.writeUInt32BE(100000, 16); }],
  ["interlaced PNG", (request: any) => { request.file.buffer[28] = 1; }],
  ["CRC corruption", (request: any) => { request.file.buffer[request.file.buffer.length - 1] ^= 1; }],
  ["polyglot trailing content", (request: any) => { request.file.buffer = Buffer.concat([request.file.buffer, Buffer.from('<script>bad</script>')]); }],
  ["unbounded signature", (request: any) => { request.body.signaturePaths = Array(65).fill("1,1"); }],
  ["non-numeric signature", (request: any) => { request.body.signaturePaths = ['1,2;NaN,<script>']; }],
  ["out-of-bounds signature", (request: any) => { request.body.signaturePaths = ['999999,1']; }],
  ["invalid client time", (request: any) => { request.body.savedAt = 'invalid'; }],
])("rejects %s without storage, attachment or tracking effects", async (_label, change) => {
  const request = input(); change(request); await expect(submitProofForActor(request)).rejects.toBeDefined(); noEffects();
});

it("rejects truncated content before codec/storage work", () => {
  expect(() => validateProofPng(fixtureImage().subarray(0, 40))).toThrow(); noEffects();
});

it("preserves best-effort object cleanup when the database transaction fails", async () => {
  db.$transaction.mockRejectedValueOnce(new Error("transaction failed"));
  await expect(submitProofForActor(input())).rejects.toThrow("transaction failed");
  expect((s3.send as jest.Mock).mock.calls.map(([command]) => command.constructor.name)).toEqual(["PutObjectCommand", "PutObjectCommand", "DeleteObjectCommand", "DeleteObjectCommand"]);
});

it("does not presign proof keys belonging to a different order/company", async () => {
  (getOrderById as jest.Mock).mockResolvedValue({ id: "order-a", ownerOrgId: "company-a", trackingEvents: [], attachments: [
    { id: "ok", key: "delivery-proofs/company-a/order-a/proof-a/photo.png" },
    { id: "legacy", key: "pickup-proofs/order-a/proof-old/photo.jpg" },
    { id: "foreign-order", key: "delivery-proofs/company-a/order-b/proof-a/photo.png" },
    { id: "foreign-company", key: "delivery-proofs/company-b/order-a/proof-a/photo.png" },
  ] });
  const result = await listOrderProofLinksForActor({ user: actor, orderId: "order-a", query: {} });
  expect(result.proofs).toHaveLength(2); expect(presignGetObject).toHaveBeenCalledTimes(2);
});

it("bounds worker admission and retains slots until timed-out workers terminate", async () => {
  jest.useFakeTimers();
  const releases: Array<() => void> = []; const workers: any[] = [];
  jest.spyOn(threads, "Worker").mockImplementation((_source: any, options: any) => {
    const worker: any = new EventEmitter();
    const terminated = new Promise<number>((resolve) => releases.push(() => resolve(1)));
    worker.terminate = jest.fn(() => terminated); worker.options = options; workers.push(worker); return worker;
  });
  const a = processProofRaster(fixtureImage(), ["1,2"]).catch((error) => error);
  const b = processProofRaster(fixtureImage(), ["1,2"]).catch((error) => error);
  await expect(processProofRaster(fixtureImage(), ["1,2"])).rejects.toMatchObject({ statusCode: 503 });
  await jest.advanceTimersByTimeAsync(3001);
  expect(workers[0].options.resourceLimits).toMatchObject({ maxOldGenerationSizeMb: 64 });
  expect(workers.every((worker) => worker.terminate.mock.calls.length > 0)).toBe(true);
  await expect(processProofRaster(fixtureImage(), ["1,2"])).rejects.toMatchObject({ statusCode: 503 });
  releases.forEach((release) => release()); await Promise.all([a, b]);
});
