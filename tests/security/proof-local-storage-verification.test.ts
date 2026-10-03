jest.mock("../../src/config/prismaClient", () => ({ __esModule: true, default: require("./fixtures").database }));
jest.mock("../../src/config/s3", () => ({ s3: { send: jest.fn(async () => ({})) } }));
jest.mock("../../src/modules/identity-access", () => ({ buildOrderScopeWhere: jest.fn(async () => ({ ownerOrgId: "company-a" })) }));
jest.mock("../../src/utils/s3Presign", () => ({ presignGetObject: jest.fn(async () => "https://example.test/proof") }));

import * as fs from "fs/promises";
import path from "path";
import os from "os";
import { randomUUID, createHash } from "crypto";
import { database as db } from "./fixtures";
import { s3 } from "../../src/config/s3";
import { submitProofForActor } from "../../src/modules/orders-core/proofs/proof";
import { MAX_PROOF_BYTES } from "../../src/modules/orders-core/proofs/raster-processing";
const { PNG } = require("pngjs");
const fixtureImage = () => PNG.sync.write({ width: 20, height: 10, data: Buffer.alloc(20 * 10 * 4, 255) }, { deflateLevel: 0 });
const actor: any = { id: "driver-a", membershipId: "membership-a", companyMembershipId: "membership-a", companyId: "company-a", tenantId: "tenant-a", tenantMembershipId: "tm-a" };
const originalBucket = process.env.AWS_S3_BUCKET;
const input = () => ({ actor, orderId: "order-a", body: { submissionId: "synthetic-proof-submission", signedBy: "Recipient", signaturePaths: ["1,2;30,40"] }, file: { buffer: fixtureImage(), size: 1, originalname: "camera.png", mimetype: "image/png" } });

// No production local adapter exists. This test-only S3 command substitute performs actual exclusive filesystem I/O.
let root:string,owner:string;const receipts=new Map<string,any>();let writes:Promise<any>[]=[],failSignature=false;
beforeAll(async()=>{owner=randomUUID();root=await fs.mkdtemp(path.join(os.tmpdir(),"cp-proof-owned-"));await fs.writeFile(path.join(root,"owner.json"),JSON.stringify({owner}),{flag:"wx"});});
beforeEach(() => {
  jest.clearAllMocks(); process.env.AWS_S3_BUCKET = "fixture-bucket-never-contacted";
  db.companyMembership.findFirst.mockResolvedValue({
    id: actor.membershipId, companyId: actor.companyId, status: "active", tenantId: actor.tenantId, tenantMembershipId: actor.tenantMembershipId,
    tenant: { id: actor.tenantId, status: "active" }, tenantMembership: { id: actor.tenantMembershipId, tenantId: actor.tenantId, userId: actor.id, status: "active" },
    company: { id: actor.companyId, tenantId: actor.tenantId, isActive: true }, branch: null,
    user: { id: actor.id, name: "Synthetic", email: "fixture@example.test", warehouseId: null, customerEntityId: null },
    scopes: [{ scopeType: "company", scopeRefId: actor.companyId }],
    roles: [{ role: { code: "driver", rolePermissions: ["shipment.update", "shipment.view"].map(key => ({ permission: { key } })) } }],
  });
  db.order.findFirst.mockResolvedValue({ id: "order-a", tenantId: "tenant-a", ownerOrgId: "company-a", assignedDriverId: actor.id, currentWarehouseId: "warehouse-a" });
  db.$queryRaw.mockImplementation(async (parts: any) => String(parts[0]).includes("SELECT") ? [] : [{ proofId: "synthetic-proof-id" }]);
  db.$executeRaw.mockResolvedValue(1);
  db.$transaction.mockImplementation(async (work: any) => work(db));
  db.orderAttachment.create.mockImplementation(async ({ data }: any) => ({ id: "attachment-a", ...data }));
  db.tracking.create.mockResolvedValue({ id: "tracking-a" });
});

