jest.mock("../../src/config/prismaClient",()=>({__esModule:true,default:{}}));
jest.mock("../../src/config/redis",()=>({getRedisClient:async()=>null}));
import { initialEntityConfigurationSchema, entityProposalSchema, entityDecisionSchema, normalizeIssuingEntityAuthorityIntent, proposeIssuingEntity } from "../../src/modules/identity-access/application/issuing-entity-setup";
import { randomUUID } from "crypto";
const configuration={baseCurrency:"UZS",fiscalYearStartMonth:4,timezone:"Asia/Tashkent"};
it.each(["UZS","USD","CNY"])("explicit supported currency %s normalizes null reporting without defaults",baseCurrency=>{
  expect(initialEntityConfigurationSchema.parse({...configuration,baseCurrency})).toEqual({...configuration,baseCurrency,reportingCurrency:null});
});
it.each([
  {...configuration,baseCurrency:"EUR"},{...configuration,baseCurrency:"uzs"},
  {...configuration,fiscalYearStartMonth:0},{...configuration,fiscalYearStartMonth:13},{...configuration,fiscalYearStartMonth:1.5},
  {...configuration,fiscalYearStartMonth:undefined},{...configuration,timezone:undefined},
  {...configuration,timezone:"Invented/Timezone"},{...configuration,timezone:"+01:00"},
  {...configuration,reportingCurrency:"USD"},{...configuration,isActive:true},{...configuration,taxId:"invented"},
])("rejects unsupported/implicit/unknown initial configuration %#",v=>expect(initialEntityConfigurationSchema.safeParse(v).success).toBe(false));
it("owner intent is normalized and grants no caller-defined profile",()=>{
 const intent={operationId:randomUUID(),membershipId:randomUUID(),userId:randomUUID(),tenantId:randomUUID(),companyId:randomUUID(),tenantMembershipId:randomUUID(),kind:"proposer",action:"operator-authorize",expectedAcceptanceId:null,profileRevision:"issuing-entity-setup.v1",reason:" Explicit owner decision "};
 const a=normalizeIssuingEntityAuthorityIntent(intent),b=normalizeIssuingEntityAuthorityIntent({...intent,reason:"Explicit owner decision"});
 expect(a).toEqual(b);expect(()=>normalizeIssuingEntityAuthorityIntent({...intent,permissions:["finance.settings.manage"]})).toThrow();
});
it("strict proposal/decision contracts reject request ownership",()=>{
 expect(entityProposalSchema.safeParse({operationId:randomUUID(),reason:"Explicit",configuration,tenantId:randomUUID()}).success).toBe(false);
 expect(entityDecisionSchema.safeParse({operationId:randomUUID(),proposalId:randomUUID(),contentHash:"a".repeat(64),decision:"approved",reason:"Explicit",companyId:randomUUID()}).success).toBe(false);
});
it("missing context rejects before database work",async()=>{
 const db={$transaction:jest.fn()};await expect(proposeIssuingEntity(db as any,{} as any,{})).rejects.toMatchObject({code:"DELEGATION_CONTEXT_REQUIRED"});expect(db.$transaction).not.toHaveBeenCalled();
});
