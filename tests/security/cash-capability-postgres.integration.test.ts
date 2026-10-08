jest.mock("../../src/config/s3",()=>({s3:{send:(command:any)=>mockCashStorage(command)}}));
jest.mock("../../src/utils/s3Presign",()=>({presignGetObject:()=>{throw Error("No signing in cash journey");}}));
jest.mock("../../src/config/prismaClient", () => ({ __esModule: true, default: new Proxy({}, {
        get: (_target, key) => { const value = (mockDb as any)[key]; return typeof value === "function" ? value.bind(mockDb) : value; },
    }) }));
jest.mock("../../src/config/redis", () => ({ getRedisClient: async () => null, getRedisPrefix: () => "synthetic",
    withRedisTimeout: (_name: any, work: any) => work() }));
// DOM-04 exercises normal order creation; label storage/queue transport is outside
// this setup acceptance journey, not evidence of label/provider execution.
jest.mock("../../src/modules/orders-core/label",()=>({resolveOrderLabelMode:()=>"queue",isOrderLabelAutoFallbackEnabled:()=>false,
 enqueueOrderLabelJob:jest.fn(async()=>({})),generateAndAttachParcelLabelsForOrder:jest.fn(async()=>{}),
 runOrderLabelAutoFallback:jest.fn(),scheduleOrderLabelAutoFallback:jest.fn()}));
