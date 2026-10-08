import type { Prisma, PrismaClient } from "@prisma/client";
import { z } from "zod";
import type { AppUser } from "../../../types/app-user";
import { lockCredentialUser } from "./credential-lock";
import { requireAcceptedDriver } from "./driver-eligibility";
import { OPERATIONAL_PROFILES } from "./operational-profiles";
import { clearIdentityAccessCacheForUser } from "../access-control";
import { companyMembershipPrimitives } from "./company-delegation";
import { authenticateControlledOperatorPermit } from "./tenant-onboarding";
import { delegationFingerprint, operationIdSchema, reasonSchema, warehouseIdsSchema } from "./operational-profiles";
import { CASH_CAPABILITY_DELEGATION_REVISION, CASH_CAPABILITY_PROFILES, cashCapabilityProfileSchema, cashCapabilityProfilesSchema, cashKindsSchema } from "./cash-capability-profiles";
const { context, member, agrees, keys, staticRole, revokeContextSessions } = companyMembershipPrimitives;
type Tx = Prisma.TransactionClient;
type Context = ReturnType<typeof context>;
const resources = { warehouseIds: warehouseIdsSchema.refine(v=>v.length>0,"Cash warehouse ceiling required"), kinds: cashKindsSchema };
const options = { maxWait: 3000, timeout: 15000 };
function fail(code: string, statusCode = 403): never { throw Object.assign(new Error(code), { code, statusCode }); }
const authorityKey = (kind: string) => kind === "proposer" ? "membership.proposeCashCapability" : "membership.approveCashCapability";
async function serialize(tx: Tx, companyId: string) {
  await tx.$executeRaw`SET LOCAL lock_timeout='3000ms'`;
  await tx.$executeRaw`SET LOCAL statement_timeout='5000ms'`;
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${"cash-capability-grants:" + companyId},0))::text`;
}
async function entity(tx: Tx, c: {tenantId: string; companyId: string}, id: string) {
  await tx.$queryRaw`SELECT id FROM "FinanceLegalEntity" WHERE id=${id}::uuid AND "tenantId"=${c.tenantId}::uuid AND "companyId"=${c.companyId}::uuid FOR SHARE`;
  if (!await tx.financeLegalEntity.findFirst({where:{id,tenantId:c.tenantId,companyId:c.companyId,isActive:true}})) fail("CASH_CAPABILITY_ENTITY_UNAVAILABLE");
}
async function authority(tx: Tx, c: Context, kind: "proposer"|"checker", entityId: string, profiles: string[], warehouseIds: string[], kinds: string[]) {
  const m = await member(tx,c.companyMembershipId,true); agrees(m,c);
  const a = (await tx.$queryRaw<any[]>`SELECT d.*,j.result,j.action FROM "CashCapabilityDelegationAuthority" d
    JOIN "CashCapabilityGrantAction" j ON j."operationId"=d."acceptedOperationId" AND j."targetMembershipId"=d."membershipId"
      AND j."tenantId"=d."tenantId" AND j."companyId"=d."companyId" AND j."legalEntityId"=d."legalEntityId"
    WHERE d."membershipId"=${m.id}::uuid AND d.kind=${kind} FOR UPDATE OF d`)[0];
  validateAuthority(a,m,c,kind,entityId,profiles);
  await entity(tx,c,entityId);
  if(warehouseIds.some(id=>!a.warehouseIds.includes(id))||kinds.some(k=>!a.kinds.includes(k)))fail("CASH_CAPABILITY_RESOURCE_CEILING");
  const owned=await tx.warehouse.findMany({where:{id:{in:warehouseIds},tenantId:c.tenantId},select:{id:true}});
  if(owned.length!==warehouseIds.length)fail("CASH_CAPABILITY_FOREIGN_WAREHOUSE");
  return a;
}
// Shared pure predicate: discovery does not take the mutation's write locks.
function validateAuthority(a:any,m:Awaited<ReturnType<typeof member>>,c:Context,kind:string,entityId:string,profiles:string[]) {
  if (!a?.enabled || a.legalEntityId !== entityId || a.tenantId !== c.tenantId || a.companyId !== c.companyId || a.userId !== c.id ||
    a.tenantMembershipId !== c.tenantMembershipId || !keys(m).includes(authorityKey(kind)) ||
    a.action!=="operator-authorize"||a.result?.companyMembershipId!==m.id||a.result?.kind!==kind||a.result?.legalEntityId!==entityId||
    JSON.stringify(a.result?.profileRevisions)!==JSON.stringify(a.profileRevisions)||
    JSON.stringify(a.result?.warehouseIds)!==JSON.stringify(a.warehouseIds)||JSON.stringify(a.result?.kinds)!==JSON.stringify(a.kinds)||
    !m.scopes.some(s=>s.scopeType==="company" && s.scopeRefId===c.companyId) || profiles.some(p=>!a.profileRevisions.includes(p))) fail("CASH_CAPABILITY_CEILING_REQUIRED");
}
async function receipt(tx: Tx, operationId: string, fingerprint: string, c: {tenantId:string; companyId:string}) {
  const a = (await tx.$queryRaw<any[]>`SELECT * FROM "CashCapabilityGrantAction" WHERE "operationId"=${operationId}::uuid`)[0];
  if (a && (a.fingerprint!==fingerprint || a.tenantId!==c.tenantId || a.companyId!==c.companyId)) fail("CASH_CAPABILITY_INTENT_CONFLICT",409);
  return a?.result;
}
async function audit(tx: Tx, v: {operationId:string; legalEntityId:string; reason:string}, c: {tenantId:string;companyId:string},
  action:string, fingerprint:string, targetMembershipId:string, result:object, actor?:Context, operatorKeyFingerprint?:string, proposalId?:string) {
  await tx.$executeRaw`INSERT INTO "CashCapabilityGrantAction" ("operationId","tenantId","companyId","legalEntityId",action,fingerprint,"targetMembershipId","actorMembershipId","actorUserId","operatorKeyFingerprint",reason,result,"proposalId","operatorId")
    VALUES (${v.operationId}::uuid,${c.tenantId}::uuid,${c.companyId}::uuid,${v.legalEntityId}::uuid,${action},${fingerprint},${targetMembershipId}::uuid,
      ${actor?.companyMembershipId??null}::uuid,${actor?.id??null}::uuid,${operatorKeyFingerprint??null},${v.reason},${JSON.stringify(result)}::jsonb,${proposalId??null}::uuid,${operatorKeyFingerprint?"cargopilot-bootstrap-owner":null})`;
  const warehouses=(result as {warehouseIds?:string[]}).warehouseIds??(v as {warehouseIds?:string[]}).warehouseIds??[];
  for(const warehouseId of warehouses)await tx.$executeRaw`INSERT INTO "CashCapabilityActionWarehouse" ("operationId","tenantId","companyId","warehouseId") VALUES (${v.operationId}::uuid,${c.tenantId}::uuid,${c.companyId}::uuid,${warehouseId}::uuid)`;
}
const ownerSchema=z.object({operationId:operationIdSchema,membershipId:operationIdSchema,userId:operationIdSchema,tenantId:operationIdSchema,companyId:operationIdSchema,tenantMembershipId:operationIdSchema,legalEntityId:operationIdSchema,
  action:z.enum(["operator-authorize","operator-revoke"]),kind:z.enum(["proposer","checker"]),profileRevisions:z.array(cashCapabilityProfileSchema).min(1).max(3).refine(v=>new Set(v).size===v.length).transform(v=>[...v].sort()),
  profileRevision:z.literal(CASH_CAPABILITY_DELEGATION_REVISION),...resources,reason:reasonSchema}).strict();
/** Deterministic preparation only; neither authorizes nor signs a permit. */
export function normalizeCashCapabilityAuthorityIntent(input:unknown) {
  const intent=ownerSchema.parse(input);
  return {intent,fingerprint:delegationFingerprint("cash-owner",intent)};
}
/** Controlled owner invocation only; no HTTP owner endpoint or signing helper. */
export async function authorizeCashCapabilityDelegator(db:PrismaClient,args:{intent:unknown;permit:unknown;signature:string}) {
  const {intent:v,fingerprint}=normalizeCashCapabilityAuthorityIntent(args.intent);
  const authenticate=()=>authenticateControlledOperatorPermit(args.permit,args.signature,v.operationId,fingerprint,CASH_CAPABILITY_DELEGATION_REVISION);
  authenticate();
  const hint=await db.companyMembership.findUnique({where:{id:v.membershipId},select:{userId:true,companyId:true}});
  if(!hint)fail("CASH_CAPABILITY_MEMBER_UNAVAILABLE");
  return db.$transaction(async tx=>{
    await lockCredentialUser(tx,hint.userId);await serialize(tx,hint.companyId);
    const m=await member(tx,v.membershipId,true),c={tenantId:m.tenantId!,companyId:m.companyId};
    const verified=authenticate();
    if(m.userId!==v.userId||m.tenantId!==v.tenantId||m.companyId!==v.companyId||m.tenantMembershipId!==v.tenantMembershipId)fail("CASH_CAPABILITY_OWNER_CONTEXT");
    await entity(tx,c,v.legalEntityId);
    if((await tx.warehouse.count({where:{id:{in:v.warehouseIds},tenantId:c.tenantId}}))!==v.warehouseIds.length)fail("CASH_CAPABILITY_FOREIGN_WAREHOUSE");
    const prior=await receipt(tx,v.operationId,fingerprint,c);if(prior)return prior;
    if(m.roles.some(r=>r.role.isSystem||r.role.isOwnerRole||r.role.companyId!==m.companyId) ||
      !m.scopes.some(s=>s.scopeType==="company"&&s.scopeRefId===m.companyId))fail("CASH_CAPABILITY_COMPANY_ADMIN_REQUIRED");
    const code="cash-capability-"+v.kind+".v1";
    const role=await staticRole(tx,m.companyId,code,[authorityKey(v.kind)]);
    if(v.action==="operator-authorize") {
      await tx.membershipRole.upsert({where:{membershipId_roleId:{membershipId:m.id,roleId:role.id}},create:{membershipId:m.id,roleId:role.id},update:{}});
      await tx.$executeRaw`INSERT INTO "CashCapabilityDelegationAuthority" ("membershipId",kind,"userId","tenantId","companyId","tenantMembershipId","legalEntityId","profileRevisions","warehouseIds",kinds,"acceptedOperationId")
        VALUES (${m.id}::uuid,${v.kind},${m.userId}::uuid,${c.tenantId}::uuid,${c.companyId}::uuid,${m.tenantMembershipId}::uuid,${v.legalEntityId}::uuid,${v.profileRevisions}::text[],${v.warehouseIds}::uuid[],${v.kinds}::text[],${v.operationId}::uuid)
        ON CONFLICT ("membershipId",kind) DO UPDATE SET "legalEntityId"=EXCLUDED."legalEntityId","profileRevisions"=EXCLUDED."profileRevisions","warehouseIds"=EXCLUDED."warehouseIds",kinds=EXCLUDED.kinds,"acceptedOperationId"=EXCLUDED."acceptedOperationId",enabled=true`;
    } else {
      await tx.$executeRaw`UPDATE "CashCapabilityDelegationAuthority" SET enabled=false WHERE "membershipId"=${m.id}::uuid AND kind=${v.kind}`;
      await tx.membershipRole.deleteMany({where:{membershipId:m.id,roleId:role.id}});
    }
    const result={companyMembershipId:m.id,kind:v.kind,action:v.action,legalEntityId:v.legalEntityId,profileRevisions:v.profileRevisions,warehouseIds:v.warehouseIds,kinds:v.kinds};
    await revokeContextSessions(tx,m);await audit(tx,v,c,v.action,fingerprint,m.id,result,undefined,verified.keyFingerprint);return result;
  },options).finally(()=>clearIdentityAccessCacheForUser(hint.userId));
}
const proposalSchema=z.object({operationId:operationIdSchema,membershipId:operationIdSchema,legalEntityId:operationIdSchema,
  profileRevisions:cashCapabilityProfilesSchema,...resources,expectedAcceptanceId:operationIdSchema.nullable(),reason:reasonSchema}).strict();
async function grant(tx:Tx,id:string) {
  const g=(await tx.$queryRaw<any[]>`SELECT g.*,a.action,a.result FROM "CashCapabilityMembershipGrant" g
    JOIN "CashCapabilityGrantAction" a ON a."operationId"=g."acceptedOperationId" AND a."targetMembershipId"=g."membershipId"
      AND a."tenantId"=g."tenantId" AND a."companyId"=g."companyId" AND a."legalEntityId"=g."legalEntityId"
    WHERE g."membershipId"=${id}::uuid FOR UPDATE OF g`)[0];
  validateGrant(g);return g;
}
function validateGrant(g:any) {
  if(g&&(g.action!=="accept"||g.result?.acceptanceId!==g.acceptedOperationId||
    g.result?.legalEntityId!==g.legalEntityId||JSON.stringify(g.result?.warehouseIds)!==JSON.stringify(g.warehouseIds)||JSON.stringify(g.result?.kinds)!==JSON.stringify(g.kinds)||
    JSON.stringify(g.result?.profileRevisions)!==JSON.stringify(g.profileRevisions)))fail("CASH_CAPABILITY_GRANT_INCONSISTENT");
}
async function eligibleTarget(tx:Tx,c:Context,id:string) {
  const m=await member(tx,id,true);
  validateTarget(m,c);
  return m;
}
function validateTarget(m:Awaited<ReturnType<typeof member>>,c:Context){
  if(m.userId===c.id || m.tenantId!==c.tenantId || m.companyId!==c.companyId || m.roles.some(r=>r.role.isSystem||r.role.isOwnerRole||r.role.companyId!==c.companyId))fail("CASH_CAPABILITY_TARGET_REJECTED");
}
/** Revocation-only ownership reader. A suspended recipient must not prevent
 * removal of its accepted grant; this confers no business execution authority. */
async function revocationTarget(tx:Tx,c:Context,id:string) {
  await tx.$queryRaw`SELECT id FROM "CompanyMembership" WHERE id=${id}::uuid FOR UPDATE`;
  const m=await tx.companyMembership.findUnique({where:{id},include:{
    user:{select:{id:true,email:true}},company:{select:{id:true,tenantId:true,type:true,isActive:true}},tenant:{select:{id:true,status:true}},
    tenantMembership:{select:{id:true,userId:true,tenantId:true,status:true}},
    roles:{include:{role:{include:{rolePermissions:{include:{permission:{select:{key:true}}}}}}}},scopes:true}});
  if(!m||m.userId===c.id||m.tenantId!==c.tenantId||m.companyId!==c.companyId||m.company.tenantId!==c.tenantId||
    !m.tenantMembership||m.tenantMembership.id!==m.tenantMembershipId||m.tenantMembership.userId!==m.userId||m.tenantMembership.tenantId!==c.tenantId)
    fail("CASH_CAPABILITY_TARGET_REJECTED");
  return m;
}
function expected(g:any,id:string|null) { if((g?.acceptedOperationId??null)!==id)fail("CASH_CAPABILITY_GRANT_STALE",409); }
function withinRemoved(a:any,g:any) {
  if(g?.enabled && (g.legalEntityId!==a.legalEntityId || g.profileRevisions.some((p:string)=>!a.profileRevisions.includes(p))||g.warehouseIds.some((id:string)=>!a.warehouseIds.includes(id))||g.kinds.some((k:string)=>!a.kinds.includes(k))))fail("CASH_CAPABILITY_REMOVAL_CEILING");
}
export async function proposeCashCapabilityGrant(db:PrismaClient,actor:AppUser,input:unknown) {
  const c=context(actor),v=proposalSchema.parse(input),fingerprint=delegationFingerprint("cash-proposal",{...c,...v});
  const hint=await db.companyMembership.findUnique({where:{id:v.membershipId},select:{userId:true}});if(!hint)fail("CASH_CAPABILITY_TARGET_REJECTED");
  return db.$transaction(async tx=>{
    await lockCashDriver(tx,v.membershipId);
    for(const id of [...new Set([c.id,hint.userId])].sort())await lockCredentialUser(tx,id);
    await serialize(tx,c.companyId);const a=await authority(tx,c,"proposer",v.legalEntityId,v.profileRevisions,v.warehouseIds,v.kinds);
    const m=await eligibleTarget(tx,c,v.membershipId),g=await grant(tx,m.id);withinRemoved(a,g);
    await validateCashBase(tx,m,v.profileRevisions[0],v.warehouseIds);
    const old=(await tx.$queryRaw<any[]>`SELECT * FROM "CashCapabilityGrantProposal" WHERE "operationId"=${v.operationId}::uuid`)[0];
    if(old){if(old.fingerprint!==fingerprint)fail("CASH_CAPABILITY_INTENT_CONFLICT",409);return {proposalId:old.operationId,fingerprint:old.fingerprint};}
    expected(g,v.expectedAcceptanceId);
    await tx.$executeRaw`INSERT INTO "CashCapabilityGrantProposal" ("operationId","tenantId","companyId","legalEntityId","proposerMembershipId","proposerUserId","targetMembershipId","recipientUserId","profileRevisions","warehouseIds",kinds,"expectedAcceptanceId","expectedEnabled","proposerAcceptanceId",fingerprint,reason)
      VALUES (${v.operationId}::uuid,${c.tenantId}::uuid,${c.companyId}::uuid,${v.legalEntityId}::uuid,${c.companyMembershipId}::uuid,${c.id}::uuid,${m.id}::uuid,${m.userId}::uuid,${v.profileRevisions}::text[],${v.warehouseIds}::uuid[],${v.kinds}::text[],${v.expectedAcceptanceId}::uuid,${g?.enabled??false},${a.acceptedOperationId}::uuid,${fingerprint},${v.reason})`;
    await audit(tx,v,c,"propose",fingerprint,m.id,{proposalId:v.operationId},c);
    return {proposalId:v.operationId,fingerprint};
  },options);
}
const decisionSchema=z.object({operationId:operationIdSchema,proposalId:operationIdSchema,fingerprint:z.string().regex(/^[a-f0-9]{64}$/),reason:reasonSchema}).strict();
export async function acceptCashCapabilityGrant(db:PrismaClient,actor:AppUser,input:unknown) {
  const c=context(actor),v=decisionSchema.parse(input),fingerprint=delegationFingerprint("cash-accept",{...c,...v});
  const hint=(await db.$queryRaw<any[]>`SELECT * FROM "CashCapabilityGrantProposal" WHERE "operationId"=${v.proposalId}::uuid AND "tenantId"=${c.tenantId}::uuid AND "companyId"=${c.companyId}::uuid`)[0];
  if(!hint)fail("CASH_CAPABILITY_PROPOSAL_UNAVAILABLE");
  return db.$transaction(async tx=>{
    await lockCashDriver(tx,hint.targetMembershipId);
    for(const id of [...new Set([c.id,hint.proposerUserId,hint.recipientUserId])].sort())await lockCredentialUser(tx,id);
    await serialize(tx,c.companyId);
    const p=(await tx.$queryRaw<any[]>`SELECT * FROM "CashCapabilityGrantProposal" WHERE "operationId"=${v.proposalId}::uuid FOR SHARE`)[0];
    if(!p || p.fingerprint!==v.fingerprint || p.tenantId!==c.tenantId || p.companyId!==c.companyId)fail("CASH_CAPABILITY_PROPOSAL_CONFLICT",409);
    if(c.id===p.proposerUserId || c.id===p.recipientUserId)fail("CASH_CAPABILITY_INDEPENDENT_CHECKER_REQUIRED");
    const checker=await authority(tx,c,"checker",p.legalEntityId,p.profileRevisions,p.warehouseIds,p.kinds);
    const maker=await member(tx,p.proposerMembershipId,true);
    const proposer={id:maker.userId,tenantId:maker.tenantId!,companyId:maker.companyId,tenantMembershipId:maker.tenantMembershipId!,companyMembershipId:maker.id};
    const a=await authority(tx,proposer,"proposer",p.legalEntityId,p.profileRevisions,p.warehouseIds,p.kinds);
    if(a.acceptedOperationId!==p.proposerAcceptanceId)fail("CASH_CAPABILITY_PROPOSER_ACCEPTANCE_CHANGED",409);
    const m=await eligibleTarget(tx,c,p.targetMembershipId),g=await grant(tx,m.id);
    const old=await receipt(tx,v.operationId,fingerprint,c);
    if(old){if(!g?.enabled||g.acceptedOperationId!==v.operationId)fail("CASH_CAPABILITY_RECEIPT_NOT_CURRENT");return old;}
    if((await tx.$queryRaw<any[]>`SELECT 1 FROM "CashCapabilityGrantAction" WHERE "proposalId"=${p.operationId}::uuid AND action='accept'`).length)fail("CASH_CAPABILITY_PROPOSAL_ALREADY_ACCEPTED",409);
    expected(g,p.expectedAcceptanceId);
    if((g?.enabled??false)!==p.expectedEnabled)fail("CASH_CAPABILITY_GRANT_STALE",409);
    withinRemoved(a,g);withinRemoved(checker,g);
    await validateCashBase(tx,m,p.profileRevisions[0],p.warehouseIds);
    await tx.$executeRaw`INSERT INTO "CashCapabilityMembershipGrant" ("membershipId","userId","tenantId","companyId","tenantMembershipId","legalEntityId","profileRevisions","warehouseIds",kinds,"acceptedOperationId")
      VALUES (${m.id}::uuid,${m.userId}::uuid,${c.tenantId}::uuid,${c.companyId}::uuid,${m.tenantMembershipId}::uuid,${p.legalEntityId}::uuid,${p.profileRevisions}::text[],${p.warehouseIds}::uuid[],${p.kinds}::text[],${v.operationId}::uuid)
      ON CONFLICT ("membershipId") DO UPDATE SET "profileRevisions"=EXCLUDED."profileRevisions","warehouseIds"=EXCLUDED."warehouseIds",kinds=EXCLUDED.kinds,"acceptedOperationId"=EXCLUDED."acceptedOperationId",enabled=true`;
    const result={companyMembershipId:m.id,legalEntityId:p.legalEntityId,profileRevisions:p.profileRevisions,warehouseIds:p.warehouseIds,kinds:p.kinds,acceptanceId:v.operationId};
    await audit(tx,{...v,legalEntityId:p.legalEntityId},c,"accept",fingerprint,m.id,result,c,undefined,p.operationId);
    await revokeContextSessions(tx,m);return result;
  },options).finally(()=>clearIdentityAccessCacheForUser(hint.recipientUserId));
}
const revokeSchema=z.object({operationId:operationIdSchema,membershipId:operationIdSchema,legalEntityId:operationIdSchema,expectedAcceptanceId:operationIdSchema,reason:reasonSchema}).strict();
export async function revokeCashCapabilityGrant(db:PrismaClient,actor:AppUser,input:unknown) {
  const c=context(actor),v=revokeSchema.parse(input),fingerprint=delegationFingerprint("cash-revoke",{...c,...v});
  const hint=await db.companyMembership.findUnique({where:{id:v.membershipId},select:{userId:true}});if(!hint)fail("CASH_CAPABILITY_TARGET_REJECTED");
  return db.$transaction(async tx=>{
    for(const id of [...new Set([c.id,hint.userId])].sort())await lockCredentialUser(tx,id);
    await serialize(tx,c.companyId);const m=await revocationTarget(tx,c,v.membershipId),g=await grant(tx,m.id);
    if(!g||g.legalEntityId!==v.legalEntityId)fail("CASH_CAPABILITY_GRANT_UNAVAILABLE");
    const kinds=(await tx.$queryRaw<any[]>`SELECT kind FROM "CashCapabilityDelegationAuthority" WHERE "membershipId"=${c.companyMembershipId}::uuid AND enabled=true`).map(a=>a.kind);
    let accepted=false;
    for(const kind of kinds){
      // Choose only a ceiling covering the entire removed grant. Invalid partial
      // ceilings cannot be combined to manufacture a broader accepted authority.
      const a=(await tx.$queryRaw<any[]>`SELECT * FROM "CashCapabilityDelegationAuthority" WHERE "membershipId"=${c.companyMembershipId}::uuid AND kind=${kind}`)[0];
      if(a.legalEntityId===v.legalEntityId&&g.profileRevisions.every((p:string)=>a.profileRevisions.includes(p))&&g.warehouseIds.every((id:string)=>a.warehouseIds.includes(id))&&g.kinds.every((k:string)=>a.kinds.includes(k))){await authority(tx,c,kind,v.legalEntityId,g.profileRevisions,g.warehouseIds,g.kinds);accepted=true;break;}
    }
    if(!accepted)fail("CASH_CAPABILITY_REMOVAL_CEILING");
    const old=await receipt(tx,v.operationId,fingerprint,c);if(old)return old;
    expected(g,v.expectedAcceptanceId);if(!g.enabled)fail("CASH_CAPABILITY_GRANT_REVOKED",409);
    // Base roles/scopes remain untouched.
    await tx.$executeRaw`UPDATE "CashCapabilityMembershipGrant" SET enabled=false WHERE "membershipId"=${m.id}::uuid`;
    const result={companyMembershipId:m.id,revokedAcceptanceId:g.acceptedOperationId};
    await revokeContextSessions(tx,m);await audit(tx,v,c,"revoke",fingerprint,m.id,result,c);return result;
  },options).finally(()=>clearIdentityAccessCacheForUser(hint.userId));
}

export async function lockCashDriver(tx:Tx,id:string) {
  await tx.$queryRaw`SELECT "membershipId" FROM "CompanyDriverEligibility" WHERE "membershipId"=${id}::uuid FOR SHARE`;
}
export async function validateCashBase(tx:Tx,m:Awaited<ReturnType<typeof member>>,profile:string,warehouseIds:string[]) {
  if(profile==="local-driver-cash.v1") {
    await requireAcceptedDriver(tx,{tenantId:m.tenantId!,companyId:m.companyId},m.id,"local");return;
  }
  if(await tx.companyDriverEligibility.findUnique({where:{membershipId:m.id}}))fail("CASH_CAPABILITY_BASE_REQUIRED");
  if(profile==="warehouse-cash.v1") {
    const g=await tx.companyOperationalGrant.findUnique({where:{membershipId:m.id}});
    const role=m.roles.find(r=>r.roleId===g?.roleId)?.role;
    if(!g?.enabled||g.profileRevision!=="operational-warehouse.v1"||g.userId!==m.userId||g.tenantId!==m.tenantId||g.companyId!==m.companyId||g.tenantMembershipId!==m.tenantMembershipId||!role||role.isSystem||role.isOwnerRole||role.companyId!==m.companyId||role.code!==g.profileRevision||
      JSON.stringify(role.rolePermissions.map(p=>p.permission.key).sort())!==JSON.stringify([...OPERATIONAL_PROFILES["operational-warehouse.v1"]].sort())||
      warehouseIds.some(id=>!g.warehouseIds.includes(id)||!m.scopes.some(s=>s.scopeType==="warehouse"&&s.scopeRefId===id)))fail("CASH_CAPABILITY_WAREHOUSE_BASE_REQUIRED");
  }
}

/** Read-only bounded snapshots. Only driver eligibility SHARE pins are reused;
 * no membership/authority/grant write locks, claims, receipts or business writes. */
export async function readCashCapabilityAdministration(db:PrismaClient,actor:AppUser,input:unknown){
  const c=context(actor),v=z.object({view:z.enum(["ceiling","recipients","proposals","grants"]),kind:z.enum(["proposer","checker"]),
    limit:z.coerce.number().int().min(1).max(50).default(20),cursor:z.string().max(768).optional()}).strict().parse(input);
  return db.$transaction(async tx=>{
    const m=await member(tx,c.companyMembershipId);agrees(m,c);
    const a=(await tx.$queryRaw<any[]>`SELECT d.*,j.result,j.action FROM "CashCapabilityDelegationAuthority" d
      JOIN "CashCapabilityGrantAction" j ON j."operationId"=d."acceptedOperationId" AND j."targetMembershipId"=d."membershipId"
      AND j."tenantId"=d."tenantId" AND j."companyId"=d."companyId" AND j."legalEntityId"=d."legalEntityId"
      WHERE d."membershipId"=${c.companyMembershipId}::uuid AND d.kind=${v.kind}`)[0];
    validateAuthority(a,m,c,v.kind,a?.legalEntityId,[]);
    const approved=z.array(cashCapabilityProfileSchema).min(1).max(3).parse(a.profileRevisions);
    const kinds=cashKindsSchema.parse(a.kinds),ids=resources.warehouseIds.parse(a.warehouseIds);
    const legalEntity=await tx.financeLegalEntity.findFirst({where:{id:a.legalEntityId,tenantId:c.tenantId,companyId:c.companyId,isActive:true},select:{id:true,baseCurrency:true,company:{select:{name:true}}}});
    if(!legalEntity)fail("CASH_CAPABILITY_ENTITY_UNAVAILABLE");
    const warehouses=await tx.warehouse.findMany({where:{id:{in:ids},tenantId:c.tenantId},select:{id:true,name:true},orderBy:{id:"asc"}});
    if(warehouses.length!==ids.length)fail("CASH_CAPABILITY_FOREIGN_WAREHOUSE");
    if(v.view==="ceiling"){
      if(v.cursor)fail("CASH_CAPABILITY_CURSOR_REJECTED",400);
      return {revision:CASH_CAPABILITY_DELEGATION_REVISION,kind:v.kind,legalEntity:{id:legalEntity.id,name:legalEntity.company.name,baseCurrency:legalEntity.baseCurrency},
        profiles:approved.map(revision=>({revision,permissions:[...CASH_CAPABILITY_PROFILES[revision]]})),kinds,warehouses};
    }
    const binding={tenantId:c.tenantId,companyId:c.companyId,membershipId:c.companyMembershipId,legalEntityId:legalEntity.id,kind:v.kind,view:v.view};
    let after:string|null=null;
    if(v.cursor){try{
      const cursor=z.object({tenantId:operationIdSchema,companyId:operationIdSchema,membershipId:operationIdSchema,legalEntityId:operationIdSchema,kind:z.enum(["proposer","checker"]),view:z.enum(["recipients","proposals","grants"]),after:operationIdSchema}).strict().parse(JSON.parse(Buffer.from(v.cursor,"base64url").toString("utf8")));
      for(const [k,value] of Object.entries(binding))if(cursor[k as keyof typeof cursor]!==value)throw Error("Foreign cursor");after=cursor.after;
    }catch{fail("CASH_CAPABILITY_CURSOR_REJECTED",400);}}
    const next=(id:string)=>Buffer.from(JSON.stringify({...binding,after:id})).toString("base64url");
    async function current(id:string){const g=(await tx.$queryRaw<any[]>`SELECT g.*,a.action,a.result FROM "CashCapabilityMembershipGrant" g
      JOIN "CashCapabilityGrantAction" a ON a."operationId"=g."acceptedOperationId" AND a."targetMembershipId"=g."membershipId"
      AND a."tenantId"=g."tenantId" AND a."companyId"=g."companyId" AND a."legalEntityId"=g."legalEntityId"
      WHERE g."membershipId"=${id}::uuid AND g."tenantId"=${c.tenantId}::uuid AND g."companyId"=${c.companyId}::uuid`)[0];validateGrant(g);withinRemoved(a,g);return g;}
    const items:any[]=[];
    if(v.view==="recipients"||v.view==="grants"){
      if(v.view==="recipients"&&v.kind!=="proposer")fail("CASH_CAPABILITY_CEILING_REQUIRED");
      const rows=await tx.companyMembership.findMany({where:{tenantId:c.tenantId,companyId:c.companyId,userId:{not:c.id},...(after?{id:{gt:after}}:{})},select:{id:true,userId:true,tenantMembershipId:true,tenantMembership:{select:{id:true,userId:true,tenantId:true}},user:{select:{name:true}}},orderBy:{id:"asc"},take:v.limit+1});
      for(const row of rows.slice(0,v.limit)){
        try{
          const g=await current(row.id);
          if(g&&(g.legalEntityId!==legalEntity.id||g.userId!==row.userId||g.tenantMembershipId!==row.tenantMembershipId||row.tenantMembership?.userId!==row.userId||row.tenantMembership?.tenantId!==c.tenantId))continue;
          if(v.view==="grants"){
            if(!g||g.profileRevisions.some((p:string)=>!approved.includes(p as any))||g.warehouseIds.some((id:string)=>!ids.includes(id))||g.kinds.some((k:string)=>!kinds.includes(k as any)))continue;
            items.push({membershipId:row.id,name:row.user.name,legalEntityId:g.legalEntityId,profileRevisions:g.profileRevisions,warehouseIds:g.warehouseIds,kinds:g.kinds,acceptanceId:g.acceptedOperationId,enabled:g.enabled,managed:true});continue;
          }
          const target=await member(tx,row.id);validateTarget(target,c);const eligible=[];
          for(const revision of approved){
            const base=revision==="warehouse-cash.v1"?await tx.companyOperationalGrant.findUnique({where:{membershipId:target.id}}):null;
            const allowed=revision==="warehouse-cash.v1"?ids.filter(id=>base?.warehouseIds.includes(id)&&target.scopes.some(s=>s.scopeType==="warehouse"&&s.scopeRefId===id)):ids;
            if(!allowed.length)continue;
            try{await validateCashBase(tx,target,revision,allowed);eligible.push({revision,warehouseIds:allowed});}catch(e){if((e as any).statusCode!==403)throw e;}
          }
          if(eligible.length)items.push({membershipId:row.id,name:row.user.name,profiles:eligible,expectedAcceptanceId:g?.acceptedOperationId??null,currentEnabled:g?.enabled??false});
        }catch(e){if((e as any).statusCode!==403)throw e;}
      }
      return {items,nextCursor:rows.length>v.limit?next(rows[v.limit-1].id):null};
    }
    const rows=await tx.$queryRaw<any[]>`SELECT p.*,u.name AS "recipientName",maker.name AS "proposerName",
      (SELECT x."operationId" FROM "CashCapabilityGrantAction" x WHERE x."proposalId"=p."operationId" AND x.action='accept') AS "acceptanceId"
      FROM "CashCapabilityGrantProposal" p JOIN "CompanyMembership" m ON m.id=p."targetMembershipId" AND m."userId"=p."recipientUserId" AND m."tenantId"=p."tenantId" AND m."companyId"=p."companyId"
      JOIN "User" u ON u.id=m."userId" JOIN "User" maker ON maker.id=p."proposerUserId"
      WHERE p."tenantId"=${c.tenantId}::uuid AND p."companyId"=${c.companyId}::uuid AND p."legalEntityId"=${legalEntity.id}::uuid
        AND p."profileRevisions" <@ ${approved}::text[] AND p."warehouseIds" <@ ${ids}::uuid[] AND p.kinds <@ ${kinds}::text[]
        AND (${v.kind}='checker' OR p."proposerMembershipId"=${c.companyMembershipId}::uuid)
        AND (${after}::uuid IS NULL OR p."operationId">${after}::uuid)
      ORDER BY p."operationId" ASC LIMIT ${v.limit+1}`;
    for(const p of rows.slice(0,v.limit)){try{const g=await current(p.targetMembershipId);
      items.push({proposalId:p.operationId,membershipId:p.targetMembershipId,recipientName:p.recipientName,proposerName:p.proposerName,legalEntityId:p.legalEntityId,profileRevisions:p.profileRevisions,warehouseIds:p.warehouseIds,kinds:p.kinds,expectedAcceptanceId:p.expectedAcceptanceId,expectedEnabled:p.expectedEnabled,fingerprint:p.fingerprint,reason:p.reason,createdAt:p.createdAt,
        acceptanceId:p.acceptanceId,state:p.acceptanceId?"accepted":"pending",independent:c.id!==p.proposerUserId&&c.id!==p.recipientUserId,stale:(g?.acceptedOperationId??null)!==p.expectedAcceptanceId||(g?.enabled??false)!==p.expectedEnabled});
    }catch(e){if((e as any).statusCode!==403)throw e;}}
    return {items,nextCursor:rows.length>v.limit?next(rows[v.limit-1].operationId):null};
  },options);
}
