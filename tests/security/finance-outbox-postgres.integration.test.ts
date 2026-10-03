const mockXadd=jest.fn(async()=>"synthetic-stream-id");
jest.mock("../../src/config/prismaClient",()=>({__esModule:true,default:new Proxy({}, {get:(_t,k)=>{const value=(mockPrisma as any)[k];return typeof value === "function"?value.bind(mockPrisma):value;}})}));
jest.mock("../../src/config/redis",()=>({getRedisClient:async()=>({xadd:mockXadd}),getRedisPrefix:()=>"synthetic",withRedisTimeout:(_label:any,work:any)=>work()}));
import {Pool} from "pg";
import {PrismaClient} from "@prisma/client";
import {PrismaPg} from "@prisma/adapter-pg";
import {randomUUID} from "crypto";
import {createTenantDemoFixture,TENANT_DEMO_IDS as ids} from "../../src/modules/tenancy/demo-fixtures";
import {persistTenantDemoFixture} from "../tenancy/postgres-fixture.persistence";
import {prismaFinanceRepository as repo} from "../../src/modules/finance-core/infrastructure/prisma-finance.repository";
import {LOGISTICS_STANDARD_CHART} from "../../src/modules/finance-core/domain/chart-template";
const url=process.env.CARGOPILOT_WORKER_TEST_DATABASE_URL,runId=process.env.CARGOPILOT_WORKER_RUN_ID;
if(!url||!runId||!/^[a-f0-9]{12}$/.test(runId))throw Error("Disposable account identity required");
const target=new URL(url);if(target.hostname!=="127.0.0.1"||target.username!=="cp_worker_it"||target.pathname!==`/cp_worker_${runId}`)throw Error("Refusing existing database");
const pool=new Pool({connectionString:url,max:2,connectionTimeoutMillis:3000,idleTimeoutMillis:1000,options:"-c statement_timeout=5000"});let mockPrisma:PrismaClient;
const actor=(companyId:string,membershipId:string):any=>({id:ids.users.multiTenant,tenantId:ids.tenants.transAsia,tenantMembershipId:ids.tenantMemberships.multiTransAsia,companyId,companyMembershipId:membershipId,membershipId});
const uz=actor(ids.organizations.transAsiaUz,ids.companyMemberships.multiTransAsiaUz),de=actor(ids.organizations.transAsiaDe,ids.companyMemberships.multiTransAsiaDe);
const intent=(who:any)=>({operationId:randomUUID(),companyId:who.companyId,actorUserId:who.id,code:randomUUID(),name:"SYNTHETIC ONLY",type:"asset" as const,allowPosting:false,isControlAccount:false});
const snapshot=async()=>({accounts:await mockPrisma.financeAccount.findMany({orderBy:{id:"asc"}}),installations:await mockPrisma.financeChartTemplateInstallation.findMany({orderBy:{id:"asc"}}),audit:await mockPrisma.financeAuditEvent.findMany({orderBy:{id:"asc"}}),outbox:await mockPrisma.financeDomainEventOutbox.findMany({orderBy:{id:"asc"}}),journals:await mockPrisma.financeJournalEntry.findMany({orderBy:{id:"asc"}}),documents:await mockPrisma.financeDocument.findMany({orderBy:{id:"asc"}}),lines:await mockPrisma.financeJournalLine.findMany({orderBy:{id:"asc"}}),sequences:await mockPrisma.financeNumberSequence.findMany({orderBy:{id:"asc"}})});
beforeAll(async()=>{
 const proof=await pool.query('SELECT "runId" FROM "_CPDisposableRun"');if(proof.rows.length!==1||proof.rows[0].runId!==runId)throw Error("Disposable storage ownership mismatch");
 const client=await pool.connect();try{await client.query("BEGIN");await persistTenantDemoFixture(client,createTenantDemoFixture());await client.query("COMMIT");}finally{client.release();}
 mockPrisma=new PrismaClient({adapter:new PrismaPg({connectionString:url,max:4,connectionTimeoutMillis:3000,options:"-c statement_timeout=5000"})});
 const permission=await mockPrisma.permission.create({data:{key:"finance.accounts.manage",resource:"synthetic",action:"manage"}});
 for(const who of [uz,de]){const role=await mockPrisma.role.create({data:{companyId:who.companyId,code:"synthetic-account",name:"Synthetic account role"}});await mockPrisma.rolePermission.create({data:{roleId:role.id,permissionId:permission.id}});await mockPrisma.membershipRole.create({data:{membershipId:who.membershipId,roleId:role.id}});if(!await mockPrisma.membershipScope.findFirst({where:{membershipId:who.membershipId,scopeType:"company",scopeRefId:who.companyId}}))await mockPrisma.membershipScope.create({data:{membershipId:who.membershipId,scopeType:"company",scopeRefId:who.companyId}});}
},60000);
afterAll(async()=>{await mockPrisma?.$disconnect();await pool.end();});
it("actual account ownership rejects foreign intent and revoked context without effects",async()=>{
 const account:any=await repo.createAccount(intent(uz),uz);expect(account.legalEntityId).toBe(ids.legalEntities.transAsiaUz);
 const before=await snapshot();for(const companyId of [ids.organizations.transAsiaDe,ids.organizations.unrelated])await expect(repo.createAccount({...intent(uz),companyId},uz)).rejects.toMatchObject({statusCode:403});
 await expect(repo.createAccount(intent(uz),undefined as any)).rejects.toMatchObject({statusCode:403});expect(await snapshot()).toEqual(before);
 await mockPrisma.companyMembership.update({where:{id:uz.membershipId},data:{status:"suspended"}});await expect(repo.createAccount(intent(uz),uz)).rejects.toMatchObject({statusCode:403});expect(await snapshot()).toEqual(before);await mockPrisma.companyMembership.update({where:{id:uz.membershipId},data:{status:"active"}});
});
it("actual standard source installs owned graph and version-scoped retry rejects changed configuration",async()=>{
 const input={companyId:de.companyId,actorUserId:de.id,templateCode:"logistics_standard",templateVersion:1,accounts:[...LOGISTICS_STANDARD_CHART]};
 const created:any=await repo.bootstrapChart(input,de);expect(created.idempotent).toBe(false);expect(created.accounts).toHaveLength(LOGISTICS_STANDARD_CHART.length);expect(created.accounts.every((account:any)=>account.legalEntityId===ids.legalEntities.transAsiaDe)).toBe(true);
 const [chartClaim]=await claimFinanceOutboxBatch();expect(await prepareFinanceDispatch(chartClaim)).toMatchObject({type:"finance.chart_template.installed",legalEntityId:ids.legalEntities.transAsiaDe});expect(await completeFinanceDispatch(chartClaim)).toBe(true);
 const before=await snapshot(),again:any=await repo.bootstrapChart(input,de);expect(again.idempotent).toBe(true);expect(await snapshot()).toEqual(before);
 await expect(repo.bootstrapChart({...input,accounts:[]},de)).rejects.toMatchObject({code:"FINANCE_CHART_TEMPLATE_SOURCE_REJECTED"});expect(await snapshot()).toEqual(before);
 const row=created.accounts[0];await mockPrisma.financeAccount.update({where:{id:row.id},data:{metadataJson:{templateCode:"logistics_standard",templateVersion:2}}});
 const changed=await snapshot();await expect(repo.bootstrapChart(input,de)).rejects.toMatchObject({code:"FINANCE_CHART_TEMPLATE_INTEGRITY_ERROR"});expect(await snapshot()).toEqual(changed);
});
it("actual outbox failure rolls back new account and audit together",async()=>{
 const before=await snapshot();await pool.query(`CREATE FUNCTION cp_account_outbox_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic outbox failure'; END $$;CREATE TRIGGER cp_account_outbox_fail BEFORE INSERT ON "FinanceDomainEventOutbox" FOR EACH ROW EXECUTE FUNCTION cp_account_outbox_fail();`);
 try{await expect(repo.createAccount(intent(de),de)).rejects.toThrow("synthetic outbox failure");expect(await snapshot()).toEqual(before);}finally{await pool.query('DROP TRIGGER cp_account_outbox_fail ON "FinanceDomainEventOutbox";DROP FUNCTION cp_account_outbox_fail();');}
});

