jest.mock("../../src/config/prismaClient", () => ({ __esModule: true, default: new Proxy({}, { get: (_target, name) => { const value = (mockPrisma as any)[name]; return typeof value === "function" ? value.bind(mockPrisma) : value; } }) }));
jest.mock("../../src/config/s3", () => ({ s3: { send: (command: any) => mockStorage(command) } }));
jest.mock("../../src/utils/s3Presign", () => ({ presignGetObject: jest.fn() }));
import { Pool } from "pg";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { randomUUID } from "crypto";
import { createTenantDemoFixture, TENANT_DEMO_IDS as ids } from "../../src/modules/tenancy/demo-fixtures";
import { persistTenantDemoFixture } from "../tenancy/postgres-fixture.persistence";
import { submitProofForActor } from "../../src/modules/orders-core/proofs/proof";
import { acceptProof } from "../../src/modules/orders-core/proofs/submission";

const url = process.env.CARGOPILOT_WORKER_TEST_DATABASE_URL, runId = process.env.CARGOPILOT_WORKER_RUN_ID;
if (!url || !runId || !/^[a-f0-9]{12}$/.test(runId)) throw Error("Disposable proof test identity required");
const target = new URL(url);
if (target.hostname !== "127.0.0.1" || target.username !== "cp_worker_it" || target.pathname !== `/cp_worker_${runId}`) throw Error("Refusing existing PostgreSQL target");
const pool = new Pool({ connectionString: url, max: 2, connectionTimeoutMillis: 3000, options: "-c statement_timeout=5000" });
let mockPrisma: PrismaClient, orderId: string;
const objects = new Map<string, Buffer>();
const mockStorage = jest.fn(async (command: any) => { objects.set(command.input.Key, Buffer.from(command.input.Body)); return {}; });
const actor: any = { id: ids.users.maker, tenantId: ids.tenants.transAsia, tenantMembershipId: ids.tenantMemberships.makerTransAsia, companyId: ids.organizations.transAsiaUz, companyMembershipId: ids.companyMemberships.makerTransAsiaUz, membershipId: ids.companyMemberships.makerTransAsiaUz };
const { PNG } = require("pngjs");
const image = () => PNG.sync.write({width:2,height:2,data:Buffer.alloc(16,255)});
const request = (submissionId = randomUUID()) => ({ actor, orderId, body: { submissionId, stage: "delivery", signedBy: "Synthetic recipient", clientCapturedAt: "2026-10-01T12:00:00.000Z", signaturePaths: ["1,2;3,4"] }, file: { buffer:image(), size:1, mimetype:"image/png", originalname:"proof.png" } });
const receipts = (id: string) => mockPrisma.$queryRaw<any[]>`SELECT * FROM "ProofSubmission" WHERE "submissionId" = ${id}`;
const counts = async () => ({ attachments:await mockPrisma.orderAttachment.count({where:{orderId}}), tracking:await mockPrisma.tracking.count({where:{orderId}}) });
beforeAll(async () => {
  const marker = await pool.query('SELECT "runId" FROM "_CPDisposableRun"');
  if (marker.rows.length !== 1 || marker.rows[0].runId !== runId) throw Error("Disposable ownership mismatch");
  const client = await pool.connect();
  try { await client.query("BEGIN"); await persistTenantDemoFixture(client,createTenantDemoFixture()); await client.query("COMMIT"); } finally {client.release();}
  mockPrisma = new PrismaClient({ adapter:new PrismaPg({connectionString:url,max:6,connectionTimeoutMillis:3000,options:"-c statement_timeout=5000"}) });
  await mockPrisma.user.update({where:{id:actor.id},data:{driverType:"local"}});
  const role = await mockPrisma.role.create({data:{companyId:actor.companyId,code:"synthetic-proof",name:"Synthetic proof"}});
  for(const key of ["shipment.view","shipment.update"]) {
    const permission=await mockPrisma.permission.create({data:{key,resource:"synthetic-proof",action:key}});
    await mockPrisma.rolePermission.create({data:{roleId:role.id,permissionId:permission.id}});
  }
  await mockPrisma.membershipRole.create({data:{membershipId:actor.membershipId,roleId:role.id}});
  await mockPrisma.membershipScope.create({data:{membershipId:actor.membershipId,scopeType:"company",scopeRefId:actor.companyId}});
  process.env.AWS_S3_BUCKET="synthetic-mocked-bucket-never-contacted";
});
beforeEach(async () => {
  mockStorage.mockReset(); objects.clear(); mockStorage.mockImplementation(async command=>{objects.set(command.input.Key,Buffer.from(command.input.Body));return {};});
  await mockPrisma.companyMembership.update({where:{id:actor.membershipId},data:{status:"active"}});
  orderId=randomUUID(); await mockPrisma.order.create({data:{id:orderId,orderNumber:`SYNTHETIC-${orderId}`,tenantId:actor.tenantId,ownerOrgId:actor.companyId,assignedDriverId:actor.id,customerId:ids.users.multiTenant,pickupAddress:"Synthetic",dropoffAddress:"Synthetic",status:"in_transit"}});
});
afterEach(()=>jest.restoreAllMocks());
afterAll(async()=>{await mockPrisma?.$disconnect();await pool.end();delete process.env.AWS_S3_BUCKET;});
it("confirms once and identical normalized retry returns the original receipt with no new storage/tracking",async()=>{
  const input=request();const first=await submitProofForActor(input);const second=await submitProofForActor({...input,body:{...input.body,signedBy:"  Synthetic recipient ",signaturePaths:["1.0,2.0;3.0,4.0"]}});
  expect(second).toEqual(first);expect(second.proofReplay).toBe(true);expect(mockStorage).toHaveBeenCalledTimes(2);expect(await counts()).toEqual({attachments:2,tracking:1});expect((await receipts(input.body.submissionId))[0].state).toBe("confirmed");
});
it.each(["photo","signature","name","time","stage"])("rejects %s conflict without new business effects",async field=>{
  const input=request();await submitProofForActor(input);const altered:any={...input,body:{...input.body}};
  if(field==="photo") altered.file={...input.file,buffer:PNG.sync.write({width:2,height:2,data:Buffer.alloc(16,100)})};
  if(field==="signature") altered.body.signaturePaths=["2,3"];
  if(field==="name") altered.body.signedBy="Different synthetic";
  if(field==="time") altered.body.clientCapturedAt="2026-10-02T12:00:00.000Z";
  if(field==="stage") altered.body.stage="pickup";
  await expect(submitProofForActor(altered)).rejects.toMatchObject({statusCode:409});expect(await counts()).toEqual({attachments:2,tracking:1});expect(mockStorage).toHaveBeenCalledTimes(2);
});
it("concurrent identical submissions yield one confirmed business result",async()=>{
  const input=request();const results=await Promise.allSettled([submitProofForActor(input),submitProofForActor(input)]);
  expect(results.some(r=>r.status==="fulfilled")).toBe(true);
  for(const r of results) if(r.status==="rejected") expect(r.reason).toMatchObject({statusCode:409,code:"PROOF_SUBMISSION_INCOMPLETE"});
  await expect(submitProofForActor(input)).resolves.toMatchObject({success:true});expect(await counts()).toEqual({attachments:2,tracking:1});expect(mockStorage).toHaveBeenCalledTimes(2);expect((await receipts(input.body.submissionId))).toHaveLength(1);
});
it.each(["foreign-tenant","foreign-company","wrong-order","revoked"])("denies %s retry before receipt return or storage",async kind=>{
  const input=request();await submitProofForActor(input);let altered:any={...input};
  if(kind==="foreign-tenant") altered.actor={...actor,tenantId:ids.tenants.unrelated};
  if(kind==="foreign-company") altered.actor={...actor,companyId:ids.organizations.transAsiaDe};
  if(kind==="wrong-order") altered.orderId=ids.orders.unrelated;
  if(kind==="revoked") await mockPrisma.companyMembership.update({where:{id:actor.membershipId},data:{status:"suspended"}});
  await expect(submitProofForActor(altered)).rejects.toBeDefined();expect(mockStorage).toHaveBeenCalledTimes(2);expect(await counts()).toEqual({attachments:2,tracking:1});
});
it("transaction failure rolls back attachments, tracking and confirmation, retaining stored receipt/objects",async()=>{
  const input=request(), original=mockPrisma.$transaction.bind(mockPrisma);
  jest.spyOn(mockPrisma,"$transaction").mockImplementationOnce(((work:any)=>original(async tx=>work(new Proxy(tx,{get:(target,name)=>name==="$executeRaw"?async()=>{throw Error("synthetic confirmation failure");}:Reflect.get(target,name)})))) as any);
  await expect(submitProofForActor(input)).rejects.toThrow("synthetic confirmation failure");expect(await counts()).toEqual({attachments:0,tracking:0});expect((await receipts(input.body.submissionId))[0]).toMatchObject({state:"stored",result:null});expect(objects.size).toBe(2);
  await expect(submitProofForActor(input)).rejects.toMatchObject({code:"PROOF_SUBMISSION_INCOMPLETE"});expect(mockStorage).toHaveBeenCalledTimes(2);
});
it("uncertain storage write leaves accepted receipt and cannot blindly replay",async()=>{
  const input=request();mockStorage.mockImplementation(async command=>{objects.set(command.input.Key,Buffer.from(command.input.Body));throw Error("synthetic storage uncertainty");});
  await expect(submitProofForActor(input)).rejects.toThrow("synthetic storage uncertainty");expect((await receipts(input.body.submissionId))[0].state).toBe("accepted");expect(await counts()).toEqual({attachments:0,tracking:0});
  await expect(submitProofForActor(input)).rejects.toMatchObject({code:"PROOF_SUBMISSION_INCOMPLETE"});expect(mockStorage).toHaveBeenCalledTimes(2);
});
it("crash after durable acceptance causes no later storage effects",async()=>{
  const input=request();await acceptProof({submissionId:input.body.submissionId,actor,orderId,stage:"delivery",bucket:"synthetic-mocked-bucket-never-contacted",receivedAt:new Date(),fingerprint:"a".repeat(64),intent:{synthetic:true},photoSha256:"a".repeat(64),signatureSha256:"b".repeat(64)});
  await expect(submitProofForActor(input)).rejects.toMatchObject({statusCode:409});expect(mockStorage).not.toHaveBeenCalled();expect(await counts()).toEqual({attachments:0,tracking:0});
});
it("database compound constraints reject wrong membership/company bridges and confirmed receipt rewriting",async()=>{
  const input=request();await expect(acceptProof({submissionId:input.body.submissionId,actor:{...actor,companyId:ids.organizations.transAsiaDe},orderId,stage:"delivery",bucket:"synthetic-mocked-bucket-never-contacted",receivedAt:new Date(),fingerprint:"a".repeat(64),intent:{},photoSha256:"a".repeat(64),signatureSha256:"a".repeat(64)})).rejects.toBeDefined();expect(await receipts(input.body.submissionId)).toHaveLength(0);
  await submitProofForActor(input);await expect(mockPrisma.$executeRaw`UPDATE "ProofSubmission" SET "fingerprint" = ${"b".repeat(64)} WHERE "submissionId" = ${input.body.submissionId}`).rejects.toBeDefined();expect(await counts()).toEqual({attachments:2,tracking:1});
});
it("a lost database commit acknowledgement returns the original confirmed result on retry",async()=>{
  const input=request(), original=mockPrisma.$transaction.bind(mockPrisma);
  jest.spyOn(mockPrisma,"$transaction").mockImplementationOnce((async(work:any)=>{await original(work);throw Error("synthetic commit acknowledgement lost");}) as any);
  await expect(submitProofForActor(input)).rejects.toThrow("synthetic commit acknowledgement lost");
  expect((await receipts(input.body.submissionId))[0].state).toBe("confirmed");
  await expect(submitProofForActor(input)).resolves.toMatchObject({success:true,proof:{submissionId:input.body.submissionId}});
  expect(await counts()).toEqual({attachments:2,tracking:1});expect(mockStorage).toHaveBeenCalledTimes(2);expect(objects.size).toBe(2);
});
it("loss between storage completion and state recording stays accepted and never overwrites objects",async()=>{
  const input=request();jest.spyOn(mockPrisma,"$executeRaw").mockRejectedValueOnce(Error("synthetic stored acknowledgement failure"));
  await expect(submitProofForActor(input)).rejects.toThrow("synthetic stored acknowledgement failure");
  expect((await receipts(input.body.submissionId))[0].state).toBe("accepted");expect(objects.size).toBe(2);expect(await counts()).toEqual({attachments:0,tracking:0});
  await expect(submitProofForActor(input)).rejects.toMatchObject({code:"PROOF_SUBMISSION_INCOMPLETE"});expect(mockStorage).toHaveBeenCalledTimes(2);
});
it("reuse for a different currently authorized order conflicts before storage",async()=>{
  const input=request();await submitProofForActor(input);
  const otherId=randomUUID();await mockPrisma.order.create({data:{id:otherId,orderNumber:`SYNTHETIC-${otherId}`,tenantId:actor.tenantId,ownerOrgId:actor.companyId,assignedDriverId:actor.id,customerId:ids.users.multiTenant,pickupAddress:"Synthetic",dropoffAddress:"Synthetic",status:"in_transit"}});
  await expect(submitProofForActor({...input,orderId:otherId})).rejects.toMatchObject({statusCode:409});expect(await mockPrisma.orderAttachment.count({where:{orderId:otherId}})).toBe(0);expect(await mockPrisma.tracking.count({where:{orderId:otherId}})).toBe(0);expect(mockStorage).toHaveBeenCalledTimes(2);
});