import { Prisma, PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { generateKeyPairSync, createHash, randomUUID, sign } from "node:crypto";
import { mkdtempSync, writeFileSync, unlinkSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import bcrypt from "bcryptjs";
import { onboardTenant, canonicalOnboardingPermit, ONBOARDING_OPERATOR, ONBOARDING_PROFILE, ONBOARDING_PERMISSIONS, ONBOARDING_PROFILE_V2 } from "../../src/modules/identity-access/application/tenant-onboarding";
import { normalizeTenantOnboardingIntent } from "../../src/modules/identity-access/application/tenant-onboarding-intent";
import { SYSTEM_PERMISSIONS } from "../../src/modules/identity-access/permission-registry";
import { loginUser, revokeRefreshSession } from "../../src/modules/identity-access/application/auth.service";
const url = process.env.CARGOPILOT_WORKER_TEST_DATABASE_URL, run = process.env.CARGOPILOT_WORKER_RUN_ID;
if (!url || !run || !/^[a-f0-9]{12}$/.test(run))
    throw Error("Disposable onboarding identity required");
const target = new URL(url);
if (target.hostname !== "127.0.0.1" || target.username !== "cp_worker_it" || target.password !== "synthetic-worker-only" || target.pathname !== `/cp_worker_${run}`)
    throw Error("Refusing existing database");
const pool = new Pool({ connectionString: url, max: 2, connectionTimeoutMillis: 3000,
    idleTimeoutMillis: 1000, options: "-c statement_timeout=5000 -c lock_timeout=3000" });
let mockDb: PrismaClient;
const keys = generateKeyPairSync("ed25519"); // In-memory test-only private key.
const keyFingerprint = createHash("sha256").update(keys.publicKey.export({ type: "spki", format: "der" })).digest("hex");
const directory = mkdtempSync(join(tmpdir(), "cp-onboarding-pg-")), registryPath = join(directory, "registry.json");
const registry = { version: 1, enabled: true, revoked: false, operatorId: ONBOARDING_OPERATOR,
    profileRevision: ONBOARDING_PROFILE_V2, keyFingerprint, publicKeyPem: keys.publicKey.export({ type: "spki", format: "pem" }) };
const password = randomUUID() + "-test-only";
const credentialHash = bcrypt.hashSync(password, 12);
const credentialCommitment = createHash("sha256").update(credentialHash).digest("hex");
const intent = () => {
    const suffix = randomUUID().replace(/-/g, "").slice(0, 12);
    return {
        operationId: randomUUID(), tenant: { code: `SYN-T-${suffix}`, name: "Synthetic tenant" },
        company: { code: `SYN-C-${suffix}`, name: "Synthetic company" },
        administrator: { email: `synthetic-${suffix}@example.invalid`, name: "Synthetic administrator" },
        profileRevision: ONBOARDING_PROFILE_V2, credentialCommitment, reason: "Synthetic owner-approved onboarding"
    };
};
function request(input = intent()) {
    const normalized = normalizeTenantOnboardingIntent(input), now = Date.now();
    const permit = { version: 1, operatorId: ONBOARDING_OPERATOR, keyFingerprint,
        operationId: normalized.intent.operationId, intentFingerprint: normalized.fingerprint,
        profileRevision: ONBOARDING_PROFILE_V2, issuedAt: new Date(now).toISOString(), expiresAt: new Date(now + 240000).toISOString() };
    return { intent: input, permit, signature: sign(null, Buffer.from(canonicalOnboardingPermit(permit)), keys.privateKey).toString("base64"), initialCredentialHash: credentialHash };
}
const mockCashObjects=new Map<string,Buffer>();
const mockCashStorage=jest.fn(async(command:any)=>{const {Key,Body}=command.input;if(mockCashObjects.has(Key))throw Error("Immutable synthetic object exists");mockCashObjects.set(Key,Buffer.from(Body));return {};});
const tables = ["CashCapabilityGrantProposal","CashCapabilityGrantAction","CashCapabilityDelegationAuthority","CashCapabilityMembershipGrant","CashCapabilityActionWarehouse","Order", "OrderBillTo", "BillingPolicyVersion", "BillingPolicyDecision", "OrderPriceSnapshot", "OrderPriceApproval", "Invoice", "InvoiceIssuanceReceipt", "BillingInvoiceOutbox", "FinanceAuditEvent", "FinanceDomainEventOutbox", "FinanceJournalEntry", "FinancialDelegationAuthority", "FinancialGrantProposal", "FinancialMembershipGrant", "FinancialGrantAction", "FinanceLegalEntity", "TariffPlan", "TariffRate", "TariffConfigurationVersion", "TariffPublicationDecision", "Tenant", "Organization", "User", "TenantMembership", "CompanyMembership", "Role", "RolePermission", "MembershipRole", "MembershipScope", "TenantOnboardingReceipt", "CompanyDelegationAuthority", "CompanyInvitation", "CompanyOperationalGrant", "CompanyDelegationAction", "UserRefreshSession", "CredentialSecurityEvent"];
tables.push("IssuingEntitySetupAuthority","IssuingEntitySetupProposal","IssuingEntitySetupAction","OrderCreationIntent","OrderCreationReceipt","Parcel","Tracking","PricingComponent","OrderLabelJob","IntegrationOutbox","SupportTicket","Address","CustomerEntity");
tables.push("OrderAttachment","ProofSubmission","OrderServicePaymentInstruction","OrderServiceCashObligation","WarehouseProvisioningAction","WarehouseProvisioningAuthority","PaymentIntent","PaymentAttempt");
tables.push("RestrictedCashState","RestrictedCashTransferOffer","RestrictedCashReceipt","CashCollection","CashCollectionEvent","CashCustodyOperation","OrderCustodyAction","AnalyticsDomainEventOutbox","UserNotification");
async function counts() { const result: Record<string, number> = {}; for (const table of tables)
    result[table] = Number((await pool.query(`SELECT count(*) AS count FROM "${table}"`)).rows[0].count); return result; }
beforeAll(async () => {
    const marker = await pool.query('SELECT "runId" FROM "_CPDisposableRun"');
    if (marker.rows.length !== 1 || marker.rows[0].runId !== run)
        throw Error("Disposable marker mismatch");
    mockDb = new PrismaClient({ adapter: new PrismaPg({ connectionString: url, max: 4,
            connectionTimeoutMillis: 3000, idleTimeoutMillis: 1000,
            options: "-c statement_timeout=10000 -c lock_timeout=5000 -c idle_in_transaction_session_timeout=15000" }) });
    await mockDb.permission.createMany({ data: SYSTEM_PERMISSIONS, skipDuplicates: true });
    process.env.CARGOPILOT_ONBOARDING_REGISTRY_PATH = registryPath;
    process.env.AWS_S3_BUCKET="synthetic-cash-no-network";
    process.env.JWT_SECRET = randomUUID();
    process.env.REFRESH_TOKEN_SECRET = randomUUID();
}, 30000);
beforeEach(() => writeFileSync(registryPath, JSON.stringify(registry)));
afterAll(async () => {
    await uiApp?.close();
    await mockDb?.$disconnect();
    await pool.end();
    unlinkSync(registryPath);
    rmdirSync(directory); // Exact run-owned public-key files only.
    delete process.env.CARGOPILOT_ONBOARDING_REGISTRY_PATH;
});
import { createCompanyInvitation, acceptCompanyInvitation, mutateCompanyOperationalGrant, authorizeCompanyDelegator, cancelCompanyInvitation } from "../../src/modules/identity-access/application/company-delegation";
import { DELEGATION_REVISION, delegationFingerprint } from "../../src/modules/identity-access/application/operational-profiles";
import jwt from "jsonwebtoken";
import Fastify from "fastify";
import { fastifyAuth } from "../../src/modules/identity-access/transport/fastify-auth";
import { hasLiveAccessSession } from "../../src/modules/identity-access/application/access-session";
async function admin() { writeFileSync(registryPath, JSON.stringify(registry)); const args = request(), result = await onboardTenant(mockDb, args); const login = await loginUser({ email: args.intent.administrator.email, password }); return { ...result, actor: { ...login.user, id: login.user.userId }, login }; }
const inviteInput = (extra: any = {}) => ({ operationId: randomUUID(), email: randomUUID() + "@example.invalid", profileRevision: "operational-clerk.v1", warehouseIds: [], reason: "Synthetic approved invitation", ...extra });
async function enrolled(a: any, extra: any = {}) { const input = inviteInput(extra), invitation = await createCompanyInvitation(mockDb, a.actor, input); const pass = randomUUID() + "-synthetic"; const accepted = await acceptCompanyInvitation(mockDb, { token: invitation.token, operationId: randomUUID(), name: "Synthetic recipient", password: pass }); return { input, invitation, accepted, pass }; }
function ownerRequest(membershipId: string, warehouseIds: string[] = [], action = "operator-authorize") { writeFileSync(registryPath,JSON.stringify(registry)); const intent = { operationId: randomUUID(), membershipId, action, warehouseIds, ceilingRevision: DELEGATION_REVISION, profileRevision: ONBOARDING_PROFILE_V2, reason: "Synthetic reviewed owner authority" }; const now = Date.now(); const permit = { version: 1, operatorId: ONBOARDING_OPERATOR, keyFingerprint, operationId: intent.operationId, intentFingerprint: delegationFingerprint("operator-authority", intent), profileRevision: ONBOARDING_PROFILE_V2, issuedAt: new Date(now).toISOString(), expiresAt: new Date(now + 240000).toISOString() }; return { intent, permit, signature: sign(null, Buffer.from(canonicalOnboardingPermit(permit)), keys.privateKey).toString("base64") }; }
async function graphDigest() { const graph: Record<string, unknown> = {}; for (const table of tables)
    graph[table] = (await pool.query(`SELECT to_jsonb(record) AS row FROM "${table}" AS record ORDER BY to_jsonb(record)::text`)).rows; return createHash("sha256").update(JSON.stringify(graph)).digest("hex"); }
async function unchanged(work: () => Promise<unknown>) { const before = await graphDigest(); await expect(work()).rejects.toThrow(); expect(await graphDigest()).toBe(before); }

import {authorizeCashCapabilityDelegator,normalizeCashCapabilityAuthorityIntent,proposeCashCapabilityGrant,acceptCashCapabilityGrant,revokeCashCapabilityGrant} from "../../src/modules/identity-access/application/cash-capability-delegation";
import {acceptedCashCapability} from "../../src/modules/identity-access/application/cash-capability-eligibility";
import {requireAcceptedDriver} from "../../src/modules/identity-access/application/driver-eligibility";
import {syntheticDriverOwner} from "./driver-provisioning.fixture";
import {authorizeCompanyDriverDelegator,createCompanyDriverInvitation,acceptCompanyDriverInvitation} from "../../src/modules/identity-access/application/driver-delegation";
async function cashOwner(a:any,member:any,kind:string,warehouseIds:string[],profiles=["local-driver-cash.v1","warehouse-cash.v1","cash-settlement-checker.v1"],action="operator-authorize") {
 writeFileSync(registryPath,JSON.stringify({...registry,profileRevision:"cash-delegation.v1"}));
 const intent={operationId:randomUUID(),membershipId:member.companyMembershipId,userId:member.userId,tenantId:a.tenantId,companyId:a.companyId,tenantMembershipId:member.tenantMembershipId,legalEntityId:a.entity.id,kind,profileRevisions:profiles,warehouseIds,kinds:["service_charge"],action,profileRevision:"cash-delegation.v1",reason:"Synthetic explicit owner cash ceiling"};
 const normalized=normalizeCashCapabilityAuthorityIntent(intent),now=Date.now(),permit={version:1,operatorId:ONBOARDING_OPERATOR,keyFingerprint,operationId:intent.operationId,intentFingerprint:normalized.fingerprint,profileRevision:"cash-delegation.v1",issuedAt:new Date(now).toISOString(),expiresAt:new Date(now+240000).toISOString()};
 return authorizeCashCapabilityDelegator(mockDb,{intent,permit,signature:sign(null,Buffer.from(canonicalOnboardingPermit(permit)),keys.privateKey).toString("base64")});
}
import {authorizeWarehouseProvisioner,createControlledWarehouse} from "../../src/modules/warehouse-core/application/warehouseProvisioning";
import {authorizeIssuingEntitySetup,normalizeIssuingEntityAuthorityIntent,proposeIssuingEntity,decideIssuingEntity} from "../../src/modules/identity-access/application/issuing-entity-setup";
import {issueAcceptedOrderInvoice} from "../../src/modules/invoice-core/application/accepted-issuance";
async function signedAuthority(intent:any,fingerprint:string){
 writeFileSync(registryPath,JSON.stringify({...registry,profileRevision:intent.profileRevision}));
 const now=Date.now(),permit={version:1,operatorId:ONBOARDING_OPERATOR,keyFingerprint,operationId:intent.operationId,intentFingerprint:fingerprint,profileRevision:intent.profileRevision,issuedAt:new Date(now).toISOString(),expiresAt:new Date(now+240000).toISOString()};
 return {intent,permit,signature:sign(null,Buffer.from(canonicalOnboardingPermit(permit)),keys.privateKey).toString("base64")};
}
async function warehouseOwner(a:any){
 const intent={operationId:randomUUID(),membershipId:a.companyMembershipId,action:"operator-authorize",profileRevision:"warehouse-provisioning.v1",reason:"Synthetic explicit warehouse authority"};
 await authorizeWarehouseProvisioner(mockDb,await signedAuthority(intent,delegationFingerprint("warehouse-operator-authority",intent)));
}
async function initialEntity(a:any,checker:any){
 for(const [m,kind] of [[a,"proposer"],[checker,"checker"]] as const){
  const normalized=normalizeIssuingEntityAuthorityIntent({operationId:randomUUID(),membershipId:m.companyMembershipId,userId:m.userId,tenantId:a.tenantId,companyId:a.companyId,tenantMembershipId:m.tenantMembershipId,kind,action:"operator-authorize",expectedAcceptanceId:null,profileRevision:"issuing-entity-setup.v1",reason:"Synthetic initial entity authority"});
  await authorizeIssuingEntitySetup(mockDb,await signedAuthority(normalized.intent,normalized.fingerprint));
 }
 const p=await proposeIssuingEntity(mockDb,a.actor,{operationId:randomUUID(),configuration:{baseCurrency:"UZS",fiscalYearStartMonth:1,timezone:"Asia/Tashkent",reportingCurrency:null},reason:"Explicit synthetic entity"});
 const d=await decideIssuingEntity(mockDb,actor(checker),{operationId:randomUUID(),proposalId:p.proposalId,contentHash:p.contentHash,decision:"approved",reason:"Independent synthetic entity"});
 return mockDb.financeLegalEntity.findUniqueOrThrow({where:{id:d.legalEntityId!}});
}
async function cashGroup(){
 const a=await admin(); await warehouseOwner(a); const warehouse=await createControlledWarehouse(mockDb,a.actor,{operationId:randomUUID(),name:"Synthetic cash warehouse",location:"Synthetic"});
 const second=await createControlledWarehouse(mockDb,a.actor,{operationId:randomUUID(),name:"Synthetic other warehouse",location:"Synthetic"});
 await authorizeCompanyDelegator(mockDb,ownerRequest(a.companyMembershipId,[warehouse.id,second.id]));
 const maker=await enrolled(a),checker=await enrolled(a),staff=await enrolled(a,{profileRevision:"operational-warehouse.v1",warehouseIds:[warehouse.id]}),clerk=await enrolled(a);
 const entity=await initialEntity(a,checker.accepted);
 const driverOwner=syntheticDriverOwner();let driver:any;
 try{await authorizeCompanyDriverDelegator(mockDb,driverOwner.request(a.companyMembershipId,["local-driver.v1"]));const invitation=await createCompanyDriverInvitation(mockDb,a.actor,{operationId:randomUUID(),email:randomUUID()+"@example.invalid",profileRevision:"local-driver.v1",reason:"Synthetic driver"});driver=await acceptCompanyDriverInvitation(mockDb,{operationId:randomUUID(),token:invitation.token,name:"Synthetic cash driver",password});}finally{driverOwner.cleanup();}
 const result={...a,warehouse,second,entity,maker:maker.accepted,checker:checker.accepted,staff:staff.accepted,clerk:clerk.accepted,driver,makerPassword:maker.pass,checkerPassword:checker.pass};
 await cashOwner(result,result.maker,"proposer",[warehouse.id,second.id]);await cashOwner(result,result.checker,"checker",[warehouse.id,second.id]);return result;
}
const actor=(m:any)=>({...m,id:m.userId,membershipId:m.companyMembershipId});
const proposal=(g:any,target:any,profile="local-driver-cash.v1",extra:any={})=>({operationId:randomUUID(),membershipId:target.companyMembershipId,legalEntityId:g.entity.id,profileRevisions:[profile],warehouseIds:[g.warehouse.id],kinds:["service_charge"],expectedAcceptanceId:null,reason:"Synthetic independent cash grant",...extra});
async function accept(g:any,target:any,profile="local-driver-cash.v1") {const p=await proposeCashCapabilityGrant(mockDb,actor(g.maker),proposal(g,target,profile));const v={operationId:randomUUID(),proposalId:p.proposalId,fingerprint:p.fingerprint,reason:"Synthetic independent acceptance"};return {request:v,result:await acceptCashCapabilityGrant(mockDb,actor(g.checker),v)};}
it("independent capability acceptance preserves driver role, zero scopes and other grants; retries and conflicting intent",async()=>{
 const g=await cashGroup(),base=await mockDb.membershipRole.findMany({where:{membershipId:g.driver.companyMembershipId}}),r=await accept(g,g.driver);
 expect(await requireAcceptedDriver(mockDb,g,g.driver.companyMembershipId,"local")).toMatchObject({userId:g.driver.userId});
 expect(await mockDb.membershipRole.findMany({where:{membershipId:g.driver.companyMembershipId}})).toEqual(base);expect(await mockDb.membershipScope.count({where:{membershipId:g.driver.companyMembershipId}})).toBe(0);
 const digest=await graphDigest();expect(await acceptCashCapabilityGrant(mockDb,actor(g.checker),r.request)).toEqual(r.result);expect(await graphDigest()).toBe(digest);
 const cap=await acceptedCashCapability(mockDb,actor(g.driver),"cash.collect");expect(cap.permissions).toEqual(["cash.custody.read","cash.collect","cash.handoff"]);
 await unchanged(()=>acceptCashCapabilityGrant(mockDb,actor(g.checker),{...r.request,reason:"Changed intent"}));
});
it("checker cannot be proposer or recipient; no self-targeting or ordinary operational grant authority",async()=>{
 const g=await cashGroup(),p=await proposeCashCapabilityGrant(mockDb,actor(g.maker),proposal(g,g.driver));const v={operationId:randomUUID(),proposalId:p.proposalId,fingerprint:p.fingerprint,reason:"Synthetic acceptance"};
 await unchanged(()=>acceptCashCapabilityGrant(mockDb,actor(g.maker),v));await unchanged(()=>acceptCashCapabilityGrant(mockDb,actor(g.driver),v));await unchanged(()=>proposeCashCapabilityGrant(mockDb,actor(g.maker),proposal(g,g.maker,"cash-settlement-checker.v1")));await unchanged(()=>proposeCashCapabilityGrant(mockDb,g.actor,proposal(g,g.driver)));
});
it("foreign resources and removed/replacement ceilings deny without session, role or audit changes",async()=>{
 const g=await cashGroup(),foreign=await cashGroup();await unchanged(()=>proposeCashCapabilityGrant(mockDb,actor(g.maker),proposal(g,g.driver,"local-driver-cash.v1",{warehouseIds:[foreign.warehouse.id]})));
 const r=await accept(g,g.driver);await cashOwner(g,g.maker,"proposer",[g.second.id]);await unchanged(()=>proposeCashCapabilityGrant(mockDb,actor(g.maker),proposal(g,g.driver,"local-driver-cash.v1",{warehouseIds:[g.second.id],expectedAcceptanceId:r.result.acceptanceId})));
 await unchanged(()=>proposeCashCapabilityGrant(mockDb,actor(g.maker),proposal(g,foreign.driver)));
});
it("concurrent matching acceptance produces one grant/action and fresh revoked capabilities cannot use receipts",async()=>{
 const g=await cashGroup(),p=await proposeCashCapabilityGrant(mockDb,actor(g.maker),proposal(g,g.driver)),v={operationId:randomUUID(),proposalId:p.proposalId,fingerprint:p.fingerprint,reason:"Synthetic independent decision"};
 const results=await Promise.all([acceptCashCapabilityGrant(mockDb,actor(g.checker),v),acceptCashCapabilityGrant(mockDb,actor(g.checker),v)]);expect(results[0]).toEqual(results[1]);
 await revokeCashCapabilityGrant(mockDb,actor(g.maker),{operationId:randomUUID(),membershipId:g.driver.companyMembershipId,legalEntityId:g.entity.id,expectedAcceptanceId:v.operationId,reason:"Synthetic immediate revoke"});
 await unchanged(()=>acceptCashCapabilityGrant(mockDb,actor(g.checker),v));await expect(acceptedCashCapability(mockDb,actor(g.driver),"cash.handoff")).rejects.toThrow();
 expect(await requireAcceptedDriver(mockDb,g,g.driver.companyMembershipId,"local")).toMatchObject({userId:g.driver.userId});
});
it("injected protected audit failure rolls back grant, authorization version and sessions",async()=>{
 const g=await cashGroup(),p=await proposeCashCapabilityGrant(mockDb,actor(g.maker),proposal(g,g.staff,"warehouse-cash.v1")),v={operationId:randomUUID(),proposalId:p.proposalId,fingerprint:p.fingerprint,reason:"Synthetic decision"};
 await pool.query(`CREATE FUNCTION cp_cash_test_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='accept' THEN RAISE EXCEPTION 'synthetic cash audit failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER cp_cash_test_fail BEFORE INSERT ON "CashCapabilityGrantAction" FOR EACH ROW EXECUTE FUNCTION cp_cash_test_fail();`);
 try{const before=await graphDigest();await expect(acceptCashCapabilityGrant(mockDb,actor(g.checker),v)).rejects.toThrow("synthetic cash audit failure");expect(await graphDigest()).toBe(before);}finally{await pool.query('DROP TRIGGER cp_cash_test_fail ON "CashCapabilityGrantAction"; DROP FUNCTION cp_cash_test_fail()');}
});
import {authorizeFinancialDelegator,normalizeFinancialAuthorityIntent,proposeFinancialGrant,acceptFinancialGrant} from "../../src/modules/identity-access/application/financial-delegation";
import {FINANCIAL_PROFILES} from "../../src/modules/identity-access/application/financial-profiles";
import {createTariffPlan} from "../../src/modules/pricing-core/repo/pricing.repo";
import {proposeTariffVersion,decideTariffVersion} from "../../src/modules/pricing-core/repo/tariff-versions";
import {proposeBillingPolicy,decideBillingPolicy} from "../../src/modules/pricing-core/repo/billing-policy";
import {syntheticBillingPolicy} from "./billing-policy.fixture";
import {createCustomerEntity} from "../../src/modules/customers-core/application/customerEntityRepo";
import {createAddress} from "../../src/modules/addresses-core/application/addressRepo";
import {createOrderForActor} from "../../src/modules/orders-core/write/create-order";
import {bindOrderBillTo,bindServicePaymentInstruction,acceptOrderPrice,approveOrderPrice} from "../../src/modules/pricing-core/repo/order-price";
import {assignDriversBulk,updateDriverOrderStatus} from "../../src/modules/orders-core/operations/order-status";
import {executeWarehouseCustody,readWarehouseCustody} from "../../src/modules/orders-core/operations/warehouse-custody";
import {executeRestrictedCash,readRestrictedCash} from "../../src/modules/orders-core/cash/restricted-cash.service";
async function financeAuthority(g:any,m:any,kind:string){
 writeFileSync(registryPath,JSON.stringify({...registry,profileRevision:"financial-delegation.v1"}));
 const {intent,fingerprint}=normalizeFinancialAuthorityIntent({operationId:randomUUID(),membershipId:m.companyMembershipId,legalEntityId:g.entity.id,kind,profileRevisions:Object.keys(FINANCIAL_PROFILES).sort(),action:"operator-authorize",profileRevision:"financial-delegation.v1",reason:"Synthetic pricing prerequisite authority"}),now=Date.now();
 const permit={version:1,operatorId:ONBOARDING_OPERATOR,keyFingerprint,operationId:intent.operationId,intentFingerprint:fingerprint,profileRevision:"financial-delegation.v1",issuedAt:new Date(now).toISOString(),expiresAt:new Date(now+240000).toISOString()};
 await authorizeFinancialDelegator(mockDb,{intent,permit,signature:sign(null,Buffer.from(canonicalOnboardingPermit(permit)),keys.privateKey).toString("base64")});
}
async function pricedJourney(party="SENDER",basePrice=100,options:{tariffPrice?:number}={}){
 const g=await cashGroup();await accept(g,g.driver);await accept(g,g.staff,"warehouse-cash.v1");await accept(g,g.clerk,"cash-settlement-checker.v1");
 await financeAuthority(g,g,"proposer");await financeAuthority(g,g.checker,"checker");
 const pricingMaker=await enrolled(g),pricingChecker=await enrolled(g);
 for(const m of [pricingMaker.accepted,pricingChecker.accepted]){const p=await proposeFinancialGrant(mockDb,g.actor,{operationId:randomUUID(),membershipId:m.companyMembershipId,legalEntityId:g.entity.id,profileRevisions:Object.keys(FINANCIAL_PROFILES),expectedAcceptanceId:null,reason:"Synthetic prerequisite pricing profiles"});await acceptFinancialGrant(mockDb,actor(g.checker),{operationId:randomUUID(),proposalId:p.proposalId,fingerprint:p.fingerprint,reason:"Independent synthetic prerequisite"});}
 const maker=actor(pricingMaker.accepted),check=actor(pricingChecker.accepted);
 const plan=await createTariffPlan(maker,{name:"Synthetic cash tariff",code:"SYN-"+randomUUID().slice(0,8),description:null,status:"active",serviceType:"DOOR_TO_DOOR",priceType:"bucket",pricingStrategy:"FIXED_LANE",coverageType:"domestic",transportMode:"ROAD",originCountryCode:null,destinationCountryCode:null,routeTemplateId:null,currency:"UZS",priority:1,isDefault:true,customerEntityId:null,rates:[{zone:1,weightFromKg:0.01,weightToKg:100,price:options.tariffPrice??(basePrice===0?100:basePrice)}],transitLegRates:[]} as any);
 const draft=await mockDb.tariffPlan.findUniqueOrThrow({where:{id:plan!.id}}),version=await proposeTariffVersion({user:maker,planId:plan!.id,expectedGeneration:draft.contentGeneration,operationId:randomUUID(),reason:"Synthetic tariff"});
 await decideTariffVersion({user:check,planId:plan!.id,versionId:version.id,contentSha256:version.contentSha256,operationId:randomUUID(),decision:"approved",reason:"Independent tariff"});
 const policy=await proposeBillingPolicy(maker,{operationId:randomUUID(),reason:"Explicit synthetic zero-fee zero-tax policy",content:syntheticBillingPolicy({billing:{mode:"manual",eligibleOrderStates:["pending","assigned","delivered"],dueDays:7,numberPrefix:"SYNTHETIC"},fees:[],discounts:basePrice===0?[{code:"synthetic_free",type:"percent",value:"100"}]:[],tax:{treatment:"exclusive_percent",rate:"0",authorityReference:"SYNTHETIC ZERO TAX TEST ONLY"}})});
 await decideBillingPolicy(check,{versionId:policy.id,contentHash:policy.contentHash,operationId:randomUUID(),decision:"approved",reason:"Independent synthetic policy"});
 const customer=await createCustomerEntity(maker,{type:"PERSON",name:"Synthetic cash payer"}),addresses=await Promise.all(["Synthetic A","Synthetic B"].map(city=>createAddress(maker,{customerEntityId:customer.id,country:"ZZ",city,street:"Synthetic"})));
 const body={operationId:randomUUID(),customerEntityId:customer.id,sender:{name:"Synthetic sender"},receiver:{name:"Synthetic recipient"},addresses:{pickupAddress:"Synthetic A",dropoffAddress:"Synthetic B",senderAddressId:addresses[0].id,receiverAddressId:addresses[1].id},shipment:{serviceType:"DOOR_TO_DOOR",currency:"UZS",weightKg:2},payment:{paymentType:"CASH",deliveryChargePaidBy:"SENDER"}};
 const made=await createOrderForActor({user:maker,body}),orderId=made.payload.order.id;
 const billTo=await bindOrderBillTo(maker,{orderId,operationId:randomUUID(),payerCustomerEntityId:customer.id,evidence:"Synthetic accepted payer",reason:"Synthetic payer"});
 const instructionIntent={orderId,operationId:randomUUID(),billToId:billTo.id,method:"CASH",collectionParty:party,evidence:"Synthetic explicit cash instruction",reason:"Synthetic cash payer instruction"};
 const instruction=await bindServicePaymentInstruction(maker,instructionIntent);
 const priceIntent={orderId,operationId:randomUUID(),reason:"Synthetic exact price"};
 const price=await acceptOrderPrice(maker,priceIntent);expect(price.total).toBe(new Prisma.Decimal(basePrice).toFixed(4));
 if(price.state==="approval_required")await approveOrderPrice(check,{orderId,operationId:randomUUID(),snapshotId:price.id,contentHash:price.contentHash,reason:"Independent synthetic zero-price approval"});
 const dispatcher=await enrolled(g,{profileRevision:"operational-dispatcher.v1"});
 const o=await mockDb.order.findUniqueOrThrow({where:{id:orderId}});await assignDriversBulk({actor:actor(dispatcher.accepted),orderIds:[orderId],driverId:g.driver.userId,type:"pickup",expectedStates:[{orderId,updatedAt:o.updatedAt.toISOString(),status:o.status,assignedDriverId:o.assignedDriverId,currentWarehouseId:o.currentWarehouseId}]});
 expect(await mockDb.membershipScope.count({where:{membershipId:g.driver.companyMembershipId}})).toBe(0);
 return {...g,orderId,maker,pricingChecker:check,dispatcher:dispatcher.accepted,body,billTo,instruction,instructionIntent,price,priceIntent};
}
const cashIntent=(g:any,extra:any={})=>({orderId:g.orderId,operationId:randomUUID(),kind:"service_charge",...(!extra.expectedEventId?{obligationId:g.price.id}:{}),...extra});
async function physical(g:any,who:any,action:string,extra:any={}){const s=await readWarehouseCustody(actor(who),g.orderId);return executeWarehouseCustody(actor(who),g.orderId,{operationId:randomUUID(),action,expectedEventId:s.custody?.id??null,expectedUpdatedAt:s.updatedAt,parcelIds:s.parcelIds,...extra});}
async function warehouseOffer(g:any){await updateDriverOrderStatus({actor:actor(g.driver),orderId:g.orderId,status:"pickup_in_progress"});await updateDriverOrderStatus({actor:actor(g.driver),orderId:g.orderId,status:"picked_up"});const s=await readWarehouseCustody(actor(g.driver),g.orderId);await physical(g,g.driver,"pickup-offer",{pickupTrackingId:s.pickupTrackingId,destinationWarehouseId:g.warehouse.id});}
it("restricted collection, retained holder after parcel intake, explicit transfer and independent warehouse settlement; matching retries",async()=>{
 const g=await pricedJourney(),intent=cashIntent(g),rows=await Promise.all([executeRestrictedCash(actor(g.driver),"collect",intent),executeRestrictedCash(actor(g.driver),"collect",intent)]);expect(rows[0]).toEqual(rows[1]);expect(rows[0]).toMatchObject({amount:"100",state:"held",holderMembershipId:g.driver.companyMembershipId});
 await unchanged(()=>executeRestrictedCash(actor(g.driver),"collect",{...intent,note:"Changed"}));await unchanged(()=>executeRestrictedCash(actor(g.driver),"settle",cashIntent(g,{expectedEventId:rows[0].expectedEventId})));
 await warehouseOffer(g);await physical(g,g.staff,"intake",{warehouseId:g.warehouse.id});expect((await mockDb.order.findUniqueOrThrow({where:{id:g.orderId}})).assignedDriverId).toBeNull();
 const offerIntent=cashIntent(g,{expectedEventId:rows[0].expectedEventId,recipientMembershipId:g.staff.companyMembershipId,recipientWarehouseId:g.warehouse.id}),offer=await executeRestrictedCash(actor(g.driver),"offer",offerIntent);
 expect((await mockDb.cashCollection.findUniqueOrThrow({where:{orderId_kind:{orderId:g.orderId,kind:"service_charge"}}})).currentHolderUserId).toBe(g.driver.userId);
 const acceptIntent=cashIntent(g,{offerId:offer.offerId,expectedEventId:offer.expectedEventId}),accepted=await executeRestrictedCash(actor(g.staff),"accept",acceptIntent);
 expect(accepted).toMatchObject({holderMembershipId:g.staff.companyMembershipId,holderWarehouseId:g.warehouse.id});expect(await executeRestrictedCash(actor(g.staff),"accept",acceptIntent)).toEqual(accepted);
 const settle=cashIntent(g,{expectedEventId:accepted.expectedEventId}),settled=await executeRestrictedCash(actor(g.clerk),"settle",settle);expect(settled).toMatchObject({state:"settled",amount:"100",holderMembershipId:null});expect(await executeRestrictedCash(actor(g.clerk),"settle",settle)).toEqual(settled);
 const collection=await mockDb.cashCollection.findUniqueOrThrow({where:{orderId_kind:{orderId:g.orderId,kind:"service_charge"}},include:{events:true}});expect(collection).toMatchObject({status:"settled",currentHolderType:"finance",currentHolderUserId:null,currentHolderWarehouseId:null,collectedAmount:100});expect(collection.events).toHaveLength(4);
 expect(await mockDb.cashCustodyOperation.count({where:{orderId:g.orderId}})).toBe(3);expect(await mockDb.financeSourceEvent.count()).toBe(0);
 // Complete normal delivery/proof/invoice after explicit service money settlement.
 await physical(g,g.staff,"last-mile-offer",{warehouseId:g.warehouse.id,driverMembershipId:g.driver.companyMembershipId});await physical(g,g.driver,"last-mile-accept");
 const proof=await deliveryProof(g);await physical(g,g.driver,"deliver",{proofSubmissionId:proof.intent.body.submissionId});
 const invoiceIntent={orderId:g.orderId,operationId:randomUUID(),priceApprovalId:g.price.id,reason:"Synthetic same-currency manual invoice"};
 const invoice=await issueAcceptedOrderInvoice(g.maker,invoiceIntent);expect(invoice.amount.toFixed(4)).toBe("100.0000");expect(invoice.status).toBe("issued");expect(await issueAcceptedOrderInvoice(g.maker,invoiceIntent)).toEqual(invoice);
 expect((await createOrderForActor({user:g.maker,body:g.body})).payload.order.id).toBe(g.orderId);
 expect(await bindServicePaymentInstruction(g.maker,g.instructionIntent)).toEqual(g.instruction);expect((await acceptOrderPrice(g.maker,g.priceIntent)).id).toBe(g.price.id);
 const obligation=(await pool.query('SELECT * FROM "OrderServiceCashObligation" WHERE "orderId"=$1',[g.orderId])).rows;expect(obligation).toHaveLength(1);expect(obligation[0]).toMatchObject({priceApprovalId:g.price.id,amount:"100.0000",currency:"UZS",instructionId:g.instruction.id});
 expect((await mockDb.invoice.findUniqueOrThrow({where:{orderId:g.orderId}})).billingPriceApprovalId).toBe(g.price.id);expect(await mockDb.financeSourceEvent.count()).toBe(0);

});
it("warehouse-to-accepted-last-mile local driver requires offer and acceptance; no automatic parcel cash transfer",async()=>{
 const g=await pricedJourney(),collected=await executeRestrictedCash(actor(g.driver),"collect",cashIntent(g));await warehouseOffer(g);await physical(g,g.staff,"intake",{warehouseId:g.warehouse.id});
 const offered=await executeRestrictedCash(actor(g.driver),"offer",cashIntent(g,{expectedEventId:collected.expectedEventId,recipientMembershipId:g.staff.companyMembershipId,recipientWarehouseId:g.warehouse.id}));
 const received=await executeRestrictedCash(actor(g.staff),"accept",cashIntent(g,{offerId:offered.offerId,expectedEventId:offered.expectedEventId}));
 await unchanged(()=>executeRestrictedCash(actor(g.staff),"offer",cashIntent(g,{expectedEventId:received.expectedEventId,recipientMembershipId:g.driver.companyMembershipId,recipientWarehouseId:null})));
 await physical(g,g.staff,"last-mile-offer",{warehouseId:g.warehouse.id,driverMembershipId:g.driver.companyMembershipId});await physical(g,g.driver,"last-mile-accept");
 const toDriver=await executeRestrictedCash(actor(g.staff),"offer",cashIntent(g,{expectedEventId:received.expectedEventId,recipientMembershipId:g.driver.companyMembershipId,recipientWarehouseId:null}));
 const collection=await mockDb.cashCollection.findUniqueOrThrow({where:{orderId_kind:{orderId:g.orderId,kind:"service_charge"}}});expect(collection.currentHolderWarehouseId).toBe(g.warehouse.id);
 const moved=await executeRestrictedCash(actor(g.driver),"accept",cashIntent(g,{offerId:toDriver.offerId,expectedEventId:toDriver.expectedEventId}));expect(moved.holderMembershipId).toBe(g.driver.companyMembershipId);expect(moved.holderWarehouseId).toBeNull();
});
it("wrong recipient, foreign context, unsupported COD and supplied monetary authority reject with unchanged graph",async()=>{
 const g=await pricedJourney(),foreign=await cashGroup(),collected=await executeRestrictedCash(actor(g.driver),"collect",cashIntent(g));
 await unchanged(()=>readRestrictedCash(actor(foreign.driver),{orderId:g.orderId}));
 await unchanged(()=>executeRestrictedCash(actor(g.driver),"offer",cashIntent(g,{expectedEventId:collected.expectedEventId,recipientMembershipId:foreign.staff.companyMembershipId,recipientWarehouseId:foreign.warehouse.id})));
 await unchanged(()=>executeRestrictedCash(actor(g.driver),"collect",cashIntent(g,{kind:"cod"})));await unchanged(()=>executeRestrictedCash(actor(g.driver),"collect",cashIntent(g,{amount:100})));
 await unchanged(()=>executeRestrictedCash(actor(g.staff),"accept",cashIntent(g,{offerId:randomUUID(),expectedEventId:collected.expectedEventId})));
});
it("competing custody mutations admit one result; stale events and injected receipt failure leave no partial state",async()=>{
 const g=await pricedJourney(),intents=[cashIntent(g),cashIntent(g)],r=await Promise.allSettled(intents.map(v=>executeRestrictedCash(actor(g.driver),"collect",v)));expect(r.filter(x=>x.status==="fulfilled")).toHaveLength(1);expect(await mockDb.cashCollectionEvent.count({where:{cashCollection:{orderId:g.orderId}}})).toBe(2);
 const collected=(r.find(x=>x.status==="fulfilled") as PromiseFulfilledResult<any>).value;await warehouseOffer(g);
 await unchanged(()=>executeRestrictedCash(actor(g.driver),"offer",cashIntent(g,{expectedEventId:randomUUID(),recipientMembershipId:g.staff.companyMembershipId,recipientWarehouseId:g.warehouse.id})));
 const offered=await executeRestrictedCash(actor(g.driver),"offer",cashIntent(g,{expectedEventId:collected.expectedEventId,recipientMembershipId:g.staff.companyMembershipId,recipientWarehouseId:g.warehouse.id}));
 await pool.query(`CREATE FUNCTION cp_cash_receipt_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='accept' THEN RAISE EXCEPTION 'synthetic receipt rollback'; END IF; RETURN NEW; END $$; CREATE TRIGGER cp_cash_receipt_fail BEFORE INSERT ON "RestrictedCashReceipt" FOR EACH ROW EXECUTE FUNCTION cp_cash_receipt_fail();`);
 const intent=cashIntent(g,{offerId:offered.offerId,expectedEventId:offered.expectedEventId});try{await unchanged(()=>executeRestrictedCash(actor(g.staff),"accept",intent));}finally{await pool.query('DROP TRIGGER cp_cash_receipt_fail ON "RestrictedCashReceipt"; DROP FUNCTION cp_cash_receipt_fail()');}
 const results=await Promise.all([executeRestrictedCash(actor(g.staff),"accept",intent),executeRestrictedCash(actor(g.staff),"accept",intent)]);expect(results[0]).toEqual(results[1]);
});
it("revoked capability blocks confirmed retry and pending transfer, preserves base driver identity and HTTP session revocation",async()=>{
 const g=await pricedJourney(),login=await loginUser({email:(await mockDb.user.findUniqueOrThrow({where:{id:g.driver.userId}})).email,password}),intent=cashIntent(g),collected=await executeRestrictedCash(actor(g.driver),"collect",intent);
 await warehouseOffer(g);const offered=await executeRestrictedCash(actor(g.driver),"offer",cashIntent(g,{expectedEventId:collected.expectedEventId,recipientMembershipId:g.staff.companyMembershipId,recipientWarehouseId:g.warehouse.id}));
 const targetGrant=(await pool.query('SELECT * FROM "CashCapabilityMembershipGrant" WHERE "membershipId"=$1',[g.staff.companyMembershipId])).rows[0];
 await revokeCashCapabilityGrant(mockDb,actor(g.checker),{operationId:randomUUID(),membershipId:g.staff.companyMembershipId,legalEntityId:g.entity.id,expectedAcceptanceId:targetGrant.acceptedOperationId,reason:"Synthetic recipient revocation before acceptance"});
 await unchanged(()=>executeRestrictedCash(actor(g.staff),"accept",cashIntent(g,{offerId:offered.offerId,expectedEventId:offered.expectedEventId})));
 const grant=(await pool.query('SELECT * FROM "CashCapabilityMembershipGrant" WHERE "membershipId"=$1',[g.driver.companyMembershipId])).rows[0];
 await revokeCashCapabilityGrant(mockDb,actor(g.checker),{operationId:randomUUID(),membershipId:g.driver.companyMembershipId,legalEntityId:g.entity.id,expectedAcceptanceId:grant.acceptedOperationId,reason:"Synthetic revoke during held cash"});
 await unchanged(()=>executeRestrictedCash(actor(g.driver),"collect",intent));await unchanged(()=>readRestrictedCash(actor(g.driver),{}));expect(await requireAcceptedDriver(mockDb,g,g.driver.companyMembershipId,"local")).toMatchObject({userId:g.driver.userId});
 const app=Fastify();app.get('/protected',{preHandler:fastifyAuth()},()=>({ok:true}));try{expect((await app.inject({method:'GET',url:'/protected',headers:{authorization:'Bearer '+login.token}})).statusCode).toBe(401);}finally{await app.close();}
 expect((await mockDb.cashCollection.findUniqueOrThrow({where:{orderId_kind:{orderId:g.orderId,kind:"service_charge"}}})).currentHolderUserId).toBe(g.driver.userId);
});
it("bounded preflight uses exact selected capability, scopes and safe decimal projections without writes",async()=>{
 const g=await pricedJourney(),before=await graphDigest(),page=await readRestrictedCash(actor(g.driver),{limit:1});expect(page.items.map(x=>x.orderId)).toContain(g.orderId);expect(page.items[0].acceptedServicePrice).toBe("100.0000");expect(JSON.stringify(page)).not.toMatch(/password|token|email|credential/i);expect(await graphDigest()).toBe(before);
 await unchanged(()=>readRestrictedCash(actor(g.driver),{limit:51}));await unchanged(()=>readRestrictedCash(actor(g.staff),{orderId:g.orderId}));await unchanged(()=>readRestrictedCash({...actor(g.driver),companyMembershipId:g.staff.companyMembershipId},{}));
});

import {fork,type ChildProcess} from "node:child_process";
import path from "node:path";
const WebSocket=require("ws");
type Peer = {
    child: ChildProcess;
    port: number;
    emit: (notificationId: string) => Promise<void>;
    close: () => Promise<void>;
};
async function startSocketPeer(): Promise<Peer> {
    const env: NodeJS.ProcessEnv = { NODE_ENV: "test", JWT_SECRET: process.env.JWT_SECRET, CARGOPILOT_WORKER_TEST_DATABASE_URL: url, CARGOPILOT_WORKER_RUN_ID: run };
    for (const key of ["PATH", "SystemRoot", "TEMP", "TMP", "USERPROFILE", "APPDATA", "LOCALAPPDATA"])
        if (process.env[key])
            env[key] = process.env[key];
    const child = fork(path.join(__dirname, "socket-session-process.ts"), [], { execArgv: ["-r", "ts-node/register/transpile-only"], env, stdio: ["ignore", "pipe", "pipe", "ipc"] });
    // Bounded diagnostic capture without printing credentials/query arguments.
    let diagnosticBytes = 0;
    for (const stream of [child.stdout, child.stderr])
        stream?.on("data", buffer => { diagnosticBytes += buffer.length; if (diagnosticBytes > 65536)
            child.kill(); });
    const waitMessage = (predicate: (m: any) => boolean, ms: number) => new Promise<any>((resolve, reject) => {
        const timer = setTimeout(() => { cleanup(); reject(Error("Socket process deadline")); }, ms);
        const onMessage = (m: any) => { if (m?.kind === 'startup-failed' || m?.kind === 'failed') {
            cleanup();
            reject(Error("Socket process failed"));
        }
        else if (predicate(m)) {
            cleanup();
            resolve(m);
        } };
        const onExit = () => { cleanup(); reject(Error("Socket process exited")); };
        const cleanup = () => { clearTimeout(timer); child.off("message", onMessage); child.off("exit", onExit); };
        child.on("message", onMessage);
        child.on("exit", onExit);
    });
    const close = async () => { if (child.exitCode !== null)
        return; const ended = new Promise<void>(resolve => child.once("exit", () => resolve())); child.send({ kind: "shutdown" }); const timer = setTimeout(() => child.kill(), 5000); try {
        await ended;
    }
    finally {
        clearTimeout(timer);
    } };
    try {
        const ready = await waitMessage(m => m.kind === 'ready', 15000);
        return { child, port: ready.port, close, emit: async (notificationId: string) => { const request = randomUUID(), done = waitMessage(m => m.kind === 'done' && m.request === request, 10000); child.send({ kind: "emit-notification", request, notificationId }); await done; } };
    }
    catch (error) {
        await close();
        throw error;
    }
}
type Wire = {
    ws: any;
    events: any[];
    closed: Promise<void>;
};
async function connectWire(peer: Peer, token: string): Promise<Wire> {
    const ws = new WebSocket(`ws://127.0.0.1:${peer.port}/socket.io/?EIO=4&transport=websocket`), events: any[] = [];
    const closed = new Promise<void>(resolve => ws.once("close", () => resolve()));
    await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { ws.terminate(); reject(Error("Socket connection deadline")); }, 7000);
        ws.on("error", () => { clearTimeout(timer); reject(Error("Socket transport failure")); });
        ws.on("message", (buffer: any) => { const packet = buffer.toString(); if (packet.startsWith('0'))
            ws.send('40' + JSON.stringify({ token }));
        else if (packet === '2')
            ws.send('3');
        else if (packet.startsWith('42')) {
            const event = JSON.parse(packet.slice(2));
            events.push(event);
            if (event[0] === 'driver:realtime:ready') {
                clearTimeout(timer);
                resolve();
            }
        }
        else if (packet.startsWith('44')) {
            clearTimeout(timer);
            ws.terminate();
            reject(Error("Unauthorized socket"));
        } });
    });
    return { ws, events, closed };
}
async function awaitClosed(wire: Wire, ms = 7500) { let timer: NodeJS.Timeout | undefined; try {
    await Promise.race([wire.closed, new Promise((_, reject) => { timer = setTimeout(() => reject(Error("Revoked socket did not close")), ms); })]);
}
finally {
    if (timer)
        clearTimeout(timer);
} }
async function withSocketPeers(work: (peers: Peer[], wires: Wire[]) => Promise<void>) { const peers: Peer[] = [], wires: Wire[] = []; try {
    peers.push(await startSocketPeer());
    peers.push(await startSocketPeer());
    await work(peers, wires);
}
finally {
    for (const wire of wires)
        wire.ws.terminate();
    await Promise.all(peers.map(peer => peer.close()));
} }

