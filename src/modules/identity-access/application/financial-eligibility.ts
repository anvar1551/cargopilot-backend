import type { Prisma } from "@prisma/client";
import type { AppUser } from "../../../types/app-user";
import { lockSelectedIdentityReferences } from "./credential-lock";
import { companyMembershipPrimitives } from "./company-delegation";
import { FINANCIAL_ACCEPTANCE_KEYS, FINANCIAL_PROFILES, financialProfilesSchema } from "./financial-profiles";

/** Called in the business transaction. SHARE fences profile replacement/revocation
 * until that operation commits. Receipts never substitute for current eligibility. */
export async function requireAcceptedFinancialCapability(tx: Prisma.TransactionClient, actor: Pick<AppUser,
  "id"|"tenantId"|"companyId"|"tenantMembershipId"|"companyMembershipId"|"membershipId">, permission: string, legalEntityId?: string) {
  if (!FINANCIAL_ACCEPTANCE_KEYS.includes(permission)) return;
  const deny=()=>{throw Object.assign(new Error("Accepted financial capability required"),{statusCode:403,code:"FINANCIAL_ACCEPTANCE_REQUIRED"});};
  if(!actor.tenantId||!actor.companyId||!actor.tenantMembershipId||!actor.companyMembershipId||actor.membershipId!==actor.companyMembershipId)return deny();
  // Match credential/grant administration's User -> membership -> grant order.
  // Otherwise a later actor FK can wait behind revocation's membership UPDATE
  // while revocation waits behind this transaction's grant SHARE. Pin only the
  // actor's existing references; do not take credential values or mutate them.
  if(!await lockSelectedIdentityReferences(tx,{userId:actor.id,tenantId:actor.tenantId,
    companyId:actor.companyId,tenantMembershipId:actor.tenantMembershipId,companyMembershipId:actor.companyMembershipId}))return deny();
  const g=(await tx.$queryRaw<any[]>`SELECT g.*,a.action,a.result FROM "FinancialMembershipGrant" g
    JOIN "FinancialGrantAction" a ON a."operationId"=g."acceptedOperationId" AND a."targetMembershipId"=g."membershipId"
      AND a."tenantId"=g."tenantId" AND a."companyId"=g."companyId" AND a."legalEntityId"=g."legalEntityId"
    WHERE g."membershipId"=${actor.companyMembershipId}::uuid FOR SHARE OF g`)[0];
  const parsed=financialProfilesSchema.safeParse(g?.profileRevisions);
  if(!g?.enabled||g.action!=="accept"||!parsed.success||g.userId!==actor.id||g.tenantId!==actor.tenantId||g.companyId!==actor.companyId||
    g.tenantMembershipId!==actor.tenantMembershipId||(legalEntityId&&g.legalEntityId!==legalEntityId)||
    g.result?.acceptanceId!==g.acceptedOperationId||g.result?.legalEntityId!==g.legalEntityId||
    JSON.stringify(g.result?.profileRevisions)!==JSON.stringify(parsed.data)||JSON.stringify(g.result?.roleIds)!==JSON.stringify(g.roleIds))return deny();
  const m=await companyMembershipPrimitives.member(tx,actor.companyMembershipId);
  companyMembershipPrimitives.agrees(m,{id:actor.id,tenantId:actor.tenantId,companyId:actor.companyId,tenantMembershipId:actor.tenantMembershipId,companyMembershipId:actor.companyMembershipId});
  if(!m.scopes.some(s=>s.scopeType==="company"&&s.scopeRefId===actor.companyId))return deny();
  if(await tx.companyDriverEligibility.findUnique({where:{membershipId:m.id}}))return deny();
  if(!await tx.financeLegalEntity.findFirst({where:{id:g.legalEntityId,tenantId:actor.tenantId,companyId:actor.companyId,isActive:true}}))return deny();
  const owned=m.roles.filter(r=>g.roleIds.includes(r.roleId));
  if(owned.length!==parsed.data.length||g.roleIds.length!==parsed.data.length)return deny();
  for(const profile of parsed.data){
    const role=owned.find(r=>r.role.code===profile)?.role;
    if(!role||role.isSystem||role.isOwnerRole||role.companyId!==actor.companyId||
      JSON.stringify(role.rolePermissions.map(p=>p.permission.key).sort())!==JSON.stringify([...FINANCIAL_PROFILES[profile]].sort()))return deny();
  }
  if(!parsed.data.some(p=>(FINANCIAL_PROFILES[p] as readonly string[]).includes(permission)))return deny();
}
