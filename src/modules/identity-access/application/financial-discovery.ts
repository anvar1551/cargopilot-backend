import type { PrismaClient, Prisma } from "@prisma/client";
import { z } from "zod";
import type { AppUser } from "../../../types/app-user";
import { companyMembershipPrimitives } from "./company-delegation";
import { FINANCIAL_PROFILES, FINANCIAL_ACCEPTANCE_KEYS, financialProfilesSchema } from "./financial-profiles";
const {context,member,agrees,keys}=companyMembershipPrimitives;
const uuid=z.string().uuid();
const query=z.object({view:z.enum(["ceiling","recipients","proposals","grants"]),kind:z.enum(["proposer","checker"]).optional(),limit:z.coerce.number().int().min(1).max(50).default(20),cursor:z.string().max(768).optional()}).strict();
function fail(code:string,statusCode=403):never{throw Object.assign(new Error(code),{code,statusCode});}
function matches(a:any,m:any,c:ReturnType<typeof context>){
 return a.enabled&&a.userId===c.id&&a.tenantId===c.tenantId&&a.companyId===c.companyId&&a.tenantMembershipId===c.tenantMembershipId&&
 ["proposer","checker"].includes(a.kind)&&keys(m).includes(a.kind==="proposer"?"membership.proposeFinancial":"membership.approveFinancial")&&
 m.scopes.some((s:any)=>s.scopeType==="company"&&s.scopeRefId===c.companyId)&&a.action==="operator-authorize"&&
 a.result?.companyMembershipId===m.id&&a.result?.kind===a.kind&&a.result?.legalEntityId===a.legalEntityId&&
 JSON.stringify(a.result?.profileRevisions)===JSON.stringify(a.profileRevisions)&&financialProfilesSchema.safeParse(a.profileRevisions).success;
}
async function currentGrant(tx:Prisma.TransactionClient,id:string,c:ReturnType<typeof context>){
 const g=(await tx.$queryRaw<any[]>`SELECT g.*,a.action,a.result FROM "FinancialMembershipGrant" g
 JOIN "FinancialGrantAction" a ON a."operationId"=g."acceptedOperationId" AND a."targetMembershipId"=g."membershipId"
 AND a."tenantId"=g."tenantId" AND a."companyId"=g."companyId" AND a."legalEntityId"=g."legalEntityId"
 WHERE g."membershipId"=${id}::uuid AND g."tenantId"=${c.tenantId}::uuid AND g."companyId"=${c.companyId}::uuid`)[0];
 if(g&&(g.action!=="accept"||g.result?.acceptanceId!==g.acceptedOperationId||g.result?.legalEntityId!==g.legalEntityId||
 JSON.stringify(g.result?.roleIds)!==JSON.stringify(g.roleIds)||JSON.stringify(g.result?.profileRevisions)!==JSON.stringify(g.profileRevisions)))fail("FINANCIAL_GRANT_INCONSISTENT");
 return g;
}
/** Snapshot discovery only. No business writes, row/advisory locks or receipt effects. */
export async function readFinancialAccess(db:PrismaClient,actor:AppUser,input:unknown){
 const c=context(actor),p=query.parse(input);
 return db.$transaction(async tx=>{
  const actorMember=await member(tx,c.companyMembershipId);agrees(actorMember,c);
  const raw=await tx.$queryRaw<any[]>`SELECT d.*,j.action,j.result FROM "FinancialDelegationAuthority" d
   JOIN "FinancialGrantAction" j ON j."operationId"=d."acceptedOperationId" AND j."targetMembershipId"=d."membershipId"
   AND j."tenantId"=d."tenantId" AND j."companyId"=d."companyId" AND j."legalEntityId"=d."legalEntityId"
   WHERE d."membershipId"=${c.companyMembershipId}::uuid`;
  const authorities=[];
  for(const a of raw){
   if(!matches(a,actorMember,c))continue;
   const e=await tx.financeLegalEntity.findFirst({where:{id:a.legalEntityId,tenantId:c.tenantId,companyId:c.companyId,isActive:true},select:{id:true,baseCurrency:true,company:{select:{name:true}}}});
   if(e)authorities.push({...a,entity:{id:e.id,name:e.company.name,baseCurrency:e.baseCurrency}});
  }
  if(!authorities.length)fail("FINANCIAL_CEILING_REQUIRED");
  if(p.view==="ceiling"){
   if(p.cursor)fail("FINANCIAL_CURSOR_REJECTED",400);
   return {revision:"financial-delegation.v1",authorities:authorities.map(a=>({kind:a.kind,legalEntity:a.entity,profiles:a.profileRevisions.map((revision:keyof typeof FINANCIAL_PROFILES)=>({revision,permissions:FINANCIAL_PROFILES[revision]}))}))};
  }
  const a=authorities.find(a=>a.kind===p.kind);if(!a)fail("FINANCIAL_CEILING_REQUIRED");
  const binding={tenantId:c.tenantId,companyId:c.companyId,membershipId:c.companyMembershipId,legalEntityId:a.legalEntityId,kind:p.kind,view:p.view};
  let after:string|null=null;
  if(p.cursor){try{const v=z.object({tenantId:uuid,companyId:uuid,membershipId:uuid,legalEntityId:uuid,kind:z.enum(["proposer","checker"]),view:z.enum(["recipients","proposals","grants"]),after:uuid}).strict().parse(JSON.parse(Buffer.from(p.cursor,"base64url").toString("utf8")));for(const [k,value] of Object.entries(binding))if(v[k as keyof typeof v]!==value)throw Error("Foreign cursor");after=v.after;}catch{fail("FINANCIAL_CURSOR_REJECTED",400);}}
  const next=(id:string)=>Buffer.from(JSON.stringify({...binding,after:id})).toString("base64url");
  const items:any[]=[];
  if(p.view==="recipients"||p.view==="grants"){
   if(p.view==="recipients"&&p.kind!=="proposer")fail("FINANCIAL_CEILING_REQUIRED");
   const rows=await tx.companyMembership.findMany({where:{tenantId:c.tenantId,companyId:c.companyId,userId:{not:c.id},...(after?{id:{gt:after}}:{})},select:{id:true,user:{select:{name:true}}},orderBy:{id:"asc"},take:p.limit+1});
   for(const r of rows.slice(0,p.limit)){
    try{
     const g=await currentGrant(tx,r.id,c);
     if(g&&(g.legalEntityId!==a.legalEntityId||g.profileRevisions.some((v:string)=>!a.profileRevisions.includes(v))))continue;
     if(p.view==="grants"){
      if(!g)continue;
      const m=await tx.companyMembership.findUnique({where:{id:r.id},select:{userId:true,tenantMembershipId:true,tenantMembership:{select:{userId:true,tenantId:true}}}});
      if(!m||g.userId!==m.userId||g.tenantMembershipId!==m.tenantMembershipId||m.tenantMembership?.userId!==m.userId||m.tenantMembership?.tenantId!==c.tenantId)continue;
      items.push({membershipId:r.id,name:r.user.name,legalEntityId:g.legalEntityId,profileRevisions:g.profileRevisions,enabled:g.enabled,acceptanceId:g.acceptedOperationId,managed:true});continue;
     }
     const m=await member(tx,r.id);
     if(m.companyId!==c.companyId||m.tenantId!==c.tenantId||m.roles.some(r=>r.role.isSystem||r.role.isOwnerRole||r.role.companyId!==c.companyId)||
      !m.scopes.some(s=>s.scopeType==="company"&&s.scopeRefId===c.companyId)||await tx.companyDriverEligibility.findUnique({where:{membershipId:m.id},select:{membershipId:true}}))continue;
     if(m.roles.some(r=>!(g?.roleIds??[]).includes(r.roleId)&&r.role.rolePermissions.some(rp=>FINANCIAL_ACCEPTANCE_KEYS.includes(rp.permission.key))))continue;
     items.push({membershipId:r.id,name:r.user.name,expectedAcceptanceId:g?.acceptedOperationId??null,currentProfiles:g?.profileRevisions??[],currentEnabled:g?.enabled??false});
    }catch(e){if((e as any).statusCode!==403)throw e;}
   }
   return {items,nextCursor:rows.length>p.limit?next(rows[p.limit-1].id):null};
  }
  const rows=await tx.$queryRaw<any[]>`SELECT p."operationId",p."targetMembershipId",p."proposerUserId",p."recipientUserId",p."proposerMembershipId",p."legalEntityId",p."profileRevisions",p."expectedAcceptanceId",p."expectedEnabled",p."proposerAcceptanceId",p.fingerprint,p.reason,p."createdAt",u.name AS "recipientName",
    (SELECT x."operationId" FROM "FinancialGrantAction" x WHERE x."proposalId"=p."operationId" AND x.action='accept') AS "acceptanceId"
   FROM "FinancialGrantProposal" p JOIN "CompanyMembership" m ON m.id=p."targetMembershipId" AND m."userId"=p."recipientUserId" AND m."tenantId"=p."tenantId" AND m."companyId"=p."companyId"
   JOIN "User" u ON u.id=m."userId"
   WHERE p."tenantId"=${c.tenantId}::uuid AND p."companyId"=${c.companyId}::uuid AND p."legalEntityId"=${a.legalEntityId}::uuid
    AND p."profileRevisions" <@ ${a.profileRevisions}::text[] AND (${after}::uuid IS NULL OR p."operationId">${after}::uuid)
   ORDER BY p."operationId" ASC LIMIT ${p.limit+1}`;
  for(const r of rows.slice(0,p.limit)){
   if(p.kind==="proposer"&&r.proposerUserId!==c.id)continue;
   const g=await currentGrant(tx,r.targetMembershipId,c);
   if(g?.enabled&&(g.legalEntityId!==a.legalEntityId||g.profileRevisions.some((v:string)=>!a.profileRevisions.includes(v))))continue;
   items.push({proposalId:r.operationId,membershipId:r.targetMembershipId,recipientName:r.recipientName,legalEntityId:r.legalEntityId,profileRevisions:r.profileRevisions,expectedAcceptanceId:r.expectedAcceptanceId,expectedEnabled:r.expectedEnabled,fingerprint:r.fingerprint,reason:r.reason,createdAt:r.createdAt,acceptanceId:r.acceptanceId,state:r.acceptanceId?"accepted":"pending",independent:c.id!==r.proposerUserId&&c.id!==r.recipientUserId,stale:(g?.acceptedOperationId??null)!==r.expectedAcceptanceId||(g?.enabled??false)!==r.expectedEnabled});
  }
  return {items,nextCursor:rows.length>p.limit?next(rows[p.limit-1].operationId):null};
 },{maxWait:3000,timeout:15000});
}