it("cash-capability revocation disconnects established sockets in two actual processes; driver base remains",async()=>{
 const g=await pricedJourney(),login=await loginUser({email:(await mockDb.user.findUniqueOrThrow({where:{id:g.driver.userId}})).email,password});
 await withSocketPeers(async(peers,wires)=>{for(const peer of peers)wires.push(await connectWire(peer,login.token));
  const grant=(await pool.query('SELECT * FROM "CashCapabilityMembershipGrant" WHERE "membershipId"=$1',[g.driver.companyMembershipId])).rows[0];
  await revokeCashCapabilityGrant(mockDb,actor(g.checker),{operationId:randomUUID(),membershipId:g.driver.companyMembershipId,legalEntityId:g.entity.id,expectedAcceptanceId:grant.acceptedOperationId,reason:"Synthetic two-process revoke"});
  await Promise.all(wires.map(w=>awaitClosed(w)));
 });
 expect(await mockDb.companyDriverEligibility.findUnique({where:{membershipId:g.driver.companyMembershipId}})).toMatchObject({enabled:true});
});
it("capability replacement/revocation preserves another company membership and its live HTTP session",async()=>{
 const g=await cashGroup(),first=await accept(g,g.driver),email=(await mockDb.user.findUniqueOrThrow({where:{id:g.driver.userId}})).email;
 const sourceLogin=await loginUser({email,password}),other=await admin();await authorizeCompanyDelegator(mockDb,ownerRequest(other.companyMembershipId));
 const invitation=await createCompanyInvitation(mockDb,other.actor,{...inviteInput(),email});const joined=await acceptCompanyInvitation(mockDb,{operationId:randomUUID(),token:invitation.token},sourceLogin.token);
 const foreignLogin=await loginUser({email,password,companyMembershipId:joined.companyMembershipId}),foreignMembership=await mockDb.companyMembership.findUniqueOrThrow({where:{id:joined.companyMembershipId}}),foreignRoles=await mockDb.membershipRole.findMany({where:{membershipId:joined.companyMembershipId}});
 const p=await proposeCashCapabilityGrant(mockDb,actor(g.maker),proposal(g,g.driver,"local-driver-cash.v1",{warehouseIds:[g.warehouse.id,g.second.id],expectedAcceptanceId:first.result.acceptanceId}));const decision={operationId:randomUUID(),proposalId:p.proposalId,fingerprint:p.fingerprint,reason:"Synthetic replacement"};
 const r=await Promise.all([acceptCashCapabilityGrant(mockDb,actor(g.checker),decision),acceptCashCapabilityGrant(mockDb,actor(g.checker),decision)]);expect(r[0]).toEqual(r[1]);
 await revokeCashCapabilityGrant(mockDb,actor(g.maker),{operationId:randomUUID(),membershipId:g.driver.companyMembershipId,legalEntityId:g.entity.id,expectedAcceptanceId:decision.operationId,reason:"Synthetic selected-company removal"});
 expect(await mockDb.companyMembership.findUniqueOrThrow({where:{id:joined.companyMembershipId}})).toEqual(foreignMembership);expect(await mockDb.membershipRole.findMany({where:{membershipId:joined.companyMembershipId}})).toEqual(foreignRoles);
 const app=Fastify();app.get('/protected',{preHandler:fastifyAuth()},()=>({ok:true}));try{expect((await app.inject({method:'GET',url:'/protected',headers:{authorization:'Bearer '+foreignLogin.token}})).statusCode).toBe(200);}finally{await app.close();}
});
it("admitted cash work fences competing revoke; committed revoke rejects subsequent admission without partial effects",async()=>{
 const g=await pricedJourney(),base=mockDb,grant=(await pool.query('SELECT * FROM "CashCapabilityMembershipGrant" WHERE "membershipId"=$1',[g.driver.companyMembershipId])).rows[0];
 let release!:()=>void,signal!:()=>void;const gate=new Promise<void>(r=>{release=r}),locked=new Promise<void>(r=>{signal=r});let pid=0;
 mockDb=new Proxy(base,{get(target,key){if(key==='$transaction')return (work:any,options:any)=>base.$transaction(async tx=>{
  pid=Number((await tx.$queryRaw<any[]>`SELECT pg_backend_pid() AS pid`)[0].pid);
  const wrapped=new Proxy(tx,{get(value,name){if(name==='$queryRaw')return async(...args:any[])=>{const result=await (value.$queryRaw as any)(...args),text=Array.isArray(args[0])?args[0].join('?'):'';if(text.includes('FROM "Order"')&&text.includes('FOR UPDATE')){signal();await gate;}return result;};const v=(value as any)[name];return typeof v==='function'?v.bind(value):v;}});return work(wrapped);
 },options);const v=(target as any)[key];return typeof v==='function'?v.bind(target):v;}});
 const intent=cashIntent(g),business=executeRestrictedCash(actor(g.driver),'collect',intent);let revoke:Promise<any>|undefined;
 try{await locked;revoke=revokeCashCapabilityGrant(base,actor(g.checker),{operationId:randomUUID(),membershipId:g.driver.companyMembershipId,legalEntityId:g.entity.id,expectedAcceptanceId:grant.acceptedOperationId,reason:'Synthetic competing revoke'});
  let blocked=false;for(let i=0;i<30;i++){blocked=(await pool.query('SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1::int=ANY(pg_blocking_pids(pid))) AS blocked',[pid])).rows[0].blocked;if(blocked)break;await new Promise(r=>setTimeout(r,30));}expect(blocked).toBe(true);release();expect(await business).toMatchObject({state:'held',amount:'100'});await revoke;
 }finally{release();await Promise.allSettled([business,...(revoke?[revoke]:[])]);mockDb=base;}
 expect(await mockDb.cashCollectionEvent.count({where:{cashCollection:{orderId:g.orderId}}})).toBe(2);await unchanged(()=>executeRestrictedCash(actor(g.driver),'collect',intent));
});
it("protected cash basis/receipts reject tampering and accepted retry retains original result",async()=>{
 const g=await pricedJourney(),intent=cashIntent(g),collected=await executeRestrictedCash(actor(g.driver),'collect',intent);
 for(const sql of ['UPDATE "RestrictedCashState" SET amount=amount+1','UPDATE "RestrictedCashReceipt" SET result=\'{}\'','DELETE FROM "RestrictedCashReceipt"','TRUNCATE "RestrictedCashReceipt"']){const before=await graphDigest();await expect(pool.query(sql)).rejects.toThrow();expect(await graphDigest()).toBe(before);}
 expect(await executeRestrictedCash(actor(g.driver),'collect',intent)).toEqual(collected);
});
import cashRoutes from "../../src/modules/orders-core/transport/routes/cash.routes";
it("actual restricted cash HTTP contracts need selected sessions and accepted capability, without broad shipment keys",async()=>{
 const g=await pricedJourney(),driverLogin=await loginUser({email:(await mockDb.user.findUniqueOrThrow({where:{id:g.driver.userId}})).email,password}),adminLogin=await loginUser({email:(await mockDb.user.findUniqueOrThrow({where:{id:g.userId}})).email,password});
 for(const key of ['shipment.view','shipment.update','shipment.assignCourier','cash.collect'])expect(driverLogin.user.permissionCodes).not.toContain(key);
 const app=Fastify();await app.register(cashRoutes,{prefix:'/api/orders'});const path='/api/orders/'+g.orderId+'/cash/collect',payload={operationId:randomUUID(),kind:'service_charge',obligationId:g.price.id};
 try{const before=await graphDigest();expect((await app.inject({method:'POST',url:path,payload})).statusCode).toBe(401);expect((await app.inject({method:'POST',url:path,payload,headers:{authorization:'Bearer '+adminLogin.token}})).statusCode).toBe(403);expect(await graphDigest()).toBe(before);
  const response=await app.inject({method:'POST',url:path,payload,headers:{authorization:'Bearer '+driverLogin.token}});expect(response.statusCode).toBe(200);expect(response.json()).toMatchObject({success:true,order:{amount:'100',holderMembershipId:g.driver.companyMembershipId}});
  const confirmed=await graphDigest(),retry=await app.inject({method:'POST',url:path,payload,headers:{authorization:'Bearer '+driverLogin.token}});expect(retry.json()).toEqual(response.json());expect(await graphDigest()).toBe(confirmed);
 }finally{await app.close();}
});
it("parcel reassignment does not strand the original recorded cash holder or silently move cash",async()=>{
 const g=await pricedJourney(),collected=await executeRestrictedCash(actor(g.driver),'collect',cashIntent(g));
 const invitation=await createCompanyDriverInvitation(mockDb,g.actor,{operationId:randomUUID(),email:randomUUID()+'@example.invalid',profileRevision:'local-driver.v1',reason:'Synthetic reassignment actor'}),replacement=await acceptCompanyDriverInvitation(mockDb,{operationId:randomUUID(),token:invitation.token,name:'Synthetic replacement driver',password});
 const o=await mockDb.order.findUniqueOrThrow({where:{id:g.orderId}});await assignDriversBulk({actor:actor(g.dispatcher),orderIds:[g.orderId],driverId:replacement.userId,type:'pickup',expectedStates:[{orderId:g.orderId,updatedAt:o.updatedAt.toISOString(),status:o.status,assignedDriverId:o.assignedDriverId,currentWarehouseId:o.currentWarehouseId}]});
 for(const status of ['pickup_in_progress','picked_up'])await updateDriverOrderStatus({actor:actor(replacement),orderId:g.orderId,status:status as any});
 const s=await readWarehouseCustody(actor(replacement),g.orderId);await physical(g,replacement,'pickup-offer',{pickupTrackingId:s.pickupTrackingId,destinationWarehouseId:g.warehouse.id});
 expect((await mockDb.cashCollection.findUniqueOrThrow({where:{orderId_kind:{orderId:g.orderId,kind:'service_charge'}}})).currentHolderUserId).toBe(g.driver.userId);
 const offer=await executeRestrictedCash(actor(g.driver),'offer',cashIntent(g,{expectedEventId:collected.expectedEventId,recipientMembershipId:g.staff.companyMembershipId,recipientWarehouseId:g.warehouse.id}));
 const accepted=await executeRestrictedCash(actor(g.staff),'accept',cashIntent(g,{offerId:offer.offerId,expectedEventId:offer.expectedEventId}));expect(accepted).toMatchObject({holderMembershipId:g.staff.companyMembershipId,holderWarehouseId:g.warehouse.id,amount:'100'});
});

