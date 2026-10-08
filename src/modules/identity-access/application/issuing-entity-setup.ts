import { Prisma, type PrismaClient } from "@prisma/client";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { AppUser } from "../../../types/app-user";
import { SUPPORTED_FINANCE_CURRENCIES } from "../../finance-core/domain/supported-currencies";
import { stableDraftJson } from "../../finance-core/domain/draft-intent";
import { companyMembershipPrimitives } from "./company-delegation";
import { lockCredentialUser } from "./credential-lock";
import { authenticateControlledOperatorPermit } from "./tenant-onboarding";
import { clearIdentityAccessCacheForUser } from "../access-control";
import { operationIdSchema } from "./operational-profiles";

export const ENTITY_SETUP_REVISION = "issuing-entity-setup.v1";
const { context, member, agrees, keys, staticRole, revokeContextSessions } = companyMembershipPrimitives;
type Tx = Prisma.TransactionClient;
type Context = ReturnType<typeof context>;
const options = { maxWait: 2000, timeout: 10000 };
const reason = z.string().trim().min(1).max(1000).regex(/^[^\u0000-\u001f\u007f]+$/);
const kindSchema = z.enum(["proposer", "checker"]);
const key = (kind: string) => kind === "proposer" ? "finance.entitySetup.propose" : "finance.entitySetup.approve";
const fingerprint = (intent: unknown) => createHash("sha256").update(stableDraftJson({version:ENTITY_SETUP_REVISION,intent})).digest("hex");
function fail(code: string, statusCode = 403): never { throw Object.assign(new Error(code), { code, statusCode }); }
export const initialEntityConfigurationSchema = z.object({
  baseCurrency: z.enum(SUPPORTED_FINANCE_CURRENCIES),
  fiscalYearStartMonth: z.number().int().min(1).max(12),
  timezone: z.string().trim().min(1).max(100).refine(v => {
    try { new Intl.DateTimeFormat("en", { timeZone: v }); return !/^[+-]/.test(v); } catch { return false; }
  }, "Unsupported IANA timezone"),
  reportingCurrency: z.null().optional().transform(() => null),
}).strict();
const ownerSchema = z.object({ operationId: operationIdSchema, membershipId: operationIdSchema,
  userId:operationIdSchema,tenantId:operationIdSchema,companyId:operationIdSchema,tenantMembershipId:operationIdSchema,
  kind: kindSchema, action: z.enum(["operator-authorize", "operator-revoke"]),
  expectedAcceptanceId: operationIdSchema.nullable(), profileRevision: z.literal(ENTITY_SETUP_REVISION), reason }).strict();
export function normalizeIssuingEntityAuthorityIntent(raw: unknown) {
  const intent = ownerSchema.parse(raw); return { intent, fingerprint: fingerprint(intent) };
}
export const entityProposalSchema = z.object({ operationId: operationIdSchema, reason,
  configuration: initialEntityConfigurationSchema }).strict();
export const entityDecisionSchema = z.object({ operationId: operationIdSchema, proposalId: operationIdSchema,
  contentHash: z.string().regex(/^[a-f0-9]{64}$/), decision: z.enum(["approved", "rejected"]), reason }).strict();