beforeEach(()=>{
receipts.clear();writes=[];failSignature=false;
db.$queryRaw.mockImplementation(async(parts:any,...values:any[])=>{
const sql=parts.join("?");if(sql.includes('INSERT INTO "ProofSubmission"')){const [id,proofId,tenantId,companyId,userId,tenantMembershipId,companyMembershipId,orderId,stage,fingerprint,intent,photoSha256,signatureSha256,receivedAt,storageManifest]=values;if(receipts.has(id))return [];receipts.set(id,{proofId,tenantId,companyId,userId,tenantMembershipId,companyMembershipId,orderId,stage,fingerprint,intent,photoSha256,signatureSha256,receivedAt,storageManifest:JSON.parse(storageManifest),state:"accepted"});return [{proofId}];}
if(sql.includes('FROM "ProofSubmission"')){const [id,tenantId,companyId,userId,tenantMembershipId,companyMembershipId]=values,r=receipts.get(id);return r&&r.tenantId===tenantId&&r.companyId===companyId&&r.userId===userId&&r.tenantMembershipId===tenantMembershipId&&r.companyMembershipId===companyMembershipId?[r]:[];}return [];
});
db.$executeRaw.mockImplementation(async(parts:any,...values:any[])=>{const sql=parts.join("?");if(sql.includes("'stored'")&&!sql.includes("'confirmed'")){const r=receipts.get(values[0]);if(r?.state!=="accepted")return 0;r.state="stored";return 1;}if(sql.includes("'confirmed'")){const r=receipts.get(values[1]);if(r?.state!=="stored")return 0;r.state="confirmed";r.result=JSON.parse(values[0]);return 1;}return 0;});
(s3.send as jest.Mock).mockImplementation((command:any)=>{
const work=(async()=>{const v=command.input;expect(v.Bucket).toBe("fixture-bucket-never-contacted");expect(v.IfNoneMatch).toBe("*");expect(v.ContentType).toBe("image/png");expect(v.Body.length).toBeLessThanOrEqual(16*1024*1024);expect(v.ChecksumSHA256).toBe(createHash("sha256").update(v.Body).digest("base64"));
const target=path.resolve(root,v.Key),relative=path.relative(root,target);if(relative.startsWith("..")||path.isAbsolute(relative))throw Error("Foreign test storage path");if(failSignature&&v.Key.endsWith("signature.png"))throw Error("Synthetic signature storage failure");await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,v.Body,{flag:"wx"});return {};})();writes.push(work);return work;
});
});
afterEach(async()=>{await Promise.allSettled(writes);jest.restoreAllMocks();});
afterAll(async()=>{
if(originalBucket===undefined)delete process.env.AWS_S3_BUCKET;else process.env.AWS_S3_BUCKET=originalBucket;
const resolved=await fs.realpath(root),temp=await fs.realpath(os.tmpdir()),relative=path.relative(temp,resolved),marker=JSON.parse(await fs.readFile(path.join(resolved,"owner.json"),"utf8"));
if(marker.owner!==owner||relative.startsWith("..")||path.isAbsolute(relative)||!path.basename(resolved).startsWith("cp-proof-owned-"))throw Error("Refusing cleanup of unowned proof directory");await fs.rm(resolved,{recursive:true});await expect(fs.stat(resolved)).rejects.toMatchObject({code:"ENOENT"});
});
it("actual codec writes bounded PNG photo/signature locally and confirmed retry performs no additional I/O",async()=>{
const request=input(),receivedAt=new Date("2026-10-04T12:00:00Z");const result=await submitProofForActor({...request,receivedAt});const record=receipts.get(request.body.submissionId);expect(record.state).toBe("confirmed");
for(const key of [record.storageManifest.photoKey,record.storageManifest.signatureKey]){const bytes=await fs.readFile(path.resolve(root,key));expect(()=>PNG.sync.read(bytes,{checkCRC:true})).not.toThrow();}
const signature=PNG.sync.read(await fs.readFile(path.resolve(root,record.storageManifest.signatureKey)));expect(signature.width).toBe(328);expect(signature.height).toBe(168);const point=(2*signature.width+1)*4;expect([...signature.data.subarray(point,point+4)]).toEqual([46,107,255,255]);expect([...signature.data.subarray(0,4)]).toEqual([255,255,255,255]);
const photo=await fs.readFile(path.resolve(root,record.storageManifest.photoKey));expect(PNG.sync.read(photo).data).toEqual(PNG.sync.read(request.file.buffer).data);expect(result.proof.savedAt).toBe(receivedAt.toISOString());
const calls=(s3.send as jest.Mock).mock.calls.length,attachments=db.orderAttachment.create.mock.calls.length;expect(await submitProofForActor(request)).toEqual(result);expect(s3.send).toHaveBeenCalledTimes(calls);expect(db.orderAttachment.create).toHaveBeenCalledTimes(attachments);
await expect(submitProofForActor({...request,body:{...request.body,signedBy:"Changed"}})).rejects.toThrow("conflicts");expect(s3.send).toHaveBeenCalledTimes(calls);expect(await fs.readFile(path.resolve(root,record.storageManifest.photoKey))).toEqual(photo);
});
it.each(["CRC","truncated","bytes","dimensions"])("actual codec rejects %s before local storage/acceptance",async kind=>{
const request=input();if(kind==="CRC")request.file.buffer[request.file.buffer.length-1]^=1;if(kind==="truncated")request.file.buffer=request.file.buffer.subarray(0,40);if(kind==="bytes")request.file.buffer=Buffer.alloc(MAX_PROOF_BYTES+1);if(kind==="dimensions")request.file.buffer.writeUInt32BE(50000,16);
await expect(submitProofForActor(request)).rejects.toBeDefined();expect(receipts.size).toBe(0);expect(s3.send).not.toHaveBeenCalled();expect(db.orderAttachment.create).not.toHaveBeenCalled();
});
it("partial local storage remains accepted and immutable retries require reconciliation without replacing files",async()=>{
const request=input();failSignature=true;await expect(submitProofForActor(request)).rejects.toThrow("signature storage failure");await Promise.allSettled(writes);const record=receipts.get(request.body.submissionId),bytes=await fs.readFile(path.resolve(root,record.storageManifest.photoKey));expect(record.state).toBe("accepted");expect(db.orderAttachment.create).not.toHaveBeenCalled();
failSignature=false;const calls=(s3.send as jest.Mock).mock.calls.length;await expect(submitProofForActor(request)).rejects.toMatchObject({code:"PROOF_SUBMISSION_INCOMPLETE"});expect(s3.send).toHaveBeenCalledTimes(calls);expect(await fs.readFile(path.resolve(root,record.storageManifest.photoKey))).toEqual(bytes);
});
it("stored files survive uncertain database outcome and retry does not overwrite or delete",async()=>{
const request=input();db.$transaction.mockRejectedValueOnce(new Error("Synthetic unknown confirmation"));await expect(submitProofForActor(request)).rejects.toThrow("unknown confirmation");const record=receipts.get(request.body.submissionId);expect(record.state).toBe("stored");const bytes=await fs.readFile(path.resolve(root,record.storageManifest.photoKey)),calls=(s3.send as jest.Mock).mock.calls.length;
await expect(submitProofForActor(request)).rejects.toMatchObject({code:"PROOF_SUBMISSION_INCOMPLETE"});expect(s3.send).toHaveBeenCalledTimes(calls);expect(await fs.readFile(path.resolve(root,record.storageManifest.photoKey))).toEqual(bytes);
});