import {submitProofForActor} from "../../src/modules/orders-core/proofs/proof";
async function deliveryProof(g:any){const {PNG}=require("pngjs"),buffer=PNG.sync.write({width:2,height:2,data:Buffer.alloc(16,255)});const intent={actor:actor(g.driver),orderId:g.orderId,body:{submissionId:randomUUID(),stage:"delivery",signedBy:"Synthetic payer",clientCapturedAt:"2026-01-01T00:00:00.000Z",signaturePaths:["1,2;3,4"]},file:{buffer,size:buffer.length,mimetype:"image/png",originalname:"synthetic.png"}};const result=await submitProofForActor(intent);expect(await submitProofForActor(intent)).toEqual(result);return {intent,result};}
it("DOM-06 instruction fresh retries, conflicts, foreign bill-to and no creation-seeded collectible rows",async()=>{
 const g=await pricedJourney();expect(await bindServicePaymentInstruction(g.maker,g.instructionIntent)).toEqual(g.instruction);
 await unchanged(()=>bindServicePaymentInstruction(g.maker,{...g.instructionIntent,collectionParty:"RECIPIENT"}));await unchanged(()=>bindServicePaymentInstruction(actor(g.driver),g.instructionIntent));
 await unchanged(()=>bindServicePaymentInstruction(g.maker,{...g.instructionIntent,operationId:randomUUID(),billToId:randomUUID()}));
 expect(await mockDb.cashCollection.count({where:{orderId:g.orderId}})).toBe(1);expect(await mockDb.cashCollectionEvent.count({where:{cashCollection:{orderId:g.orderId},eventType:"expected"}})).toBe(1);
});
it("DOM-06 recipient timing permits scoped warehouse collection but denies early driver; sender cannot collect after pickup",async()=>{
 const g=await pricedJourney("RECIPIENT");await unchanged(()=>executeRestrictedCash(actor(g.driver),"collect",cashIntent(g)));
 await warehouseOffer(g);await physical(g,g.staff,"intake",{warehouseId:g.warehouse.id});const c=await executeRestrictedCash(actor(g.staff),"collect",cashIntent(g,{warehouseId:g.warehouse.id}));expect(c.amount).toBe("100");
 const settled=await executeRestrictedCash(actor(g.clerk),"settle",cashIntent(g,{expectedEventId:c.expectedEventId}));expect(settled.state).toBe("settled");
});
it("DOM-06 recipient delivery stays blocked until exact collection; wrong stage permission cannot collect",async()=>{
 const g=await pricedJourney("RECIPIENT");await warehouseOffer(g);await physical(g,g.staff,"intake",{warehouseId:g.warehouse.id});await physical(g,g.staff,"last-mile-offer",{warehouseId:g.warehouse.id,driverMembershipId:g.driver.companyMembershipId});await physical(g,g.driver,"last-mile-accept");
 const proof=await deliveryProof(g);await unchanged(()=>physical(g,g.driver,"deliver",{proofSubmissionId:proof.intent.body.submissionId}));
 const c=await executeRestrictedCash(actor(g.driver),"collect",cashIntent(g));await physical(g,g.driver,"deliver",{proofSubmissionId:proof.intent.body.submissionId});expect(c.amount).toBe("100");
});
async function revision(g:any){return acceptOrderPrice(g.maker,{orderId:g.orderId,operationId:randomUUID(),reason:"Synthetic reasoned price revision"});}
const revisionIntent=(g:any,p:any)=>({orderId:g.orderId,operationId:randomUUID(),snapshotId:p.id,contentHash:p.contentHash,reason:"Independent untouched revision"});
it("DOM-06 independently approved untouched revision preserves history and rejects obsolete collection/invoice authority",async()=>{
 const g=await pricedJourney(),p=await revision(g);expect(p.state).toBe("approval_required");const v=revisionIntent(g,p);await approveOrderPrice(g.pricingChecker,v);expect((await approveOrderPrice(g.pricingChecker,v)).id).toBe(p.id);
 await unchanged(()=>executeRestrictedCash(actor(g.driver),"collect",cashIntent(g)));await unchanged(()=>issueAcceptedOrderInvoice(g.maker,{orderId:g.orderId,operationId:randomUUID(),priceApprovalId:g.price.id,reason:"Obsolete invoice"}));
 const c=await executeRestrictedCash(actor(g.driver),"collect",cashIntent(g,{obligationId:p.id}));expect(c.amount).toBe("100");
 expect((await pool.query('SELECT count(*) FROM "OrderServiceCashObligation" WHERE "orderId"=$1',[g.orderId])).rows[0].count).toBe("2");expect((await acceptOrderPrice(g.maker,g.priceIntent)).id).toBe(g.price.id);
 await unchanged(()=>approveOrderPrice(g.pricingChecker,{...v,operationId:randomUUID()}));
});
it("DOM-06 revision versus collection serializes one monetary authority without partial approval or duplicate collection",async()=>{
 const g=await pricedJourney(),p=await revision(g),v=revisionIntent(g,p),r=await Promise.allSettled([approveOrderPrice(g.pricingChecker,v),executeRestrictedCash(actor(g.driver),"collect",cashIntent(g))]);expect(r.filter(x=>x.status==="fulfilled")).toHaveLength(1);
 const o=await mockDb.order.findUniqueOrThrow({where:{id:g.orderId}}),c=await mockDb.cashCollection.findUniqueOrThrow({where:{orderId_kind:{orderId:g.orderId,kind:"service_charge"}}});
 if(r[0].status==="fulfilled"){expect(o.currentPriceApprovalId).toBe(p.id);expect(c.status).toBe("expected");expect(await mockDb.cashCustodyOperation.count({where:{orderId:g.orderId}})).toBe(0);}else{expect(o.currentPriceApprovalId).toBe(g.price.id);expect(c.status).toBe("held");expect(await mockDb.orderPriceApproval.count({where:{snapshotId:p.id}})).toBe(0);}
});
it("DOM-06 pending reservation and uncertain attempt freeze revisions even without successful payment",async()=>{
 const g=await pricedJourney(),p=await revision(g);const config=await mockDb.paymentProviderConfig.create({data:{companyId:g.companyId,provider:"CLICK",environment:"TEST",secretEncrypted:"synthetic-unusable",secretMasked:"synthetic",callbackPath:"/synthetic",isEnabled:false}});
 const intent=await mockDb.paymentIntent.create({data:{companyId:g.companyId,orderId:g.orderId,provider:"CLICK",providerConfigId:config.id,environment:"TEST",amountMinor:10000n,currency:"UZS",idempotencyKey:randomUUID(),status:"PENDING"}});
 await unchanged(()=>approveOrderPrice(g.pricingChecker,revisionIntent(g,p)));
 // The pending durable reservation is sufficient even with no provider call/attempt.
 expect(await mockDb.paymentAttempt.count({where:{paymentIntentId:intent.id}})).toBe(0);
 await mockDb.paymentIntent.update({where:{id:intent.id},data:{status:"PROCESSING"}});await mockDb.paymentAttempt.create({data:{paymentIntentId:intent.id,provider:"CLICK",status:"ERROR",errorCode:"SYNTHETIC_UNCERTAIN_TRANSPORT"}});await unchanged(()=>approveOrderPrice(g.pricingChecker,revisionIntent(g,p)));
});
it("DOM-06 injected publication failure rolls back approval, obligation, mirrors, audit and pointer; original retry succeeds",async()=>{
 const g=await pricedJourney(),p=await revision(g),v=revisionIntent(g,p);
 await pool.query(`CREATE FUNCTION cp_service_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Synthetic obligation rollback'; END $$; CREATE TRIGGER cp_service_fail BEFORE INSERT ON "OrderServiceCashObligation" FOR EACH ROW EXECUTE FUNCTION cp_service_fail()`);
 try{await unchanged(()=>approveOrderPrice(g.pricingChecker,v));}finally{await pool.query('DROP TRIGGER cp_service_fail ON "OrderServiceCashObligation"; DROP FUNCTION cp_service_fail()');}
 expect((await approveOrderPrice(g.pricingChecker,v)).id).toBe(p.id);
});
it("DOM-06 zero accepted price publishes noncollectible source and no cash collection",async()=>{
 const g=await pricedJourney("SENDER",0);await unchanged(()=>issueAcceptedOrderInvoice(g.maker,{orderId:g.orderId,operationId:randomUUID(),priceApprovalId:g.price.id,reason:"Noncollectible invoice remains unavailable"}));expect(await mockDb.cashCollection.count({where:{orderId:g.orderId}})).toBe(0);await unchanged(()=>executeRestrictedCash(actor(g.driver),"collect",cashIntent(g)));await warehouseOffer(g);
 expect((await pool.query('SELECT amount,"collectionId" FROM "OrderServiceCashObligation" WHERE "orderId"=$1',[g.orderId])).rows[0]).toEqual({amount:"0.0000",collectionId:null});
});