import {claimFinanceOutboxBatch,prepareFinanceDispatch,completeFinanceDispatch,failFinanceClaim,processFinanceOutboxBatchOnce} from "../../src/modules/finance-core/infrastructure/finance-outbox.publisher";
import {enqueueAcceptedFinancePublication,financePublicationHash} from "../../src/modules/finance-core/infrastructure/finance-outbox-authority";
beforeEach(async()=>{
 mockXadd.mockClear();
 await pool.query(`UPDATE "FinanceDomainEventOutbox" SET "publicationState"=CASE WHEN "publicationState"='dispatching' THEN 'reconciliation_required' ELSE 'quarantined' END,"claimedAt"=NULL,"claimToken"=NULL,"leaseExpiresAt"=NULL WHERE "publicationState" IN ('ready','claimed','dispatching')`);
});
const accepted=async()=>{
 const account:any=await repo.createAccount(intent(de),de);
 return mockPrisma.financeDomainEventOutbox.findFirstOrThrow({where:{accountId:account.id}});
};
const current=(id:string)=>mockPrisma.financeDomainEventOutbox.findUniqueOrThrow({where:{id}});
const expired=async(id:string)=>{await pool.query(`UPDATE "FinanceDomainEventOutbox" SET "claimedAt"=now()-interval '31 seconds',"leaseExpiresAt"=now()-interval '1 second' WHERE id=$1`,[id]);};
it("catalog retains four NOT VALID typed references and two completeness/state checks",async()=>{
 const names=["FinanceOutbox_owner_fkey","FinanceOutbox_account_fkey","FinanceOutbox_chart_fkey","FinanceOutbox_journal_fkey","FinanceOutbox_acceptance_check","FinanceOutbox_state_check"];
 const rows=(await pool.query("SELECT conname,convalidated,pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conname=ANY($1)",[names])).rows;
 expect(rows).toHaveLength(6);expect(rows.every(r=>!r.convalidated)).toBe(true);
 expect(rows.find(r=>r.conname==="FinanceOutbox_owner_fkey").definition).toContain('REFERENCES "FinanceLegalEntity"(id, "tenantId", "companyId")');
 expect(rows.find(r=>r.conname==="FinanceOutbox_chart_fkey").definition).toContain('REFERENCES "FinanceChartTemplateInstallation"("legalEntityId", id)');
});
it.each(["foreign-tenant","same-tenant-company","foreign-account","partial-owner","no-subject","two-subjects","unsupported","payload"])
("new %s accepted reference rejects atomically with no business effects",async kind=>{
 const base:any=await accepted(),before=await snapshot();const {id,createdAt,updatedAt,...data}=base;data.eventId=randomUUID();
 if(kind==="foreign-tenant")data.tenantId=ids.tenants.unrelated;
 if(kind==="same-tenant-company")data.companyId=ids.organizations.transAsiaUz;
 if(kind==="foreign-account"){data.legalEntityId=ids.legalEntities.transAsiaUz;data.companyId=ids.organizations.transAsiaUz;}
 if(kind==="partial-owner")data.companyId=null;if(kind==="no-subject")data.accountId=null;
 if(kind==="two-subjects")data.installationId=randomUUID();if(kind==="unsupported"){data.capability="posting";data.eventType="finance.journal.posted";}
 if(kind==="payload")data.payloadJson={amount:"999",companyId:ids.organizations.unrelated};
 data.contentHash=financePublicationHash(data);
 await expect(mockPrisma.$transaction(tx=>tx.financeDomainEventOutbox.create({data}))).rejects.toThrow();
 expect(await snapshot()).toEqual(before);expect(mockXadd).not.toHaveBeenCalled();
});
it.each(["companyId","aggregateId","contentHash"])("accepted %s update is immutable and has no side effects",async field=>{
 const row=await accepted(),before=await snapshot();
 await expect(mockPrisma.financeDomainEventOutbox.update({where:{id:row.id},data:{[field]:field==="contentHash"?"a".repeat(64):randomUUID()}})).rejects.toThrow();
 expect(await snapshot()).toEqual(before);expect(mockXadd).not.toHaveBeenCalled();
});
it("legacy acceptance cannot be adopted and is never claimed",async()=>{
 const account=await mockPrisma.financeAccount.findFirstOrThrow({where:{legalEntityId:ids.legalEntities.transAsiaDe}});
 const legacy=await mockPrisma.financeDomainEventOutbox.create({data:{legalEntityId:account.legalEntityId,aggregateType:"finance_account",aggregateId:account.id,eventType:"finance.account.created",occurredAt:new Date(),payloadJson:{}}});
 const before=await snapshot();await expect(mockPrisma.financeDomainEventOutbox.update({where:{id:legacy.id},data:{acceptedAt:new Date(),tenantId:de.tenantId,companyId:de.companyId,accountId:account.id,capability:"account_invalidation",publicationState:"ready",contentHash:"a".repeat(64)}})).rejects.toThrow();
 expect(await claimFinanceOutboxBatch()).toEqual([]);expect(await snapshot()).toEqual(before);
});
it("concurrent claims partition distinct records and duplicate processing publishes once",async()=>{
 const rows=await Promise.all([accepted(),accepted(),accepted()]);const claims=(await Promise.all([claimFinanceOutboxBatch(2),claimFinanceOutboxBatch(2)])).flat();
 expect(claims).toHaveLength(3);expect(new Set(claims.map(c=>c.id)).size).toBe(3);
 expect(new Set(claims.map(c=>c.id))).toEqual(new Set(rows.map(r=>r.id)));
 const chosen=claims[0],before=await snapshot();const outputs=await Promise.all([prepareFinanceDispatch(chosen),prepareFinanceDispatch(chosen)]);
 expect(outputs.filter(Boolean)).toHaveLength(1);expect(await completeFinanceDispatch(chosen)).toBe(true);expect(await completeFinanceDispatch(chosen)).toBe(false);
 expect(await prepareFinanceDispatch(chosen)).toBeNull();expect((await current(chosen.id)).attempts).toBe(1);
 expect((await snapshot()).accounts).toEqual(before.accounts);expect((await snapshot()).journals).toEqual(before.journals);expect(mockXadd).not.toHaveBeenCalled();
});
it("expired pre-dispatch claim recovers with a new fence and stale worker cannot mutate",async()=>{
 const row=await accepted(),[old]=await claimFinanceOutboxBatch();await expired(row.id);const [fresh]=await claimFinanceOutboxBatch();
 expect(fresh.id).toBe(old.id);expect(fresh.claimToken).not.toBe(old.claimToken);
 const before=await current(row.id);expect(await prepareFinanceDispatch(old)).toBeNull();expect(await completeFinanceDispatch(old)).toBe(false);await failFinanceClaim(old);expect(await current(row.id)).toEqual(before);
 expect(await prepareFinanceDispatch(fresh)).not.toBeNull();expect(await completeFinanceDispatch(fresh)).toBe(true);
});
it("expired dispatch is reconciliation-required, not reclaimed or completed",async()=>{
 const row=await accepted(),[claim]=await claimFinanceOutboxBatch();expect(await prepareFinanceDispatch(claim)).not.toBeNull();await expired(row.id);
 expect(await completeFinanceDispatch(claim)).toBe(false);expect(await claimFinanceOutboxBatch()).toEqual([]);expect((await current(row.id)).publicationState).toBe("reconciliation_required");
 await expect(mockPrisma.financeDomainEventOutbox.update({where:{id:row.id},data:{publicationState:"ready",dispatchStartedAt:null}})).rejects.toThrow();
});
it.each(["tenant","company","entity","account"])("current %s disablement rejects before dispatch",async kind=>{
 const row=await accepted(),[claim]=await claimFinanceOutboxBatch();
 const change=kind==="tenant"?()=>mockPrisma.tenant.update({where:{id:row.tenantId!},data:{status:"suspended"}}):
 kind==="company"?()=>mockPrisma.organization.update({where:{id:row.companyId!},data:{isActive:false}}):
 kind==="entity"?()=>mockPrisma.financeLegalEntity.update({where:{id:row.legalEntityId},data:{isActive:false}}):
 ()=>mockPrisma.financeAccount.update({where:{id:row.accountId!},data:{status:"inactive"}});
 await change();const before=await snapshot();
 try{expect(await prepareFinanceDispatch(claim)).toBeNull();expect((await current(row.id)).publicationState).toBe("quarantined");expect(mockXadd).not.toHaveBeenCalled();expect((await snapshot()).accounts).toEqual(before.accounts);expect((await snapshot()).audit).toEqual(before.audit);}
 finally{
 if(kind==="tenant")await mockPrisma.tenant.update({where:{id:row.tenantId!},data:{status:"active"}});
 if(kind==="company")await mockPrisma.organization.update({where:{id:row.companyId!},data:{isActive:true}});
 if(kind==="entity")await mockPrisma.financeLegalEntity.update({where:{id:row.legalEntityId},data:{isActive:true}});
 if(kind==="account")await mockPrisma.financeAccount.update({where:{id:row.accountId!},data:{status:"active"}});
 }
});
it("marker transaction failure rolls back and remains safely pre-dispatch retryable",async()=>{
 const row=await accepted(),[claim]=await claimFinanceOutboxBatch(),before=await current(row.id);
 await pool.query(`CREATE FUNCTION cp_finance_marker_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."publicationState"='dispatching' THEN RAISE EXCEPTION 'synthetic marker failure'; END IF; RETURN NEW; END $$;CREATE TRIGGER cp_finance_marker_fail BEFORE UPDATE ON "FinanceDomainEventOutbox" FOR EACH ROW EXECUTE FUNCTION cp_finance_marker_fail();`);
 try{await expect(prepareFinanceDispatch(claim)).rejects.toThrow("synthetic marker failure");expect(await current(row.id)).toEqual(before);expect(mockXadd).not.toHaveBeenCalled();}
 finally{await pool.query('DROP TRIGGER cp_finance_marker_fail ON "FinanceDomainEventOutbox";DROP FUNCTION cp_finance_marker_fail();');}
 await failFinanceClaim(claim);const retry=await current(row.id);expect(retry.publicationState).toBe("ready");expect(retry.nextAttemptAt.getTime()).toBeGreaterThan(retry.claimedAt?.getTime()??0);expect(await claimFinanceOutboxBatch()).toEqual([]);
});
it.each(["append","confirmation"])("%s uncertainty preserves one attempt without automatic replay",async kind=>{
 const row=await accepted();if(kind==="append")mockXadd.mockRejectedValueOnce(Error("synthetic transport uncertainty"));
 if(kind==="confirmation")await pool.query(`CREATE FUNCTION cp_finance_confirm_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."publicationState"='published' THEN RAISE EXCEPTION 'synthetic confirm failure'; END IF; RETURN NEW; END $$;CREATE TRIGGER cp_finance_confirm_fail BEFORE UPDATE ON "FinanceDomainEventOutbox" FOR EACH ROW EXECUTE FUNCTION cp_finance_confirm_fail();`);
 try{expect(await processFinanceOutboxBatchOnce()).toMatchObject({claimed:1,published:0,failed:1});expect(mockXadd).toHaveBeenCalledTimes(1);expect((await current(row.id)).publicationState).toBe("reconciliation_required");expect(await processFinanceOutboxBatchOnce()).toMatchObject({claimed:0});expect(mockXadd).toHaveBeenCalledTimes(1);}
 finally{if(kind==="confirmation")await pool.query('DROP TRIGGER cp_finance_confirm_fail ON "FinanceDomainEventOutbox";DROP FUNCTION cp_finance_confirm_fail();');}
});
it("maximum safe attempts exhaust and are not claimable",async()=>{
 const row=await accepted();await mockPrisma.financeDomainEventOutbox.update({where:{id:row.id},data:{attempts:8}});
 expect(await claimFinanceOutboxBatch()).toEqual([]);expect((await current(row.id)).publicationState).toBe("exhausted");
});
it("current accepted account publishes minimal source once, without monetary or journal effects",async()=>{
 const row=await accepted(),before=await snapshot();expect(await processFinanceOutboxBatchOnce()).toMatchObject({published:1});
 const args=mockXadd.mock.calls[0] as unknown as any[],wire=JSON.parse(args[args.length-1]);
 expect(wire.payload).toEqual({outboxId:row.id,sourceId:row.accountId});expect(wire.legalEntityId).toBe(row.legalEntityId);expect(wire.tenantScope).toBe(`tenant:${row.tenantId}:company:${row.companyId}`);
 expect(await processFinanceOutboxBatchOnce()).toMatchObject({claimed:0});expect(mockXadd).toHaveBeenCalledTimes(1);const after=await snapshot();
 expect(after.accounts).toEqual(before.accounts);expect(after.journals).toEqual(before.journals);expect(after.audit).toEqual(before.audit);
});
it("supported draft source is accepted in its actual authorized transaction; matching retry has no effects",async()=>{
 const permission=await mockPrisma.permission.create({data:{key:"finance.journals.create",resource:"synthetic",action:"create"}});
 const role=await mockPrisma.role.findFirstOrThrow({where:{companyId:uz.companyId,code:"synthetic-account"}});
 await mockPrisma.rolePermission.create({data:{roleId:role.id,permissionId:permission.id}});
 const account:any=await repo.createAccount({...intent(uz),allowPosting:true},uz);
 await mockPrisma.financeFiscalPeriod.create({data:{legalEntityId:account.legalEntityId,fiscalYear:2026,periodNumber:1,name:"Synthetic only",startDate:new Date("2026-01-01"),endDate:new Date("2026-01-31")}});
 const command={companyId:uz.companyId,actorUserId:uz.id,idempotencyKey:randomUUID(),documentDate:new Date("2026-01-01"),postingDate:new Date("2026-01-01"),currency:"UZS",fxRate:"1",lines:[{accountId:account.id,debitAmount:"0.1000",creditAmount:"0"},{accountId:account.id,debitAmount:"0",creditAmount:"0.1000"}]};
 const result:any=await repo.createDraftJournal(command,uz);const row=await mockPrisma.financeDomainEventOutbox.findFirstOrThrow({where:{journalId:result.id}});
 expect(row.capability).toBe("draft_invalidation");expect(row.tenantId).toBe(uz.tenantId);expect(row.companyId).toBe(uz.companyId);expect(row.payloadJson).toEqual({});
 const before=await snapshot();expect(await repo.createDraftJournal(command,uz)).toEqual(result);expect(await snapshot()).toEqual(before);
 // Isolate its claim from the account fact accepted immediately above.
 await mockPrisma.financeDomainEventOutbox.updateMany({where:{publicationState:"ready",accountId:{not:null}},data:{nextAttemptAt:new Date("2100-01-01")}});
 const [claim]=await claimFinanceOutboxBatch();expect(claim.id).toBe(row.id);expect(await prepareFinanceDispatch(claim)).toMatchObject({payload:{outboxId:row.id,sourceId:result.id}});
 expect(await completeFinanceDispatch(claim)).toBe(true);
});
it("unsupported capability aborts its source transaction rather than accepting arbitrary posting",async()=>{
 const before=await snapshot();await expect(mockPrisma.$transaction(async tx=>{
 const account=await tx.financeAccount.create({data:{legalEntityId:ids.legalEntities.transAsiaDe,code:randomUUID(),name:"Synthetic",type:"asset"}});
 await enqueueAcceptedFinancePublication(tx,{legalEntityId:account.legalEntityId,aggregateType:"finance_account",aggregateId:account.id,eventType:"finance.journal.posted"});
 })).rejects.toMatchObject({code:"FINANCE_OUTBOX_SOURCE_REJECTED"});expect(await snapshot()).toEqual(before);expect(mockXadd).not.toHaveBeenCalled();
});
it.each(["chart","journal"])("foreign entity %s subject cannot be accepted",async kind=>{
 const entityId=kind==="chart"?ids.legalEntities.transAsiaUz:ids.legalEntities.transAsiaDe;
 const subject:any=kind==="chart"?await mockPrisma.financeChartTemplateInstallation.findFirstOrThrow():await mockPrisma.financeJournalEntry.findFirstOrThrow();
 const input={legalEntityId:entityId,aggregateType:kind==="chart"?"finance_chart_template":"finance_journal",aggregateId:subject.id,eventType:kind==="chart"?"finance.chart_template.installed":"finance.journal.draft_created"};
 const row:any={...input,eventId:randomUUID(),schemaVersion:1,occurredAt:new Date(),acceptedAt:new Date(),tenantId:ids.tenants.transAsia,companyId:kind==="chart"?ids.organizations.transAsiaUz:ids.organizations.transAsiaDe,
 accountId:null,installationId:kind==="chart"?subject.id:null,journalId:kind==="journal"?subject.id:null,capability:kind==="chart"?"chart_invalidation":"draft_invalidation",payloadJson:{},publicationState:"ready"};
 row.contentHash=financePublicationHash(row);const before=await snapshot();await expect(mockPrisma.financeDomainEventOutbox.create({data:row})).rejects.toThrow();expect(await snapshot()).toEqual(before);expect(mockXadd).not.toHaveBeenCalled();
});

