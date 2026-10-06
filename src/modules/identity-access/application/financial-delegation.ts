import type { Prisma, PrismaClient } from "@prisma/client";
import { z } from "zod";
import type { AppUser } from "../../../types/app-user";
import { lockCredentialUser } from "./credential-lock";
import { clearIdentityAccessCacheForUser } from "../access-control";
import { companyMembershipPrimitives } from "./company-delegation";
import { authenticateControlledOperatorPermit } from "./tenant-onboarding";
import { delegationFingerprint, operationIdSchema, reasonSchema } from "./operational-profiles";
import { FINANCIAL_DELEGATION_REVISION, FINANCIAL_PROFILES, financialProfilesSchema } from "./financial-profiles";
const { context, member, agrees, keys, staticRole, revokeContextSessions } = companyMembershipPrimitives;
type Tx = Prisma.TransactionClient;
type Context = ReturnType<typeof context>;
const options = { maxWait: 3000, timeout: 15000 };
function fail(code: string, statusCode = 403): never { throw Object.assign(new Error(code), { code, statusCode }); }
const authorityKey = (kind: string) => kind === "proposer" ? "membership.proposeFinancial" : "membership.approveFinancial";
async function serialize(tx: Tx, companyId: string) {
  await tx.$executeRaw`SET LOCAL lock_timeout='3000ms'`;
  await tx.$executeRaw`SET LOCAL statement_timeout='5000ms'`;
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${"financial-grants:" + companyId},0))::text`;
}
async function entity(tx: Tx, c: {tenantId: string; companyId: string}, id: string) {
  await tx.$queryRaw`SELECT id FROM "FinanceLegalEntity" WHERE id=${id}::uuid AND "tenantId"=${c.tenantId}::uuid AND "companyId"=${c.companyId}::uuid FOR SHARE`;
  if (!await tx.financeLegalEntity.findFirst({where:{id,tenantId:c.tenantId,companyId:c.companyId,isActive:true}})) fail("FINANCIAL_ENTITY_UNAVAILABLE");
}
async function authority(tx: Tx, c: Context, kind: "proposer"|"checker", entityId: string, profiles: string[]) {
  const m = await member(tx,c.companyMembershipId,true); agrees(m,c);
  const a = (await tx.$queryRaw<any[]>`SELECT d.*,j.result,j.action FROM "FinancialDelegationAuthority" d
    JOIN "FinancialGrantAction" j ON j."operationId"=d."acceptedOperationId" AND j."targetMembershipId"=d."membershipId"
      AND j."tenantId"=d."tenantId" AND j."companyId"=d."companyId" AND j."legalEntityId"=d."legalEntityId"
    WHERE d."membershipId"=${m.id}::uuid AND d.kind=${kind} FOR UPDATE OF d`)[0];
  if (!a?.enabled || a.legalEntityId !== entityId || a.tenantId !== c.tenantId || a.companyId !== c.companyId || a.userId !== c.id ||
    a.tenantMembershipId !== c.tenantMembershipId || !keys(m).includes(authorityKey(kind)) ||
    a.action!=="operator-authorize"||a.result?.companyMembershipId!==m.id||a.result?.kind!==kind||a.result?.legalEntityId!==entityId||
    JSON.stringify(a.result?.profileRevisions)!==JSON.stringify(a.profileRevisions)||
    !m.scopes.some(s=>s.scopeType==="company" && s.scopeRefId===c.companyId) || profiles.some(p=>!a.profileRevisions.includes(p))) fail("FINANCIAL_CEILING_REQUIRED");
  await entity(tx,c,entityId);
  return a;
}
async function receipt(tx: Tx, operationId: string, fingerprint: string, c: {tenantId:string; companyId:string}) {
  const a = (await tx.$queryRaw<any[]>`SELECT * FROM "FinancialGrantAction" WHERE "operationId"=${operationId}::uuid`)[0];
  if (a && (a.fingerprint!==fingerprint || a.tenantId!==c.tenantId || a.companyId!==c.companyId)) fail("FINANCIAL_INTENT_CONFLICT",409);
  return a?.result;
}
async function audit(tx: Tx, v: {operationId:string; legalEntityId:string; reason:string}, c: {tenantId:string;companyId:string},
  action:string, fingerprint:string, targetMembershipId:string, result:object, actor?:Context, operatorKeyFingerprint?:string, proposalId?:string) {
  await tx.$executeRaw`INSERT INTO "FinancialGrantAction" ("operationId","tenantId","companyId","legalEntityId",action,fingerprint,"targetMembershipId","actorMembershipId","actorUserId","operatorKeyFingerprint",reason,result,"proposalId","operatorId")
    VALUES (${v.operationId}::uuid,${c.tenantId}::uuid,${c.companyId}::uuid,${v.legalEntityId}::uuid,${action},${fingerprint},${targetMembershipId}::uuid,
      ${actor?.companyMembershipId??null}::uuid,${actor?.id??null}::uuid,${operatorKeyFingerprint??null},${v.reason},${JSON.stringify(result)}::jsonb,${proposalId??null}::uuid,${operatorKeyFingerprint?"cargopilot-bootstrap-owner":null})`;
}
const ownerSchema=z.object({operationId:operationIdSchema,membershipId:operationIdSchema,legalEntityId:operationIdSchema,
  action:z.enum(["operator-authorize","operator-revoke"]),kind:z.enum(["proposer","checker"]),profileRevisions:financialProfilesSchema,
  profileRevision:z.literal(FINANCIAL_DELEGATION_REVISION),reason:reasonSchema}).strict();
/** Deterministic preparation only; neither authorizes nor signs a permit. */
export function normalizeFinancialAuthorityIntent(input:unknown) {
  const intent=ownerSchema.parse(input);
  return {intent,fingerprint:delegationFingerprint("financial-owner",intent)};
}
/** Controlled owner invocation only; no HTTP owner endpoint or signing helper. */
export async function authorizeFinancialDelegator(db:PrismaClient,args:{intent:unknown;permit:unknown;signature:string}) {
  const {intent:v,fingerprint}=normalizeFinancialAuthorityIntent(args.intent);
  const authenticate=()=>authenticateControlledOperatorPermit(args.permit,args.signature,v.operationId,fingerprint,FINANCIAL_DELEGATION_REVISION);
  authenticate();
  const hint=await db.companyMembership.findUnique({where:{id:v.membershipId},select:{userId:true,companyId:true}});
  if(!hint)fail("FINANCIAL_MEMBER_UNAVAILABLE");
  return db.$transaction(async tx=>{
    await lockCredentialUser(tx,hint.userId);await serialize(tx,hint.companyId);
    const m=await member(tx,v.membershipId,true),c={tenantId:m.tenantId!,companyId:m.companyId};
    const verified=authenticate();await entity(tx,c,v.legalEntityId);
    const prior=await receipt(tx,v.operationId,fingerprint,c);if(prior)return prior;
    if(m.roles.some(r=>r.role.isSystem||r.role.isOwnerRole||r.role.companyId!==m.companyId) ||
      !m.scopes.some(s=>s.scopeType==="company"&&s.scopeRefId===m.companyId))fail("FINANCIAL_COMPANY_ADMIN_REQUIRED");
    const code="financial-"+v.kind+".v1";
    const role=await staticRole(tx,m.companyId,code,[authorityKey(v.kind)]);
    if(v.action==="operator-authorize") {
      await tx.membershipRole.upsert({where:{membershipId_roleId:{membershipId:m.id,roleId:role.id}},create:{membershipId:m.id,roleId:role.id},update:{}});
      await tx.$executeRaw`INSERT INTO "FinancialDelegationAuthority" ("membershipId",kind,"userId","tenantId","companyId","tenantMembershipId","legalEntityId","profileRevisions","acceptedOperationId")
        VALUES (${m.id}::uuid,${v.kind},${m.userId}::uuid,${c.tenantId}::uuid,${c.companyId}::uuid,${m.tenantMembershipId}::uuid,${v.legalEntityId}::uuid,${v.profileRevisions}::text[],${v.operationId}::uuid)
        ON CONFLICT ("membershipId",kind) DO UPDATE SET "legalEntityId"=EXCLUDED."legalEntityId","profileRevisions"=EXCLUDED."profileRevisions","acceptedOperationId"=EXCLUDED."acceptedOperationId",enabled=true`;
    } else {
      await tx.$executeRaw`UPDATE "FinancialDelegationAuthority" SET enabled=false WHERE "membershipId"=${m.id}::uuid AND kind=${v.kind}`;
      await tx.membershipRole.deleteMany({where:{membershipId:m.id,roleId:role.id}});
    }
    const result={companyMembershipId:m.id,kind:v.kind,action:v.action,legalEntityId:v.legalEntityId,profileRevisions:v.profileRevisions};
    await revokeContextSessions(tx,m);await audit(tx,v,c,v.action,fingerprint,m.id,result,undefined,verified.keyFingerprint);return result;
  },options).finally(()=>clearIdentityAccessCacheForUser(hint.userId));
}
const proposalSchema=z.object({operationId:operationIdSchema,membershipId:operationIdSchema,legalEntityId:operationIdSchema,
  profileRevisions:financialProfilesSchema,expectedAcceptanceId:operationIdSchema.nullable(),reason:reasonSchema}).strict();
async function grant(tx:Tx,id:string) {
  const g=(await tx.$queryRaw<any[]>`SELECT g.*,a.action,a.result FROM "FinancialMembershipGrant" g
    JOIN "FinancialGrantAction" a ON a."operationId"=g."acceptedOperationId" AND a."targetMembershipId"=g."membershipId"
      AND a."tenantId"=g."tenantId" AND a."companyId"=g."companyId" AND a."legalEntityId"=g."legalEntityId"
    WHERE g."membershipId"=${id}::uuid FOR UPDATE OF g`)[0];
  if(g&&(g.action!=="accept"||g.result?.acceptanceId!==g.acceptedOperationId||
    g.result?.legalEntityId!==g.legalEntityId||JSON.stringify(g.result?.roleIds)!==JSON.stringify(g.roleIds)||
    JSON.stringify(g.result?.profileRevisions)!==JSON.stringify(g.profileRevisions)))fail("FINANCIAL_GRANT_INCONSISTENT");
  return g;
}
async function eligibleTarget(tx:Tx,c:Context,id:string) {
  const m=await member(tx,id,true);
  if(m.userId===c.id || m.tenantId!==c.tenantId || m.companyId!==c.companyId || m.roles.some(r=>r.role.isSystem||r.role.isOwnerRole||r.role.companyId!==c.companyId))fail("FINANCIAL_TARGET_REJECTED");
  if(!m.scopes.some(s=>s.scopeType==="company"&&s.scopeRefId===c.companyId) ||
    await tx.companyDriverEligibility.findUnique({where:{membershipId:m.id}}))fail("FINANCIAL_TARGET_COMPANY_SCOPE_REQUIRED");
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
    fail("FINANCIAL_TARGET_REJECTED");
  return m;
}
function expected(g:any,id:string|null) { if((g?.acceptedOperationId??null)!==id)fail("FINANCIAL_GRANT_STALE",409); }
function withinRemoved(a:any,g:any) {
  if(g?.enabled && (g.legalEntityId!==a.legalEntityId || g.profileRevisions.some((p:string)=>!a.profileRevisions.includes(p))))fail("FINANCIAL_REMOVAL_CEILING");
}
export async function proposeFinancialGrant(db:PrismaClient,actor:AppUser,input:unknown) {
  const c=context(actor),v=proposalSchema.parse(input),fingerprint=delegationFingerprint("financial-proposal",{...c,...v});
  const hint=await db.companyMembership.findUnique({where:{id:v.membershipId},select:{userId:true}});if(!hint)fail("FINANCIAL_TARGET_REJECTED");
  return db.$transaction(async tx=>{
    for(const id of [...new Set([c.id,hint.userId])].sort())await lockCredentialUser(tx,id);
    await serialize(tx,c.companyId);const a=await authority(tx,c,"proposer",v.legalEntityId,v.profileRevisions);
    const m=await eligibleTarget(tx,c,v.membershipId),g=await grant(tx,m.id);withinRemoved(a,g);
    const old=(await tx.$queryRaw<any[]>`SELECT * FROM "FinancialGrantProposal" WHERE "operationId"=${v.operationId}::uuid`)[0];
    if(old){if(old.fingerprint!==fingerprint)fail("FINANCIAL_INTENT_CONFLICT",409);return {proposalId:old.operationId,fingerprint:old.fingerprint};}
    expected(g,v.expectedAcceptanceId);
    await tx.$executeRaw`INSERT INTO "FinancialGrantProposal" ("operationId","tenantId","companyId","legalEntityId","proposerMembershipId","proposerUserId","targetMembershipId","recipientUserId","profileRevisions","expectedAcceptanceId","expectedEnabled","proposerAcceptanceId",fingerprint,reason)
      VALUES (${v.operationId}::uuid,${c.tenantId}::uuid,${c.companyId}::uuid,${v.legalEntityId}::uuid,${c.companyMembershipId}::uuid,${c.id}::uuid,${m.id}::uuid,${m.userId}::uuid,${v.profileRevisions}::text[],${v.expectedAcceptanceId}::uuid,${g?.enabled??false},${a.acceptedOperationId}::uuid,${fingerprint},${v.reason})`;
    await audit(tx,v,c,"propose",fingerprint,m.id,{proposalId:v.operationId},c);
    return {proposalId:v.operationId,fingerprint};
  },options);
}
const decisionSchema=z.object({operationId:operationIdSchema,proposalId:operationIdSchema,fingerprint:z.string().regex(/^[a-f0-9]{64}$/),reason:reasonSchema}).strict();
export async function acceptFinancialGrant(db:PrismaClient,actor:AppUser,input:unknown) {
  const c=context(actor),v=decisionSchema.parse(input),fingerprint=delegationFingerprint("financial-accept",{...c,...v});
  const hint=(await db.$queryRaw<any[]>`SELECT * FROM "FinancialGrantProposal" WHERE "operationId"=${v.proposalId}::uuid AND "tenantId"=${c.tenantId}::uuid AND "companyId"=${c.companyId}::uuid`)[0];
  if(!hint)fail("FINANCIAL_PROPOSAL_UNAVAILABLE");
  return db.$transaction(async tx=>{
    for(const id of [...new Set([c.id,hint.proposerUserId,hint.recipientUserId])].sort())await lockCredentialUser(tx,id);
    await serialize(tx,c.companyId);
    const p=(await tx.$queryRaw<any[]>`SELECT * FROM "FinancialGrantProposal" WHERE "operationId"=${v.proposalId}::uuid FOR SHARE`)[0];
    if(!p || p.fingerprint!==v.fingerprint || p.tenantId!==c.tenantId || p.companyId!==c.companyId)fail("FINANCIAL_PROPOSAL_CONFLICT",409);
    if(c.id===p.proposerUserId || c.id===p.recipientUserId)fail("FINANCIAL_INDEPENDENT_CHECKER_REQUIRED");
    const checker=await authority(tx,c,"checker",p.legalEntityId,p.profileRevisions);
    const maker=await member(tx,p.proposerMembershipId,true);
    const proposer={id:maker.userId,tenantId:maker.tenantId!,companyId:maker.companyId,tenantMembershipId:maker.tenantMembershipId!,companyMembershipId:maker.id};
    const a=await authority(tx,proposer,"proposer",p.legalEntityId,p.profileRevisions);
    if(a.acceptedOperationId!==p.proposerAcceptanceId)fail("FINANCIAL_PROPOSER_ACCEPTANCE_CHANGED",409);
    const m=await eligibleTarget(tx,c,p.targetMembershipId),g=await grant(tx,m.id);
    const old=await receipt(tx,v.operationId,fingerprint,c);
    if(old){if(!g?.enabled||g.acceptedOperationId!==v.operationId)fail("FINANCIAL_RECEIPT_NOT_CURRENT");return old;}
    if((await tx.$queryRaw<any[]>`SELECT 1 FROM "FinancialGrantAction" WHERE "proposalId"=${p.operationId}::uuid AND action='accept'`).length)fail("FINANCIAL_PROPOSAL_ALREADY_ACCEPTED",409);
    expected(g,p.expectedAcceptanceId);
    if((g?.enabled??false)!==p.expectedEnabled)fail("FINANCIAL_GRANT_STALE",409);
    withinRemoved(a,g);withinRemoved(checker,g);
    // Only workflow-managed financial roles are replaced. Never adopt a legacy role.
    const priorRoles=g?.roleIds??[];
    for(const r of m.roles){
      if(priorRoles.includes(r.roleId))continue;
      if(r.role.rolePermissions.some(rp=>["pricing.write","pricing.tariffs.propose","pricing.tariffs.approve","billing.policies.propose","billing.policies.approve","billing.payers.bind","pricing.orders.accept","pricing.orders.approve","finance.invoices.issue","finance.invoices.read","finance.settings.read"].includes(rp.permission.key)))fail("FINANCIAL_UNMANAGED_GRANT");
    }
    if(priorRoles.length)await tx.membershipRole.deleteMany({where:{membershipId:m.id,roleId:{in:priorRoles}}});
    const roleIds:string[]=[];
    for(const profile of p.profileRevisions as Array<keyof typeof FINANCIAL_PROFILES>){
      const role=await staticRole(tx,c.companyId,profile,FINANCIAL_PROFILES[profile]);roleIds.push(role.id);
      await tx.membershipRole.upsert({where:{membershipId_roleId:{membershipId:m.id,roleId:role.id}},create:{membershipId:m.id,roleId:role.id},update:{}});
    }
    await tx.$executeRaw`INSERT INTO "FinancialMembershipGrant" ("membershipId","userId","tenantId","companyId","tenantMembershipId","legalEntityId","profileRevisions","roleIds","acceptedOperationId")
      VALUES (${m.id}::uuid,${m.userId}::uuid,${c.tenantId}::uuid,${c.companyId}::uuid,${m.tenantMembershipId}::uuid,${p.legalEntityId}::uuid,${p.profileRevisions}::text[],${roleIds}::uuid[],${v.operationId}::uuid)
      ON CONFLICT ("membershipId") DO UPDATE SET "profileRevisions"=EXCLUDED."profileRevisions","roleIds"=EXCLUDED."roleIds","acceptedOperationId"=EXCLUDED."acceptedOperationId",enabled=true`;
    const result={companyMembershipId:m.id,legalEntityId:p.legalEntityId,profileRevisions:p.profileRevisions,roleIds,acceptanceId:v.operationId};
    await audit(tx,{...v,legalEntityId:p.legalEntityId},c,"accept",fingerprint,m.id,result,c,undefined,p.operationId);
    await revokeContextSessions(tx,m);return result;
  },options).finally(()=>clearIdentityAccessCacheForUser(hint.recipientUserId));
}
const revokeSchema=z.object({operationId:operationIdSchema,membershipId:operationIdSchema,legalEntityId:operationIdSchema,expectedAcceptanceId:operationIdSchema,reason:reasonSchema}).strict();
export async function revokeFinancialGrant(db:PrismaClient,actor:AppUser,input:unknown) {
  const c=context(actor),v=revokeSchema.parse(input),fingerprint=delegationFingerprint("financial-revoke",{...c,...v});
  const hint=await db.companyMembership.findUnique({where:{id:v.membershipId},select:{userId:true}});if(!hint)fail("FINANCIAL_TARGET_REJECTED");
  return db.$transaction(async tx=>{
    for(const id of [...new Set([c.id,hint.userId])].sort())await lockCredentialUser(tx,id);
    await serialize(tx,c.companyId);const m=await revocationTarget(tx,c,v.membershipId),g=await grant(tx,m.id);
    if(!g||g.legalEntityId!==v.legalEntityId)fail("FINANCIAL_GRANT_UNAVAILABLE");
    const kinds=(await tx.$queryRaw<any[]>`SELECT kind FROM "FinancialDelegationAuthority" WHERE "membershipId"=${c.companyMembershipId}::uuid AND enabled=true`).map(a=>a.kind);
    let accepted=false;
    for(const kind of kinds){
      // Choose only a ceiling covering the entire removed grant. Invalid partial
      // ceilings cannot be combined to manufacture a broader accepted authority.
      const a=(await tx.$queryRaw<any[]>`SELECT * FROM "FinancialDelegationAuthority" WHERE "membershipId"=${c.companyMembershipId}::uuid AND kind=${kind}`)[0];
      if(a.legalEntityId===v.legalEntityId&&g.profileRevisions.every((p:string)=>a.profileRevisions.includes(p))){await authority(tx,c,kind,v.legalEntityId,g.profileRevisions);accepted=true;break;}
    }
    if(!accepted)fail("FINANCIAL_REMOVAL_CEILING");
    const old=await receipt(tx,v.operationId,fingerprint,c);if(old)return old;
    expected(g,v.expectedAcceptanceId);if(!g.enabled)fail("FINANCIAL_GRANT_REVOKED",409);
    await tx.membershipRole.deleteMany({where:{membershipId:m.id,roleId:{in:g.roleIds}}});
    await tx.$executeRaw`UPDATE "FinancialMembershipGrant" SET enabled=false WHERE "membershipId"=${m.id}::uuid`;
    const result={companyMembershipId:m.id,revokedAcceptanceId:g.acceptedOperationId};
    await revokeContextSessions(tx,m);await audit(tx,v,c,"revoke",fingerprint,m.id,result,c);return result;
  },options).finally(()=>clearIdentityAccessCacheForUser(hint.userId));
}