import {importOrdersFromCsv} from "../../src/modules/orders-core/import/order-import";
it("DOM-06 normal import preserves row receipts without Float cash seeds or duplicate row effects",async()=>{
 const g=await pricedJourney();const fields=['senderName','senderPhone','receiverName','receiverPhone','pickupAddress','dropoffAddress','serviceType','currency','weightKg','customerEntityId','senderAddressId','receiverAddressId'];
 const row=['Synthetic importer','+998900000001','Synthetic recipient','+998900000002','Synthetic A','Synthetic B','DOOR_TO_DOOR','UZS','2',g.body.customerEntityId,g.body.addresses.senderAddressId,g.body.addresses.receiverAddressId];
 const csvText=fields.join(',')+'\n'+row.join(','),request={actor:g.maker,csvText,operationId:randomUUID()};
 const first=await importOrdersFromCsv(request);expect(first.count).toBe(1);const id=first.orders[0].id;expect(await mockDb.cashCollection.count({where:{orderId:id}})).toBe(0);
 const retry=await importOrdersFromCsv(request);expect(retry.orders.map(o=>o.id)).toEqual([id]);expect(retry.replayedRows).toBe(1);await unchanged(()=>importOrdersFromCsv({...request,csvText:csvText.replace('Synthetic importer','Conflicting importer')}));
 const billTo=await bindOrderBillTo(g.maker,{orderId:id,operationId:randomUUID(),payerCustomerEntityId:g.body.customerEntityId,evidence:"Synthetic imported payer",reason:"Synthetic imported payer"});
 await bindServicePaymentInstruction(g.maker,{orderId:id,operationId:randomUUID(),billToId:billTo.id,method:"CASH",collectionParty:"SENDER",evidence:"Synthetic imported instruction",reason:"Synthetic imported instruction"});
 const accepted=await acceptOrderPrice(g.maker,{orderId:id,operationId:randomUUID(),reason:"Synthetic imported price"});expect(accepted.total).toBe("100.0000");expect(await mockDb.cashCollection.count({where:{orderId:id}})).toBe(1);
});
it("DOM-06 sender pickup requires exact collection; legacy unproved obligations are not adopted",async()=>{
 const g=await pricedJourney();await updateDriverOrderStatus({actor:actor(g.driver),orderId:g.orderId,status:"pickup_in_progress"});await unchanged(()=>updateDriverOrderStatus({actor:actor(g.driver),orderId:g.orderId,status:"picked_up"}));
 const untouched=await createOrderForActor({user:g.maker,body:{...g.body,operationId:randomUUID()}}),id=untouched.payload.order.id;
 const b=await bindOrderBillTo(g.maker,{orderId:id,operationId:randomUUID(),payerCustomerEntityId:g.body.customerEntityId,evidence:"Synthetic legacy comparison",reason:"Synthetic legacy comparison"});
 await bindServicePaymentInstruction(g.maker,{orderId:id,operationId:randomUUID(),billToId:b.id,method:"CASH",collectionParty:"SENDER",evidence:"Synthetic cash",reason:"Synthetic cash"});
 // Deliberately invalid pre-upgrade row: negative test only, never a connected prerequisite.
 await mockDb.cashCollection.create({data:{orderId:id,kind:"service_charge",expectedAmount:100,currency:"UZS"}});
 await unchanged(()=>acceptOrderPrice(g.maker,{orderId:id,operationId:randomUUID(),reason:"Legacy must not be adopted"}));
});