// One order for owner/session writers and setup business transactions: all Users,
// then memberships, then company setup fence, authority, proposal/publication.
async function referenceLocks(tx: Tx, hints: Array<{ id: string; userId: string }>, owner = false) {
  await tx.$executeRaw`SET LOCAL lock_timeout='2000ms'`;
  await tx.$executeRaw`SET LOCAL statement_timeout='5000ms'`;
  for (const id of [...new Set(hints.map(h => h.userId))].sort()) {
    if (owner) await lockCredentialUser(tx, id);
    else await tx.$queryRaw`SELECT id FROM "User" WHERE id=${id}::uuid FOR KEY SHARE`;
  }
  for (const id of [...new Set(hints.map(h => h.id))].sort())
    await tx.$queryRaw(Prisma.sql`SELECT id FROM "CompanyMembership" WHERE id=${id}::uuid ${Prisma.raw(owner ? "FOR UPDATE" : "FOR KEY SHARE")}`);
}
async function serialize(tx: Tx, companyId: string, operationId?: string) {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${"issuing-entity-setup:" + companyId},0))::text`;
  if(operationId)await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${"issuing-entity-operation:" + operationId},0))::text`;
}
async function selected(tx: Tx, c: Context) {
  const m = await member(tx, c.companyMembershipId); agrees(m, c);
  if (!m.scopes.some(s => s.scopeType === "company" && s.scopeRefId === c.companyId) ||
    m.roles.some(r => r.role.isSystem || r.role.isOwnerRole || r.role.companyId !== c.companyId) ||
    await tx.companyDriverEligibility.findUnique({ where: { membershipId: m.id } })) fail("ENTITY_SETUP_COMPANY_SCOPE_REQUIRED");
  return m;
}
// Removal must remain possible after the target is suspended. This reader proves
// only existing bridge ownership and grants no ability to execute setup actions.
async function revocationMember(tx: Tx, id: string) {
  const m=await tx.companyMembership.findUnique({where:{id},include:{user:{select:{id:true,email:true}},
    company:{select:{id:true,tenantId:true,type:true,isActive:true}},tenant:{select:{id:true,status:true}},
    tenantMembership:{select:{id:true,userId:true,tenantId:true,status:true}},
    roles:{include:{role:{include:{rolePermissions:{include:{permission:{select:{key:true}}}}}}}},scopes:true}});
  if(!m||!m.tenantId||!m.tenantMembershipId||m.company.tenantId!==m.tenantId||m.company.type!=="company"||
    m.tenantMembership?.id!==m.tenantMembershipId||m.tenantMembership.userId!==m.userId||m.tenantMembership.tenantId!==m.tenantId)
    fail("ENTITY_SETUP_MEMBER_UNAVAILABLE");
  return m;
}
async function authority(tx: Tx, c: Context, kind: "proposer" | "checker") {
  const m = await selected(tx, c);
  const a = (await tx.$queryRaw<any[]>`SELECT a.*,j.action,j.result FROM "IssuingEntitySetupAuthority" a
    JOIN "IssuingEntitySetupAction" j ON j."operationId"=a."acceptedOperationId" AND j."membershipId"=a."membershipId"
      AND j.kind=a.kind AND j."tenantId"=a."tenantId" AND j."companyId"=a."companyId"
    WHERE a."membershipId"=${m.id}::uuid AND a.kind=${kind} FOR SHARE OF a`)[0];
  if (!a?.enabled || a.userId !== c.id || a.tenantMembershipId !== c.tenantMembershipId || a.tenantId !== c.tenantId ||
    a.companyId !== c.companyId || a.profileRevision !== ENTITY_SETUP_REVISION || a.action !== "operator-authorize" ||
    a.result?.acceptanceId !== a.acceptedOperationId || a.result?.kind !== kind || !keys(m).includes(key(kind))) fail("ENTITY_SETUP_AUTHORITY_REQUIRED");
  return a;
}
async function previous(tx: Tx, operationId: string, hash: string, c: Context, action: string) {
  if((await tx.$queryRaw<any[]>`SELECT "operationId" FROM "IssuingEntitySetupProposal" WHERE "operationId"=${operationId}::uuid`).length)fail("ENTITY_SETUP_INTENT_CONFLICT",409);
  const row = (await tx.$queryRaw<any[]>`SELECT * FROM "IssuingEntitySetupAction" WHERE "operationId"=${operationId}::uuid`)[0];
  if (row && (row.fingerprint !== hash || row.action !== action || row.tenantId !== c.tenantId || row.companyId !== c.companyId ||
    row.membershipId !== c.companyMembershipId || row.userId !== c.id || row.tenantMembershipId !== c.tenantMembershipId)) fail("ENTITY_SETUP_INTENT_CONFLICT", 409);
  return row;
}
async function action(tx: Tx, v: {operationId: string; reason: string}, c: Context, kind: string, name: string, hash: string,
  result: object, extra: { operatorKeyFingerprint?: string; proposalId?: string; legalEntityId?: string } = {}) {
  await tx.$executeRaw`INSERT INTO "IssuingEntitySetupAction" ("operationId","tenantId","companyId","membershipId","userId","tenantMembershipId",kind,action,fingerprint,reason,result,"operatorId","operatorKeyFingerprint","proposalId","legalEntityId")
    VALUES (${v.operationId}::uuid,${c.tenantId}::uuid,${c.companyId}::uuid,${c.companyMembershipId}::uuid,${c.id}::uuid,${c.tenantMembershipId}::uuid,
      ${kind},${name},${hash},${v.reason},${JSON.stringify(result)}::jsonb,${extra.operatorKeyFingerprint ? "cargopilot-bootstrap-owner" : null},${extra.operatorKeyFingerprint ?? null},${extra.proposalId ?? null}::uuid,${extra.legalEntityId ?? null}::uuid)`;
}
/** Controlled owner invocation, never an HTTP owner endpoint or signing helper. */
export async function authorizeIssuingEntitySetup(db: PrismaClient, args: {intent: unknown; permit: unknown; signature: string}) {
  const { intent: v, fingerprint: hash } = normalizeIssuingEntityAuthorityIntent(args.intent);
  const authenticate = () => authenticateControlledOperatorPermit(args.permit, args.signature, v.operationId, hash, ENTITY_SETUP_REVISION);
  authenticate();
  const hint = await db.companyMembership.findUnique({ where: {id:v.membershipId}, select:{id:true,userId:true,companyId:true} });
  if (!hint || hint.companyId!==v.companyId || hint.userId!==v.userId) fail("ENTITY_SETUP_MEMBER_UNAVAILABLE");
  return db.$transaction(async tx => {
    await referenceLocks(tx,[hint],true); await serialize(tx,hint.companyId,v.operationId);
    const m = v.action==="operator-revoke"?await revocationMember(tx,v.membershipId):await member(tx,v.membershipId), c = { id:m.userId, tenantId:m.tenantId!, companyId:m.companyId, tenantMembershipId:m.tenantMembershipId!, companyMembershipId:m.id };
    if(m.userId!==v.userId||m.companyId!==v.companyId||m.tenantId!==v.tenantId||m.tenantMembershipId!==v.tenantMembershipId)fail("ENTITY_SETUP_OWNER_CONTEXT_CONFLICT");
    if(v.action==="operator-authorize")await selected(tx,c); const verified = authenticate();
    const prior = await previous(tx,v.operationId,hash,c,v.action); if (prior) return prior.result;
    const a = (await tx.$queryRaw<any[]>`SELECT * FROM "IssuingEntitySetupAuthority" WHERE "membershipId"=${m.id}::uuid AND kind=${v.kind} FOR UPDATE`)[0];
    if ((a?.acceptedOperationId ?? null) !== v.expectedAcceptanceId || (v.action === "operator-revoke" && !a)) fail("ENTITY_SETUP_STALE_AUTHORITY",409);
    const role = await staticRole(tx,m.companyId,"issuing-entity-setup-"+v.kind+".v1",[key(v.kind)]);
    const result = { companyMembershipId:m.id,kind:v.kind,action:v.action,acceptanceId:v.operationId };
    await action(tx,v,c,v.kind,v.action,hash,result,{operatorKeyFingerprint:verified.keyFingerprint});
    if (v.action === "operator-authorize") {
      await tx.membershipRole.upsert({ where:{membershipId_roleId:{membershipId:m.id,roleId:role.id}},create:{membershipId:m.id,roleId:role.id},update:{} });
      await tx.$executeRaw`INSERT INTO "IssuingEntitySetupAuthority" ("membershipId",kind,"userId","tenantId","companyId","tenantMembershipId","profileRevision","acceptedOperationId")
        VALUES (${m.id}::uuid,${v.kind},${m.userId}::uuid,${c.tenantId}::uuid,${c.companyId}::uuid,${c.tenantMembershipId}::uuid,${ENTITY_SETUP_REVISION},${v.operationId}::uuid)
        ON CONFLICT ("membershipId",kind) DO UPDATE SET enabled=true,"acceptedOperationId"=EXCLUDED."acceptedOperationId"`;
    } else {
      await tx.membershipRole.deleteMany({where:{membershipId:m.id,roleId:role.id}});
      await tx.$executeRaw`UPDATE "IssuingEntitySetupAuthority" SET enabled=false WHERE "membershipId"=${m.id}::uuid AND kind=${v.kind}`;
    }
    await revokeContextSessions(tx,m); return result;
  },options).finally(()=>clearIdentityAccessCacheForUser(hint.userId));
}
export async function proposeIssuingEntity(db: PrismaClient, actor: AppUser, raw: unknown) {
  const c=context(actor), v=entityProposalSchema.parse(raw), hash=fingerprint({c,reason:v.reason,configuration:v.configuration}), contentHash=fingerprint(v.configuration);
  return db.$transaction(async tx=>{
    await referenceLocks(tx,[{id:c.companyMembershipId,userId:c.id}]);await serialize(tx,c.companyId,v.operationId);
    const a=await authority(tx,c,"proposer");
    if((await tx.$queryRaw<any[]>`SELECT "operationId" FROM "IssuingEntitySetupAction" WHERE "operationId"=${v.operationId}::uuid`).length)fail("ENTITY_SETUP_INTENT_CONFLICT",409);
    const p=(await tx.$queryRaw<any[]>`SELECT * FROM "IssuingEntitySetupProposal" WHERE "operationId"=${v.operationId}::uuid`)[0];
    if(p){if(p.fingerprint!==hash||p.membershipId!==c.companyMembershipId||p.tenantId!==c.tenantId||p.companyId!==c.companyId)fail("ENTITY_SETUP_INTENT_CONFLICT",409);return {proposalId:p.operationId,contentHash:p.contentHash};}
    if(await tx.financeLegalEntity.findUnique({where:{companyId:c.companyId}}))fail("ENTITY_SETUP_ALREADY_CONFIGURED",409);
    await tx.$executeRaw`INSERT INTO "IssuingEntitySetupProposal" ("operationId","tenantId","companyId","membershipId","userId","tenantMembershipId","authorityAcceptanceId",content,"contentHash",fingerprint,reason)
      VALUES (${v.operationId}::uuid,${c.tenantId}::uuid,${c.companyId}::uuid,${c.companyMembershipId}::uuid,${c.id}::uuid,${c.tenantMembershipId}::uuid,${a.acceptedOperationId}::uuid,${JSON.stringify(v.configuration)}::jsonb,${contentHash},${hash},${v.reason})`;
    return {proposalId:v.operationId,contentHash};
  },options);
}
export async function readIssuingEntityProposal(db: PrismaClient, actor: AppUser, id: string) {
  const c=context(actor);id=operationIdSchema.parse(id);
  return db.$transaction(async tx=>{
    await referenceLocks(tx,[{id:c.companyMembershipId,userId:c.id}]);await serialize(tx,c.companyId);
    const m=await selected(tx,c), kind=keys(m).includes(key("checker"))?"checker":"proposer";
    await authority(tx,c,kind);
    const p=(await tx.$queryRaw<any[]>`SELECT "operationId",content,"contentHash",reason,"createdAt","membershipId" FROM "IssuingEntitySetupProposal"
      WHERE "operationId"=${id}::uuid AND "tenantId"=${c.tenantId}::uuid AND "companyId"=${c.companyId}::uuid`)[0];
    if(!p || (kind==="proposer"&&p.membershipId!==c.companyMembershipId))fail("ENTITY_SETUP_PROPOSAL_NOT_FOUND",404);
    const d=(await tx.$queryRaw<any[]>`SELECT action,"legalEntityId","createdAt" FROM "IssuingEntitySetupAction" WHERE "proposalId"=${id}::uuid AND "tenantId"=${c.tenantId}::uuid AND "companyId"=${c.companyId}::uuid`)[0];
    return {proposalId:p.operationId,configuration:p.content,contentHash:p.contentHash,reason:p.reason,createdAt:p.createdAt,decision:d??null};
  },options);
}
/** Bounded setup snapshots; existing accepted setup authority is required even
 * when an entity does not yet exist. Reads cannot appoint authority or publish. */