async function isolatedChartContext(){
 const company=await mockPrisma.organization.create({data:{tenantId:ids.tenants.unrelated,name:"SYNTHETIC CHART CONCURRENCY ONLY",type:"company"}});
 const entity=await mockPrisma.financeLegalEntity.create({data:{tenantId:ids.tenants.unrelated,companyId:company.id,baseCurrency:"USD",timezone:"UTC",createdByUserId:ids.users.multiTenant,updatedByUserId:ids.users.multiTenant}});
 const member=await mockPrisma.companyMembership.create({data:{userId:ids.users.multiTenant,tenantId:ids.tenants.unrelated,tenantMembershipId:ids.tenantMemberships.multiUnrelated,companyId:company.id}});
 const role=await mockPrisma.role.create({data:{companyId:company.id,code:randomUUID(),name:"Synthetic only"}});
 const permission=await mockPrisma.permission.findUniqueOrThrow({where:{key:"finance.accounts.manage"}});
 await mockPrisma.rolePermission.create({data:{roleId:role.id,permissionId:permission.id}});await mockPrisma.membershipRole.create({data:{membershipId:member.id,roleId:role.id}});
 await mockPrisma.membershipScope.create({data:{membershipId:member.id,scopeType:"company",scopeRefId:company.id}});
 const who:any={id:member.userId,tenantId:member.tenantId,tenantMembershipId:member.tenantMembershipId,companyId:company.id,companyMembershipId:member.id,membershipId:member.id};
 return {entity,member,who,input:{companyId:company.id,actorUserId:who.id,templateCode:"logistics_standard",templateVersion:1,accounts:[...LOGISTICS_STANDARD_CHART]}};
}
async function waitForAuthoringWaiter(){
 const deadline=Date.now()+1500;
 while(Date.now()<deadline){const result=await pool.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%FOR UPDATE OF e%'`);if(result.rows[0].n>0)return;await new Promise(resolve=>setTimeout(resolve,20));}
 throw Error("Synthetic authoring lock waiter was not observed");
}
it("chart concurrency PostgreSQL matching installations return one durable graph and one audit/outbox fact",async()=>{
 const {entity,who,input}=await isolatedChartContext();const results:any[]=await Promise.all([repo.bootstrapChart(input,who),repo.bootstrapChart(input,who),repo.bootstrapChart(input,who)]);
 expect(results.filter(result=>!result.idempotent)).toHaveLength(1);expect(results.filter(result=>result.idempotent)).toHaveLength(2);
 expect(new Set(results.map(result=>result.installation.id)).size).toBe(1);
 expect(await mockPrisma.financeAccount.count({where:{legalEntityId:entity.id}})).toBe(LOGISTICS_STANDARD_CHART.length);
 expect(await mockPrisma.financeChartTemplateInstallation.count({where:{legalEntityId:entity.id}})).toBe(1);
 expect(await mockPrisma.financeAuditEvent.count({where:{legalEntityId:entity.id}})).toBe(1);expect(await mockPrisma.financeDomainEventOutbox.count({where:{legalEntityId:entity.id}})).toBe(1);
 const before=await snapshot();await repo.bootstrapChart(input,who);expect(await snapshot()).toEqual(before);
});
it("chart concurrency PostgreSQL account accepted first makes the waiting empty-chart check reject without bootstrap effects",async()=>{
 const {entity,who,input}=await isolatedChartContext(),real=mockPrisma.$transaction.bind(mockPrisma);let entered!:()=>void,release!:()=>void,calls=0;
 const start=new Promise<void>(resolve=>{entered=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;}),deadline=setTimeout(()=>release(),5000);
 const spy=jest.spyOn(mockPrisma,"$transaction").mockImplementation(async(fn:any,options:any)=>real(async tx=>{
  if(++calls!==1)return fn(tx);
  return fn(new Proxy(tx,{get:(target,key)=>key==="$queryRaw"?async(...args:any[])=>{
   const result=await (target.$queryRaw as any)(...args);if(Array.isArray(args[0])&&args[0].join("").includes("FOR UPDATE OF e")){entered();await gate;}return result;
  }:typeof (target as any)[key]==="function"?(target as any)[key].bind(target):(target as any)[key]}));
 },options));
 const account=repo.createAccount(intent(who),who);account.catch(()=>undefined);let bootstrap:Promise<any>|undefined;
 try{await start;bootstrap=repo.bootstrapChart(input,who);bootstrap.catch(()=>undefined);await waitForAuthoringWaiter();release();await account;await expect(bootstrap).rejects.toMatchObject({code:"FINANCE_CHART_NOT_EMPTY"});
 expect(await mockPrisma.financeAccount.count({where:{legalEntityId:entity.id}})).toBe(1);expect(await mockPrisma.financeChartTemplateInstallation.count({where:{legalEntityId:entity.id}})).toBe(0);
 expect(await mockPrisma.financeAuditEvent.count({where:{legalEntityId:entity.id}})).toBe(1);expect(await mockPrisma.financeDomainEventOutbox.count({where:{legalEntityId:entity.id}})).toBe(1);}
 finally{release();clearTimeout(deadline);await Promise.allSettled([account,...(bootstrap?[bootstrap]:[])]);spy.mockRestore();}
});
it("chart concurrency PostgreSQL membership removed during lock wait rejects before configuration effects",async()=>{
 const {entity,member,who,input}=await isolatedChartContext(),holder=await pool.connect();let pending:Promise<any>|undefined;
 try{
 await holder.query("BEGIN");await holder.query('SELECT id FROM "FinanceLegalEntity" WHERE id=$1 FOR UPDATE',[entity.id]);
 pending=repo.bootstrapChart(input,who);pending.catch(()=>undefined);await waitForAuthoringWaiter();
 await mockPrisma.companyMembership.update({where:{id:member.id},data:{status:"suspended"}});const before=await snapshot();
 await holder.query("COMMIT");await expect(pending).rejects.toMatchObject({statusCode:403});expect(await snapshot()).toEqual(before);
 }finally{await holder.query("ROLLBACK");holder.release();if(pending)await Promise.allSettled([pending]);}
});
it("chart concurrency PostgreSQL acceptance failure rolls back the complete graph, installation, audit and outbox",async()=>{
 const {who,input}=await isolatedChartContext(),before=await snapshot();
 await pool.query(`CREATE FUNCTION cp_chart_accept_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."eventType"='finance.chart_template.installed' THEN RAISE EXCEPTION 'synthetic chart acceptance failure'; END IF;RETURN NEW;END $$;CREATE TRIGGER cp_chart_accept_fail BEFORE INSERT ON "FinanceDomainEventOutbox" FOR EACH ROW EXECUTE FUNCTION cp_chart_accept_fail();`);
 try{await expect(repo.bootstrapChart(input,who)).rejects.toThrow("chart acceptance failure");expect(await snapshot()).toEqual(before);}
 finally{await pool.query('DROP TRIGGER cp_chart_accept_fail ON "FinanceDomainEventOutbox";DROP FUNCTION cp_chart_accept_fail();');}
});