it("DOM-06 concurrent instruction and initial acceptance publish one obligation; lost acknowledgement retries original result",async()=>{
 const g=await pricedJourney(),made=await createOrderForActor({user:g.maker,body:{...g.body,operationId:randomUUID()}}),orderId=made.payload.order.id;
 const billTo=await bindOrderBillTo(g.maker,{orderId,operationId:randomUUID(),payerCustomerEntityId:g.body.customerEntityId,evidence:"Synthetic duplicate payer",reason:"Synthetic duplicate payer"});
 const input={orderId,operationId:randomUUID(),billToId:billTo.id,method:"CASH",collectionParty:"SENDER",evidence:"Synthetic immutable instruction",reason:"Synthetic instruction"};
 const instructions=await Promise.all([bindServicePaymentInstruction(g.maker,input),bindServicePaymentInstruction(g.maker,input)]);expect(instructions[0]).toEqual(instructions[1]);
 const v={orderId,operationId:randomUUID(),reason:"Synthetic concurrent acceptance"},prices=await Promise.all([acceptOrderPrice(g.maker,v),acceptOrderPrice(g.maker,v)]);expect(prices[0]).toEqual(prices[1]);
 expect((await pool.query('SELECT count(*) FROM "OrderServiceCashObligation" WHERE "orderId"=$1',[orderId])).rows[0].count).toBe("1");expect(await mockDb.cashCollection.count({where:{orderId}})).toBe(1);
 const collect=cashIntent(g);let confirmed:any;await expect((async()=>{confirmed=await executeRestrictedCash(actor(g.driver),"collect",collect);throw Error("Synthetic lost acknowledgement");})()).rejects.toThrow("Synthetic lost acknowledgement");const before=await graphDigest();expect(await executeRestrictedCash(actor(g.driver),"collect",collect)).toEqual(confirmed);expect(await graphDigest()).toBe(before);
});
it("DOM-06 source constraints and append-only evidence reject tampering without certifying legacy state",async()=>{
 const g=await pricedJourney();for(const table of ["OrderServicePaymentInstruction","OrderServiceCashObligation"]){
  const change=table==="OrderServicePaymentInstruction"?"reason='changed'":"amount=1";await unchanged(()=>pool.query('UPDATE "'+table+'" SET '+change+' WHERE "orderId"=$1',[g.orderId]));await unchanged(()=>pool.query('DELETE FROM "'+table+'" WHERE "orderId"=$1',[g.orderId]));await unchanged(()=>pool.query('TRUNCATE "'+table+'" CASCADE'));
 }
 await unchanged(()=>pool.query('INSERT INTO "OrderServiceCashObligation" ("priceApprovalId","tenantId","companyId","legalEntityId","orderId","instructionId","billToId","payerCustomerEntityId","policyVersionId",amount,currency,"collectionId") SELECT $1,"tenantId","companyId","legalEntityId","orderId","instructionId","billToId","payerCustomerEntityId","policyVersionId",amount,currency,"collectionId" FROM "OrderServiceCashObligation" WHERE "orderId"=$2',[randomUUID(),g.orderId]));
 expect((await pool.query("SELECT convalidated FROM pg_constraint WHERE conname='RestrictedCashState_service_basis_fk'")).rows[0].convalidated).toBe(false);
 expect((await acceptOrderPrice(g.maker,g.priceIntent)).id).toBe(g.price.id);
});