export async function readIssuingEntitySetup(db: PrismaClient, actor: AppUser, input: unknown) {
  const c=context(actor), v=z.object({view:z.enum(["authority","proposals"]),kind:kindSchema,
    limit:z.coerce.number().int().min(1).max(50).default(20),cursor:z.string().max(768).optional()}).strict().parse(input);
  return db.$transaction(async tx=>{
    await referenceLocks(tx,[{id:c.companyMembershipId,userId:c.id}]);await serialize(tx,c.companyId);
    await authority(tx,c,v.kind);
    const binding={tenantId:c.tenantId,companyId:c.companyId,membershipId:c.companyMembershipId,kind:v.kind};
    if(v.view==="authority"){
      if(v.cursor)fail("ENTITY_SETUP_CURSOR_REJECTED",400);
      const entity=await tx.financeLegalEntity.findUnique({where:{companyId:c.companyId},select:{id:true,tenantId:true,companyId:true,baseCurrency:true,fiscalYearStartMonth:true,timezone:true,reportingCurrency:true,isActive:true}});
      if(entity&&(entity.tenantId!==c.tenantId||entity.companyId!==c.companyId))fail("ENTITY_SETUP_PUBLICATION_UNAVAILABLE");
      const company=await tx.organization.findUniqueOrThrow({where:{id:c.companyId},select:{name:true}});
      return {revision:ENTITY_SETUP_REVISION,kind:v.kind,companyName:company.name,supportedCurrencies:[...SUPPORTED_FINANCE_CURRENCIES],reportingCurrency:null,
        entity:entity?{id:entity.id,baseCurrency:entity.baseCurrency,fiscalYearStartMonth:entity.fiscalYearStartMonth,timezone:entity.timezone,reportingCurrency:entity.reportingCurrency,isActive:entity.isActive}:null};
    }
    let after:string|null=null;
    if(v.cursor){try{
      const cursor=z.object({tenantId:operationIdSchema,companyId:operationIdSchema,membershipId:operationIdSchema,kind:kindSchema,after:operationIdSchema}).strict().parse(JSON.parse(Buffer.from(v.cursor,"base64url").toString("utf8")));
      for(const [k,value] of Object.entries(binding))if(cursor[k as keyof typeof cursor]!==value)throw Error("Foreign cursor");after=cursor.after;
    }catch{fail("ENTITY_SETUP_CURSOR_REJECTED",400);}}
    const rows=await tx.$queryRaw<any[]>`SELECT p."operationId",p.content,p."contentHash",p.reason,p."createdAt",p."userId",u.name AS "proposerName",
      d.action AS "decisionAction",d.reason AS "decisionReason",d."createdAt" AS "decidedAt",d."legalEntityId"
      FROM "IssuingEntitySetupProposal" p JOIN "User" u ON u.id=p."userId"
      LEFT JOIN "IssuingEntitySetupAction" d ON d."proposalId"=p."operationId" AND d."tenantId"=p."tenantId" AND d."companyId"=p."companyId" AND d.action IN ('approved','rejected')
      WHERE p."tenantId"=${c.tenantId}::uuid AND p."companyId"=${c.companyId}::uuid
        AND (${v.kind}='checker' OR p."membershipId"=${c.companyMembershipId}::uuid)
        AND (${after}::uuid IS NULL OR p."operationId">${after}::uuid)
      ORDER BY p."operationId" ASC LIMIT ${v.limit+1}`;
    const items=rows.slice(0,v.limit).map(p=>({proposalId:p.operationId,configuration:initialEntityConfigurationSchema.parse(p.content),contentHash:p.contentHash,reason:p.reason,createdAt:p.createdAt,
      proposer:{userId:p.userId,name:p.proposerName},independent:p.userId!==c.id,
      decision:p.decisionAction?{action:p.decisionAction,reason:p.decisionReason,createdAt:p.decidedAt,legalEntityId:p.legalEntityId}:null}));
    return {items,nextCursor:rows.length>v.limit?Buffer.from(JSON.stringify({...binding,after:rows[v.limit-1].operationId})).toString("base64url"):null};
  },options);
}
export async function decideIssuingEntity(db: PrismaClient, actor: AppUser, raw: unknown) {
  const c=context(actor),v=entityDecisionSchema.parse(raw),{operationId,...intent}=v,hash=fingerprint({c,...intent});
  const hint=(await db.$queryRaw<any[]>`SELECT "membershipId","userId" FROM "IssuingEntitySetupProposal" WHERE "operationId"=${v.proposalId}::uuid AND "tenantId"=${c.tenantId}::uuid AND "companyId"=${c.companyId}::uuid`)[0];
  if(!hint)fail("ENTITY_SETUP_PROPOSAL_NOT_FOUND",404);
  return db.$transaction(async tx=>{
    await referenceLocks(tx,[{id:c.companyMembershipId,userId:c.id},{id:hint.membershipId,userId:hint.userId}]);await serialize(tx,c.companyId,v.operationId);
    await authority(tx,c,"checker");
    const p=(await tx.$queryRaw<any[]>`SELECT * FROM "IssuingEntitySetupProposal" WHERE "operationId"=${v.proposalId}::uuid AND "tenantId"=${c.tenantId}::uuid AND "companyId"=${c.companyId}::uuid FOR UPDATE`)[0];
    if(!p||p.userId===c.id)fail("ENTITY_SETUP_INDEPENDENT_CHECKER_REQUIRED");
    const maker={id:p.userId,tenantId:p.tenantId,companyId:p.companyId,tenantMembershipId:p.tenantMembershipId,companyMembershipId:p.membershipId};
    const a=await authority(tx,maker,"proposer");
    if(a.acceptedOperationId!==p.authorityAcceptanceId)fail("ENTITY_SETUP_STALE_PROPOSAL",409);
    const configuration=initialEntityConfigurationSchema.parse(p.content);
    if(p.contentHash!==v.contentHash||fingerprint(configuration)!==p.contentHash)fail("ENTITY_SETUP_CONTENT_CONFLICT",409);
    const prior=await previous(tx,v.operationId,hash,c,v.decision);if(prior){
      if(prior.legalEntityId&&!await tx.financeLegalEntity.findFirst({where:{id:prior.legalEntityId,tenantId:c.tenantId,companyId:c.companyId,isActive:true}}))fail("ENTITY_SETUP_PUBLICATION_UNAVAILABLE");
      return prior.result;
    }
    if((await tx.$queryRaw<any[]>`SELECT "operationId" FROM "IssuingEntitySetupAction" WHERE "proposalId"=${p.operationId}::uuid`).length)fail("ENTITY_SETUP_ALREADY_DECIDED",409);
    let entityId:string|null=null;
    if(v.decision==="approved"){
      if(await tx.financeLegalEntity.findUnique({where:{companyId:c.companyId}}))fail("ENTITY_SETUP_ALREADY_CONFIGURED",409);
      entityId=randomUUID();
      await tx.financeLegalEntity.create({data:{id:entityId,tenantId:c.tenantId,companyId:c.companyId,...configuration,isActive:true,createdByUserId:p.userId,updatedByUserId:c.id}});
    }
    const result={proposalId:p.operationId,decision:v.decision,legalEntityId:entityId,configuration,contentHash:p.contentHash};
    await action(tx,v,c,"checker",v.decision,hash,result,{proposalId:p.operationId,legalEntityId:entityId??undefined});
    if(entityId)await tx.financeAuditEvent.create({data:{legalEntityId:entityId,actorUserId:c.id,action:"finance.entity.initial-approved",detailsJson:{proposalId:p.operationId,contentHash:p.contentHash,makerUserId:p.userId,reason:v.reason}}});
    return result;
  },options);
}
