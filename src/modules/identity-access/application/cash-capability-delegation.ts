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
  if (!a?.enabled || a.legalEntityId !== entityId || a.tenantId !== c.tenantId || a.companyId !== c.companyId || a.userId !== c.id ||
    a.tenantMembershipId !== c.tenantMembershipId || !keys(m).includes(authorityKey(kind)) ||
    a.action!=="operator-authorize"||a.result?.companyMembershipId!==m.id||a.result?.kind!==kind||a.result?.legalEntityId!==entityId||
    JSON.stringify(a.result?.profileRevisions)!==JSON.stringify(a.profileRevisions)||
    JSON.stringify(a.result?.warehouseIds)!==JSON.stringify(a.warehouseIds)||JSON.stringify(a.result?.kinds)!==JSON.stringify(a.kinds)||
    !m.scopes.some(s=>s.scopeType==="company" && s.scopeRefId===c.companyId) || profiles.some(p=>!a.profileRevisions.includes(p))) fail("CASH_CAPABILITY_CEILING_REQUIRED");
  await entity(tx,c,entityId);
  if(warehouseIds.some(id=>!a.warehouseIds.includes(id))||kinds.some(k=>!a.kinds.includes(k)))fail("CASH_CAPABILITY_RESOURCE_CEILING");
  const owned=await tx.warehouse.findMany({where:{id:{in:warehouseIds},tenantId:c.tenantId},select:{id:true}});
  if(owned.length!==warehouseIds.length)fail("CASH_CAPABILITY_FOREIGN_WAREHOUSE");
  return a;
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
  if(g&&(g.action!=="accept"||g.result?.acceptanceId!==g.acceptedOperationId||
    g.result?.legalEntityId!==g.legalEntityId||JSON.stringify(g.result?.warehouseIds)!==JSON.stringify(g.warehouseIds)||JSON.stringify(g.result?.kinds)!==JSON.stringify(g.kinds)||
    JSON.stringify(g.result?.profileRevisions)!==JSON.stringify(g.profileRevisions)))fail("CASH_CAPABILITY_GRANT_INCONSISTENT");
  return g;
}
async function eligibleTarget(tx:Tx,c:Context,id:string) {
  const m=await member(tx,id,true);
  if(m.userId===c.id || m.tenantId!==c.tenantId || m.companyId!==c.companyId || m.roles.some(r=>r.role.isSystem||r.role.isOwnerRole||r.role.companyId!==c.companyId))fail("CASH_CAPABILITY_TARGET_REJECTED");
  return m;
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
