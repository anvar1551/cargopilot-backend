import { randomUUID } from "node:crypto";
import { normalizeCashCapabilityAuthorityIntent } from "../../src/modules/identity-access/application/cash-capability-delegation";
import { CASH_CAPABILITY_PROFILES } from "../../src/modules/identity-access/application/cash-capability-profiles";
jest.mock("../../src/config/prismaClient",()=>({default:{},__esModule:true}));
jest.mock("../../src/config/redis",()=>({getRedisClient:async()=>null}));
const input=()=>({operationId:randomUUID(),membershipId:randomUUID(),userId:randomUUID(),tenantId:randomUUID(),companyId:randomUUID(),tenantMembershipId:randomUUID(),legalEntityId:randomUUID(),action:"operator-authorize",kind:"proposer",profileRevision:"cash-delegation.v1",profileRevisions:["local-driver-cash.v1","warehouse-cash.v1"],warehouseIds:[randomUUID()],kinds:["service_charge"],reason:"Synthetic owner review"});
it("binds the exact operator-authorized identity and resource intent",()=>{
 const v=input(),r=normalizeCashCapabilityAuthorityIntent(v);expect(r.intent).toMatchObject(v);
 expect(normalizeCashCapabilityAuthorityIntent({...v,userId:randomUUID()}).fingerprint).not.toBe(r.fingerprint);
 expect(normalizeCashCapabilityAuthorityIntent({...v,warehouseIds:[randomUUID()]}).fingerprint).not.toBe(r.fingerprint);
});
it("normalizes warehouse and profile order deterministically",()=>{
 const v={...input(),warehouseIds:[randomUUID(),randomUUID()]};
 expect(normalizeCashCapabilityAuthorityIntent(v)).toEqual(normalizeCashCapabilityAuthorityIntent({...v,warehouseIds:[...v.warehouseIds].reverse(),profileRevisions:[...v.profileRevisions].reverse()}));
});
it.each(["tenantId","userId","tenantMembershipId"])("rejects an incomplete signed %s bridge",key=>{const v:any=input();delete v[key];expect(()=>normalizeCashCapabilityAuthorityIntent(v)).toThrow();});
it.each([{warehouseIds:[]},{kinds:[]},{profileRevisions:["local-driver.v1"]},{permissionKeys:["shipment.update"]}])("rejects missing ceilings or arbitrary grants %j",change=>expect(()=>normalizeCashCapabilityAuthorityIntent({...input(),...change})).toThrow());
it("cash supplements exclude broad logistics, delegation and finance execution",()=>{
 expect(CASH_CAPABILITY_PROFILES).toEqual({"local-driver-cash.v1":["cash.custody.read","cash.collect","cash.handoff"],"warehouse-cash.v1":["cash.custody.read","cash.collect","cash.handoff"],"cash-settlement-checker.v1":["cash.custody.read","cash.settle"]});
});
