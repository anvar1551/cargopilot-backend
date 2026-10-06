import type { Prisma } from "@prisma/client";
import type { AppUser } from "../../../types/app-user";
import { companyMembershipPrimitives } from "./company-delegation";
import { lockSelectedIdentityReferences } from "./credential-lock";
import { lockCashDriver, validateCashBase } from "./cash-capability-delegation";
import { CASH_CAPABILITY_PROFILES, cashCapabilityProfilesSchema } from "./cash-capability-profiles";
export const cashDenied = (code="CASH_CAPABILITY_REQUIRED",statusCode=403):never=>{throw Object.assign(new Error(code),{code,statusCode});};
export async function acceptedCashCapability(tx:Prisma.TransactionClient,actor:Pick<AppUser,"id"|"tenantId"|"companyId"|"tenantMembershipId"|"companyMembershipId"|"membershipId">,permission?:string,locked=false) {
 const c=companyMembershipPrimitives.context(actor as AppUser);
 if(locked){await lockCashDriver(tx,c.companyMembershipId);if(!await lockSelectedIdentityReferences(tx,{userId:c.id,...c}))return cashDenied();}
 const rows=await tx.$queryRaw<any[]>`SELECT g.*,a.result,a.action FROM "CashCapabilityMembershipGrant" g
 JOIN "CashCapabilityGrantAction" a ON a."operationId"=g."acceptedOperationId" AND a."targetMembershipId"=g."membershipId"
 AND a."tenantId"=g."tenantId" AND a."companyId"=g."companyId" AND a."legalEntityId"=g."legalEntityId"
 WHERE g."membershipId"=${c.companyMembershipId}::uuid FOR SHARE OF g`;
 const g=rows[0],p=cashCapabilityProfilesSchema.safeParse(g?.profileRevisions);
 if(!g?.enabled||!p.success||g.action!=="accept"||g.userId!==c.id||g.tenantId!==c.tenantId||g.companyId!==c.companyId||g.tenantMembershipId!==c.tenantMembershipId||
 g.result?.acceptanceId!==g.acceptedOperationId||g.result?.companyMembershipId!==c.companyMembershipId||g.result?.legalEntityId!==g.legalEntityId||
 JSON.stringify(g.result?.profileRevisions)!==JSON.stringify(g.profileRevisions)||JSON.stringify(g.result?.warehouseIds)!==JSON.stringify(g.warehouseIds)||JSON.stringify(g.result?.kinds)!==JSON.stringify(g.kinds))return cashDenied();
 const m=await companyMembershipPrimitives.member(tx,c.companyMembershipId);companyMembershipPrimitives.agrees(m,c);
 await validateCashBase(tx,m,p.data[0],g.warehouseIds);
 const owned=await tx.warehouse.count({where:{id:{in:g.warehouseIds},tenantId:c.tenantId}});
 await tx.$queryRaw`SELECT id FROM "FinanceLegalEntity" WHERE id=${g.legalEntityId}::uuid AND "tenantId"=${c.tenantId}::uuid AND "companyId"=${c.companyId}::uuid FOR SHARE`;
 if(owned!==g.warehouseIds.length||!await tx.financeLegalEntity.findFirst({where:{id:g.legalEntityId,tenantId:c.tenantId,companyId:c.companyId,isActive:true}}))return cashDenied();
 const permissions=[...CASH_CAPABILITY_PROFILES[p.data[0]]];if(permission&&!permissions.includes(permission as never))return cashDenied();
 return {...g,profileRevision:p.data[0],permissions,member:m,context:c};
}