// DOM-06 deadline evidence uses actual provisioning/business services, not direct state writes.
async function deadlinePolicy(g:any,fee="0",zero=false) {
 const p=await proposeBillingPolicy(g.maker,{operationId:randomUUID(),reason:"Explicit synthetic deadline-state calculation policy",content:syntheticBillingPolicy({
  billing:{mode:"manual",eligibleOrderStates:["pending","assigned","pickup_in_progress","picked_up","at_warehouse","in_transit","out_for_delivery","delivered"],dueDays:7,numberPrefix:"SYNTHETIC"},
  fees:fee==="0"?[]:[{service:"synthetic_explicit_fee",amount:fee}],discounts:zero?[{code:"synthetic_free",type:"percent",value:"100"}]:[],tax:{treatment:"exclusive_percent",rate:"0",authorityReference:"SYNTHETIC TEST ONLY"}})});
 await decideBillingPolicy(g.pricingChecker,{versionId:p.id,contentHash:p.contentHash,operationId:randomUUID(),decision:"approved",reason:"Independent synthetic deadline policy"});
}
async function deadlineTransition(g:any,party:string,existingProof?:any) {
 if(party==="SENDER")return updateDriverOrderStatus({actor:actor(g.driver),orderId:g.orderId,status:"picked_up"});
 const proof=existingProof??await deliveryProof(g);return physical(g,g.driver,"deliver",{proofSubmissionId:proof.intent.body.submissionId});
}
async function beforeDeadline(g:any,party:string) {
 if(party==="SENDER"){await updateDriverOrderStatus({actor:actor(g.driver),orderId:g.orderId,status:"pickup_in_progress"});return;}
 await warehouseOffer(g);await physical(g,g.staff,"intake",{warehouseId:g.warehouse.id});await physical(g,g.staff,"last-mile-offer",{warehouseId:g.warehouse.id,driverMembershipId:g.driver.companyMembershipId});await physical(g,g.driver,"last-mile-accept");
}
it.each(["SENDER","RECIPIENT"])("DOM-06 deadline zero %s rejects late positive revision; zero revisions and historical retries survive",async party=>{
 const g=await pricedJourney(party,0);await beforeDeadline(g,party);await deadlineTransition(g,party);await deadlinePolicy(g);
 const p=await revision(g),v=revisionIntent(g,p);
 await unchanged(async()=>{try{await approveOrderPrice(g.pricingChecker,v);}catch(error:any){expect(error.code).toBe("CASH_COLLECTION_WINDOW_CLOSED");throw error;}});
 expect((await mockDb.order.findUniqueOrThrow({where:{id:g.orderId}})).currentPriceApprovalId).toBe(g.price.id);
 expect(await mockDb.orderPriceApproval.count({where:{snapshotId:p.id}})).toBe(0);
 const before=await graphDigest();expect((await acceptOrderPrice(g.maker,g.priceIntent)).id).toBe(g.price.id);
 expect((await bindServicePaymentInstruction(g.maker,g.instructionIntent)).id).toBe(g.instruction.id);expect(await graphDigest()).toBe(before);
 await deadlinePolicy(g,"0",true);const zero=await revision(g),z=revisionIntent(g,zero);expect((await approveOrderPrice(g.pricingChecker,z)).total).toBe("0.0000");
 const confirmed=await graphDigest();expect((await approveOrderPrice(g.pricingChecker,z)).id).toBe(zero.id);expect(await graphDigest()).toBe(confirmed);
 expect(await mockDb.cashCollection.count({where:{orderId:g.orderId}})).toBe(0);
 expect((await pool.query('SELECT count(*) FROM "OrderServiceCashObligation" WHERE "orderId"=$1 AND amount>0',[g.orderId])).rows[0].count).toBe("0");
});
it.each(["SENDER","RECIPIENT"])("DOM-06 deadline late initial %s binding rejects before first cash acceptance",async party=>{
 const g=await pricedJourney(party,0,{tariffPrice:0}),made=await createOrderForActor({user:g.maker,body:{...g.body,operationId:randomUUID()}}),orderId=made.payload.order.id;
 const o=await mockDb.order.findUniqueOrThrow({where:{id:orderId}});expect(o.serviceCharge).toBeNull();expect(await mockDb.cashCollection.count({where:{orderId}})).toBe(0);
 await assignDriversBulk({actor:actor(g.dispatcher),orderIds:[orderId],driverId:g.driver.userId,type:"pickup",expectedStates:[{orderId,updatedAt:o.updatedAt.toISOString(),status:o.status,assignedDriverId:o.assignedDriverId,currentWarehouseId:o.currentWarehouseId}]});
 const work={...g,orderId};await beforeDeadline(work,party);await deadlineTransition(work,party);await deadlinePolicy(g,"100");
 const b=await bindOrderBillTo(g.maker,{orderId,operationId:randomUUID(),payerCustomerEntityId:g.body.customerEntityId,evidence:"Synthetic late payer",reason:"Synthetic late payer"});
 const input={orderId,operationId:randomUUID(),billToId:b.id,method:"CASH",collectionParty:party,evidence:"Synthetic late instruction",reason:"Synthetic late instruction"};
 await unchanged(async()=>{try{await bindServicePaymentInstruction(g.maker,input);}catch(error:any){expect(error.code).toBe("CASH_COLLECTION_WINDOW_CLOSED");throw error;}});
 expect((await pool.query('SELECT count(*) FROM "OrderServicePaymentInstruction" WHERE "orderId"=$1',[orderId])).rows[0].count).toBe("0");
 expect((await pool.query('SELECT count(*) FROM "OrderServiceCashObligation" WHERE "orderId"=$1',[orderId])).rows[0].count).toBe("0");
 expect((await mockDb.order.findUniqueOrThrow({where:{id:orderId}})).currentPriceApprovalId).toBeNull();
});

it.each(["SENDER","RECIPIENT"])("DOM-06 deadline timely initial %s instruction requires a first accepted basis before transition",async party=>{
 const g=await pricedJourney(party,0,{tariffPrice:0}),made=await createOrderForActor({user:g.maker,body:{...g.body,operationId:randomUUID()}}),orderId=made.payload.order.id;
 const o=await mockDb.order.findUniqueOrThrow({where:{id:orderId}});
 await assignDriversBulk({actor:actor(g.dispatcher),orderIds:[orderId],driverId:g.driver.userId,type:"pickup",expectedStates:[{orderId,updatedAt:o.updatedAt.toISOString(),status:o.status,assignedDriverId:o.assignedDriverId,currentWarehouseId:o.currentWarehouseId}]});
 const b=await bindOrderBillTo(g.maker,{orderId,operationId:randomUUID(),payerCustomerEntityId:g.body.customerEntityId,evidence:"Synthetic timely payer",reason:"Synthetic timely payer"});
 await bindServicePaymentInstruction(g.maker,{orderId,operationId:randomUUID(),billToId:b.id,method:"CASH",collectionParty:party,evidence:"Synthetic timely instruction",reason:"Synthetic timely instruction"});
 const work={...g,orderId};await beforeDeadline(work,party);const proof=party==="RECIPIENT"?await deliveryProof(work):undefined;
 await unchanged(async()=>{try{await deadlineTransition(work,party,proof);}catch(error:any){expect(error.code).toBe("CASH_SERVICE_OBLIGATION_REQUIRED");throw error;}});
 await deadlinePolicy(g,"100");const input={orderId,operationId:randomUUID(),reason:"Synthetic timely first acceptance"},price=await acceptOrderPrice(g.maker,input);
 expect(price.total).toBe("100.0000");expect((await acceptOrderPrice(g.maker,input)).id).toBe(price.id);
 await unchanged(async()=>{try{await deadlineTransition(work,party,proof);}catch(error:any){expect(error.code).toBe("CASH_SERVICE_COLLECTION_REQUIRED");throw error;}});
 expect((await pool.query('SELECT amount FROM "OrderServiceCashObligation" WHERE "orderId"=$1',[orderId])).rows[0].amount).toBe("100.0000");
});

it.each([["SENDER","publication"],["SENDER","transition"],["RECIPIENT","publication"],["RECIPIENT","transition"]])("DOM-06 deadline race %s %s locks first",async(party,first)=>{
 const g=await pricedJourney(party,0);await beforeDeadline(g,party);const proof=party==="RECIPIENT"?await deliveryProof(g):undefined;
 await deadlinePolicy(g);const p=await revision(g),v=revisionIntent(g,p),base=mockDb;
 const auditBefore=await mockDb.financeAuditEvent.count(),trackingBefore=await mockDb.tracking.count();
 let release!:()=>void,signal!:()=>void;const gate=new Promise<void>(r=>{release=r}),locked=new Promise<void>(r=>{signal=r});let paused=false,pid=0;
 mockDb=new Proxy(base,{get(target,key){if(key==='$transaction')return (work:any,options:any)=>base.$transaction(async tx=>{
  const wrapped=new Proxy(tx,{get(value,name){if(name==='$queryRaw')return async(...args:any[])=>{const result=await (value.$queryRaw as any)(...args),text=Array.isArray(args[0])?args[0].join('?'):args[0]?.sql??'';
   if(!paused&&text.includes('FROM "Order"')&&text.includes('FOR UPDATE')){paused=true;pid=Number((await value.$queryRaw<any[]>`SELECT pg_backend_pid() AS pid`)[0].pid);signal();await gate;}return result;};const valueFn=(value as any)[name];return typeof valueFn==='function'?valueFn.bind(value):valueFn;}});return work(wrapped);
 },options);const value=(target as any)[key];return typeof value==='function'?value.bind(target):value;}});
 const publication=()=>approveOrderPrice(g.pricingChecker,v),transition=()=>deadlineTransition(g,party,proof);
 const settled=(work:()=>Promise<any>)=>work().then(value=>({ok:true,value,error:null as any}),error=>({ok:false,value:null,error}));
 const leader=settled(first==="publication"?publication:transition);let follower:Promise<any>|undefined,timer:NodeJS.Timeout|undefined;
 try{
  await Promise.race([locked,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error("Deadline Order lock barrier timeout")),4000);})]);clearTimeout(timer);
  follower=settled(first==="publication"?transition:publication);let blocked=false;
  for(let i=0;i<40;i++){blocked=(await pool.query('SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1::int=ANY(pg_blocking_pids(pid))) AS blocked',[pid])).rows[0].blocked;if(blocked)break;await new Promise(r=>setTimeout(r,15));}
  expect(blocked).toBe(true);release();const a=await leader,b=await follower;expect(a.ok).toBe(true);expect(b.ok).toBe(false);
  const order=await base.order.findUniqueOrThrow({where:{id:g.orderId}}),deadline=party==="SENDER"?"picked_up":"delivered",before=party==="SENDER"?"pickup_in_progress":"out_for_delivery";
  if(first==="transition"){
   expect(b.error.code).toBe("CASH_COLLECTION_WINDOW_CLOSED");expect(order.status).toBe(deadline);expect(order.currentPriceApprovalId).toBe(g.price.id);
   expect(await base.orderPriceApproval.count({where:{snapshotId:p.id}})).toBe(0);expect(await base.financeAuditEvent.count()).toBe(auditBefore);expect(await base.cashCollection.count({where:{orderId:g.orderId}})).toBe(0);
  }else{
   expect(order.status).toBe(before);expect(order.currentPriceApprovalId).toBe(p.id);expect(await base.tracking.count()).toBe(trackingBefore);
   expect(await base.cashCollection.count({where:{orderId:g.orderId,status:"expected"}})).toBe(1);
   await unchanged(()=>deadlineTransition(g,party,proof)); // A fresh expected-state read still cannot bypass uncollected positive money.
  }
  expect((await pool.query('SELECT count(*) FROM "OrderServiceCashObligation" WHERE "orderId"=$1 AND amount>0',[g.orderId])).rows[0].count).toBe(first==="publication"?"1":"0");
 }finally{clearTimeout(timer);release();await Promise.allSettled([leader,...(follower?[follower]:[])]);mockDb=base;}
});


// Administration-only actual HTTP injection + PostgreSQL. No cash execution,
// real owner key, network listener or browser. Existing fixture entrypoints
// provision synthetic prerequisites; roles/scopes are compared after every change.
import identityRoutes from "../../src/modules/identity-access/transport/fastify-routes";
let ui:any,uiApp:ReturnType<typeof Fastify>,uiMakerToken:string,uiCheckerToken:string;
const cashRead=(view:string,kind="proposer",extra="")=>`/api/auth/company-cash-capabilities?view=${view}&kind=${kind}${extra}`;
async function cashHttp(url:string,token?:string,body?:any){const r=await uiApp.inject({method:body?"POST":"GET",url,headers:token?{authorization:`Bearer ${token}`}:{},...(body?{payload:body}:{})});return {status:r.statusCode,data:r.json(),cache:r.headers["cache-control"]};}
async function cashReadUnchanged(url:string,token?:string,status=200){const before=await graphDigest(),r=await cashHttp(url,token);expect(r.status).toBe(status);expect(await graphDigest()).toBe(before);if(status===200)expect(r.cache).toBe("no-store");expect(JSON.stringify(r.data)).not.toMatch(/passwordHash|tokenHash|operatorKeyFingerprint|publicKeyPem|"token"/);return r.data;}
async function cashDenied(url:string,token:string,body:any,status:number){const before=await graphDigest(),r=await cashHttp(url,token,body);expect(r.status).toBe(status);expect(await graphDigest()).toBe(before);return r.data;}
const cashPost="/api/auth/company-cash-capabilities/proposals",cashAccept="/api/auth/company-cash-capabilities/accept",cashRevoke="/api/auth/company-cash-capabilities/revoke";
async function uiLogin(m:any,pass:string){const u=await mockDb.user.findUniqueOrThrow({where:{id:m.userId}}),r=await cashHttp("/api/auth/login",undefined,{email:u.email,password:pass,companyMembershipId:m.companyMembershipId});expect(r.status).toBe(200);return r.data.token;}
let uiProposal:any,uiAcceptance:any,uiBase:any;
it("cash UI HTTP: accepted ceiling, named resources, eligible profiles and no read writes",async()=>{
 ui=await cashGroup();await cashOwner(ui,ui.maker,"checker",[ui.warehouse.id,ui.second.id]);uiApp=Fastify({logger:false});await uiApp.register(identityRoutes,{prefix:"/api/auth",rateLimiter:{consume:async({limit,windowMs}:any)=>({allowed:true,count:1,remaining:limit-1,limit,resetAfterMs:windowMs,backend:"local"})}} as any);await uiApp.ready();
 uiMakerToken=await uiLogin(ui.maker,ui.makerPassword);uiCheckerToken=await uiLogin(ui.checker,ui.checkerPassword);
 const c=await cashReadUnchanged(cashRead("ceiling"),uiMakerToken);expect(c.revision).toBe("cash-delegation.v1");expect(c.legalEntity.id).toBe(ui.entity.id);expect(c.warehouses.map((x:any)=>x.name)).toContain(ui.warehouse.name);expect(c.profiles).toHaveLength(3);
 const r=await cashReadUnchanged(cashRead("recipients"),uiMakerToken),driver=r.items.find((x:any)=>x.membershipId===ui.driver.companyMembershipId),staff=r.items.find((x:any)=>x.membershipId===ui.staff.companyMembershipId);
 expect(driver.profiles.map((x:any)=>x.revision)).toEqual(["local-driver-cash.v1"]);expect(staff.profiles.find((x:any)=>x.revision==="warehouse-cash.v1").warehouseIds).toEqual([ui.warehouse.id]);expect(r.items.some((x:any)=>x.membershipId===ui.maker.companyMembershipId)).toBe(false);
 uiBase={roles:await mockDb.membershipRole.findMany({orderBy:[{membershipId:"asc"},{roleId:"asc"}]}),scopes:await mockDb.membershipScope.findMany({orderBy:{id:"asc"}})};
},30000);
it("cash UI HTTP: ordinary authority, foreign cursor, unknown fields and bounded pagination deny",async()=>{
 const root=await uiLogin(ui,password);await cashReadUnchanged(cashRead("ceiling"),root,403);await cashReadUnchanged(cashRead("ceiling"),undefined,401);await cashReadUnchanged(cashRead("ceiling")+"&companyId="+ui.companyId,uiMakerToken,400);await cashReadUnchanged(cashRead("recipients")+"&limit=51",uiMakerToken,400);
 const p=await cashReadUnchanged(cashRead("recipients")+"&limit=1",uiMakerToken);expect(p.nextCursor).toBeTruthy();await cashReadUnchanged(cashRead("recipients")+"&cursor="+encodeURIComponent(p.nextCursor),uiCheckerToken,403);await cashReadUnchanged(cashRead("grants","checker")+"&cursor="+encodeURIComponent(p.nextCursor),uiCheckerToken,400);
 const foreign=await cashGroup(),foreignToken=await uiLogin(foreign.maker,foreign.makerPassword);expect((await cashReadUnchanged(cashRead("proposals"),foreignToken)).items).toHaveLength(0);await cashReadUnchanged(cashRead("recipients")+"&cursor="+encodeURIComponent(p.nextCursor),foreignToken,400);
 // Additional prerequisites do not form part of the original base comparison.
 uiBase={roles:await mockDb.membershipRole.findMany({orderBy:[{membershipId:"asc"},{roleId:"asc"}]}),scopes:await mockDb.membershipScope.findMany({orderBy:{id:"asc"}})};
 ui.foreign=foreign;
},30000);
it("cash UI HTTP: foreign resources, wrong base and rejected proposal leave complete graph unchanged",async()=>{
 await cashDenied(cashPost,uiMakerToken,proposal(ui,ui.foreign.driver),403);await cashDenied(cashPost,uiMakerToken,proposal(ui,ui.driver,"local-driver-cash.v1",{legalEntityId:ui.foreign.entity.id}),403);await cashDenied(cashPost,uiMakerToken,proposal(ui,ui.driver,"local-driver-cash.v1",{warehouseIds:[ui.foreign.warehouse.id]}),403);await cashDenied(cashPost,uiMakerToken,proposal(ui,ui.staff),403);await cashDenied(cashPost,uiMakerToken,proposal(ui,ui.driver,"warehouse-cash.v1"),403);await cashDenied(cashPost,uiMakerToken,proposal(ui,ui.driver,"local-driver-cash.v1",{kinds:["cod"]}),403);
});
it("cash UI HTTP: exact proposal, matching/conflicting retry and independent inspection",async()=>{
 const v=proposal(ui,ui.driver),r=await cashHttp(cashPost,uiMakerToken,v);expect(r.status).toBe(201);uiProposal={...r.data,input:v};const before=await graphDigest();expect((await cashHttp(cashPost,uiMakerToken,v)).data).toEqual(r.data);expect(await graphDigest()).toBe(before);expect((await cashDenied(cashPost,uiMakerToken,{...v,reason:"Conflicting content"},409)).code).toBe("CASH_CAPABILITY_INTENT_CONFLICT");
 const queue=await cashReadUnchanged(cashRead("proposals","checker"),uiCheckerToken),p=queue.items.find((x:any)=>x.proposalId===r.data.proposalId);expect(p.independent).toBe(true);expect(p.profileRevisions).toEqual(v.profileRevisions);expect(p.warehouseIds).toEqual(v.warehouseIds);expect(p.kinds).toEqual(v.kinds);expect(p.fingerprint).toBe(r.data.fingerprint);expect(p.expectedAcceptanceId).toBeNull();expect(p.state).toBe("pending");
});
it("cash UI HTTP: self approval denied, independent acceptance and managed read preserve base",async()=>{
 const v={operationId:randomUUID(),proposalId:uiProposal.proposalId,fingerprint:uiProposal.fingerprint,reason:"Independent synthetic decision"};expect((await cashDenied(cashAccept,uiMakerToken,v,403)).code).toBe("CASH_CAPABILITY_INDEPENDENT_CHECKER_REQUIRED");const r=await cashHttp(cashAccept,uiCheckerToken,v);expect(r.status).toBe(201);uiAcceptance=r.data;const before=await graphDigest();expect((await cashHttp(cashAccept,uiCheckerToken,v)).data).toEqual(r.data);expect(await graphDigest()).toBe(before);await cashDenied(cashAccept,uiCheckerToken,{...v,reason:"Different retry"},409);
 expect((await cashReadUnchanged(cashRead("grants"),uiMakerToken)).items.find((x:any)=>x.membershipId===ui.driver.companyMembershipId)).toMatchObject({acceptanceId:v.operationId,enabled:true});expect(await requireAcceptedDriver(mockDb,ui,ui.driver.companyMembershipId,"local")).toMatchObject({userId:ui.driver.userId});
 expect(await mockDb.membershipRole.findMany({orderBy:[{membershipId:"asc"},{roleId:"asc"}]})).toEqual(uiBase.roles);expect(await mockDb.membershipScope.findMany({orderBy:{id:"asc"}})).toEqual(uiBase.scopes);
});
it("cash UI HTTP: warehouse and settlement supplements, independently accepted replacement and revocation",async()=>{
 for(const [target,profile] of [[ui.staff,"warehouse-cash.v1"],[ui.clerk,"cash-settlement-checker.v1"]]){const p=await cashHttp(cashPost,uiMakerToken,proposal(ui,target,profile as string));expect(p.status).toBe(201);expect((await cashHttp(cashAccept,uiCheckerToken,{operationId:randomUUID(),...p.data,reason:"Independent supplement"})).status).toBe(201);}
 const p=await cashHttp(cashPost,uiMakerToken,proposal(ui,ui.driver,"local-driver-cash.v1",{warehouseIds:[ui.second.id],expectedAcceptanceId:uiAcceptance.acceptanceId}));expect(p.status).toBe(201);expect((await cashReadUnchanged(cashRead("grants"),uiMakerToken)).items.find((x:any)=>x.membershipId===ui.driver.companyMembershipId).acceptanceId).toBe(uiAcceptance.acceptanceId);
 const replaced=await cashHttp(cashAccept,uiCheckerToken,{operationId:randomUUID(),...p.data,reason:"Independent replacement"});expect(replaced.status).toBe(201);
 const v={operationId:randomUUID(),membershipId:ui.driver.companyMembershipId,legalEntityId:ui.entity.id,expectedAcceptanceId:replaced.data.acceptanceId,reason:"Immediate controlled revoke"};expect((await cashHttp(cashRevoke,uiMakerToken,v)).status).toBe(200);const before=await graphDigest();expect((await cashHttp(cashRevoke,uiMakerToken,v)).status).toBe(200);expect(await graphDigest()).toBe(before);
 expect((await cashReadUnchanged(cashRead("grants"),uiMakerToken)).items.find((x:any)=>x.membershipId===ui.driver.companyMembershipId).enabled).toBe(false);expect(await mockDb.membershipRole.findMany({orderBy:[{membershipId:"asc"},{roleId:"asc"}]})).toEqual(uiBase.roles);expect(await mockDb.membershipScope.findMany({orderBy:{id:"asc"}})).toEqual(uiBase.scopes);
});
it("cash UI HTTP: revoked accepted authority invalidates session and fresh reads/retries deny",async()=>{
 await cashOwner(ui,ui.maker,"proposer",[ui.warehouse.id,ui.second.id],undefined,"operator-revoke");await cashReadUnchanged(cashRead("ceiling"),uiMakerToken,401);uiMakerToken=await uiLogin(ui.maker,ui.makerPassword);await cashReadUnchanged(cashRead("ceiling"),uiMakerToken,403);await cashDenied(cashPost,uiMakerToken,uiProposal.input,403);await uiApp.close();
});
