jest.mock("../../src/config/prismaClient", () => ({ __esModule: true, default: new Proxy({}, {
        get: (_target, key) => { const value = (mockDb as any)[key]; return typeof value === "function" ? value.bind(mockDb) : value; },
    }) }));
jest.mock("../../src/config/redis", () => ({ getRedisClient: async () => null, getRedisPrefix: () => "synthetic",
    withRedisTimeout: (_name: any, work: any) => work() }));
import { PrismaClient } from "@prisma/client";
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
import { loginUser } from "../../src/modules/identity-access/application/auth.service";
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
const tables = ["Order", "OrderBillTo", "BillingPolicyVersion", "BillingPolicyDecision", "OrderPriceSnapshot", "OrderPriceApproval", "Invoice", "InvoiceIssuanceReceipt", "BillingInvoiceOutbox", "FinanceAuditEvent", "FinanceDomainEventOutbox", "FinanceJournalEntry", "FinancialDelegationAuthority", "FinancialGrantProposal", "FinancialMembershipGrant", "FinancialGrantAction", "FinanceLegalEntity", "TariffPlan", "TariffRate", "TariffConfigurationVersion", "TariffPublicationDecision", "Tenant", "Organization", "User", "TenantMembership", "CompanyMembership", "Role", "RolePermission", "MembershipRole", "MembershipScope", "TenantOnboardingReceipt", "CompanyDelegationAuthority", "CompanyInvitation", "CompanyOperationalGrant", "CompanyDelegationAction", "UserRefreshSession", "CredentialSecurityEvent"];
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
    process.env.JWT_SECRET = randomUUID();
    process.env.REFRESH_TOKEN_SECRET = randomUUID();
}, 30000);
beforeEach(() => writeFileSync(registryPath, JSON.stringify(registry)));
afterAll(async () => {
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
function ownerRequest(membershipId: string, warehouseIds: string[] = [], action = "operator-authorize") { const intent = { operationId: randomUUID(), membershipId, action, warehouseIds, ceilingRevision: DELEGATION_REVISION, profileRevision: ONBOARDING_PROFILE_V2, reason: "Synthetic reviewed owner authority" }; const now = Date.now(); const permit = { version: 1, operatorId: ONBOARDING_OPERATOR, keyFingerprint, operationId: intent.operationId, intentFingerprint: delegationFingerprint("operator-authority", intent), profileRevision: ONBOARDING_PROFILE_V2, issuedAt: new Date(now).toISOString(), expiresAt: new Date(now + 240000).toISOString() }; return { intent, permit, signature: sign(null, Buffer.from(canonicalOnboardingPermit(permit)), keys.privateKey).toString("base64") }; }
async function graphDigest() { const graph: Record<string, unknown> = {}; for (const table of tables)
    graph[table] = (await pool.query(`SELECT to_jsonb(record) AS row FROM "${table}" AS record ORDER BY to_jsonb(record)::text`)).rows; return createHash("sha256").update(JSON.stringify(graph)).digest("hex"); }
async function unchanged(work: () => Promise<unknown>) { const before = await graphDigest(); await expect(work()).rejects.toThrow(); expect(await graphDigest()).toBe(before); }
import { fork, type ChildProcess } from "child_process";
import path from "path";
import { authorizeFinancialDelegator, normalizeFinancialAuthorityIntent, proposeFinancialGrant, acceptFinancialGrant, revokeFinancialGrant } from "../../src/modules/identity-access/application/financial-delegation";
import { FINANCIAL_PROFILES } from "../../src/modules/identity-access/application/financial-profiles";
import { requireAcceptedFinancialCapability } from "../../src/modules/identity-access/application/financial-eligibility";
import { createTariffPlan,updateTariffPlan,deleteTariffPlan } from "../../src/modules/pricing-core/repo/pricing.repo";
import { proposeTariffVersion,decideTariffVersion } from "../../src/modules/pricing-core/repo/tariff-versions";
import { proposeBillingPolicy,decideBillingPolicy } from "../../src/modules/pricing-core/repo/billing-policy";
import { syntheticBillingPolicy } from "./billing-policy.fixture";
import { createCustomerEntity } from "../../src/modules/customers-core/application/customerEntityRepo";
import authRoutes from "../../src/modules/identity-access/transport/fastify-routes";
import { bindOrderBillTo, acceptOrderPrice, approveOrderPrice } from "../../src/modules/pricing-core/repo/order-price";
import { issueOrderInvoiceForActor } from "../../src/modules/invoice-core/application/invoiceRepo";
import { requireLegalEntityContext } from "../../src/modules/finance-core/application/legal-entity-access";
import { syntheticDriverOwner } from "./driver-provisioning.fixture";
import { authorizeCompanyDriverDelegator,createCompanyDriverInvitation,acceptCompanyDriverInvitation } from "../../src/modules/identity-access/application/driver-delegation";
import { requireAcceptedDriver } from "../../src/modules/identity-access/application/driver-eligibility";
const WebSocket = require("ws");
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

const allProfiles=Object.keys(FINANCIAL_PROFILES);
function financialOwner(membershipId:string,legalEntityId:string,kind='proposer',profiles=allProfiles,action='operator-authorize'){
 writeFileSync(registryPath,JSON.stringify({...registry,profileRevision:'financial-delegation.v1'}));
 const {intent,fingerprint}=normalizeFinancialAuthorityIntent({operationId:randomUUID(),membershipId,legalEntityId,kind,profileRevisions:[...profiles].sort(),action,profileRevision:'financial-delegation.v1',reason:'Synthetic reviewed financial ceiling'});
 const now=Date.now(),permit={version:1 as const,operatorId:ONBOARDING_OPERATOR,keyFingerprint,operationId:intent.operationId,intentFingerprint:fingerprint,profileRevision:'financial-delegation.v1',issuedAt:new Date(now).toISOString(),expiresAt:new Date(now+240000).toISOString()};
 return {intent,permit,signature:sign(null,Buffer.from(canonicalOnboardingPermit(permit)),keys.privateKey).toString('base64')};
}
async function staff(a:any){const e=await enrolled(a);const login=await loginUser({email:e.input.email,password:e.pass});return {...e,actor:{...login.user,id:login.user.userId},login};}
async function group(proposerProfiles=allProfiles,checkerProfiles=allProfiles){
 const a=await admin(),checker=await staff(a),target=await staff(a);
 // Explicit synthetic prerequisite only: DOM-04 configuration is not invoked.
 const legalEntity=await mockDb.financeLegalEntity.create({data:{tenantId:a.tenantId,companyId:a.companyId,baseCurrency:'UZS',fiscalYearStartMonth:1,timezone:'Asia/Tashkent',createdByUserId:a.userId,updatedByUserId:a.userId}});
 await authorizeFinancialDelegator(mockDb,financialOwner(a.companyMembershipId,legalEntity.id,'proposer',proposerProfiles));
 await authorizeFinancialDelegator(mockDb,financialOwner(checker.accepted.companyMembershipId,legalEntity.id,'checker',checkerProfiles));
 return {a,checker,target,legalEntity};
}
function proposal(g:any,profiles=allProfiles,expectedAcceptanceId:string|null=null){return {operationId:randomUUID(),membershipId:g.target.accepted.companyMembershipId,legalEntityId:g.legalEntity.id,profileRevisions:profiles,expectedAcceptanceId,reason:'Synthetic financial profile proposal'};}
async function accept(g:any,input=proposal(g)){
 const p=await proposeFinancialGrant(mockDb,g.a.actor,input);
 const v={operationId:randomUUID(),proposalId:p.proposalId,fingerprint:p.fingerprint,reason:'Independent synthetic financial acceptance'};
 const result=await acceptFinancialGrant(mockDb,g.checker.actor,v);return {p,v,result,input};
}
async function capability(actor:any,key:string){return mockDb.$transaction(tx=>requireAcceptedFinancialCapability(tx,actor,key));}
const tariffInput=()=>({name:'Synthetic draft',code:'SYN-'+randomUUID().slice(0,8),description:null,status:'active',serviceType:'DOOR_TO_DOOR',priceType:'bucket',pricingStrategy:'FIXED_LANE',coverageType:'domestic',transportMode:'ROAD',originCountryCode:null,destinationCountryCode:null,routeTemplateId:null,currency:'UZS',priority:1,isDefault:true,customerEntityId:null,rates:[{zone:1,weightFromKg:0.01,weightToKg:100,price:100}],transitLegRates:[]}) as any;
it('owner establishment is separate; synthetic operational enrollment -> independent financial acceptance -> selected login with exact allowlists',async()=>{
 const g=await group(),v=proposal(g),p=await proposeFinancialGrant(mockDb,g.a.actor,v),before=await graphDigest();
 expect(await proposeFinancialGrant(mockDb,g.a.actor,{...v,profileRevisions:[...v.profileRevisions].reverse()})).toEqual(p);expect(await graphDigest()).toBe(before);
 const accepted=await acceptFinancialGrant(mockDb,g.checker.actor,{operationId:randomUUID(),proposalId:p.proposalId,fingerprint:p.fingerprint,reason:'Independent review'});
 const login=await loginUser({email:g.target.input.email,password:g.target.pass});
 expect(login.user.companyMembershipId).toBe(g.target.accepted.companyMembershipId);
 for(const [profile,keys] of Object.entries(FINANCIAL_PROFILES)){
  const role=await mockDb.role.findUniqueOrThrow({where:{companyId_code:{companyId:g.a.companyId,code:profile}},include:{rolePermissions:{include:{permission:true}}}});
  expect(role.rolePermissions.map(r=>r.permission.key).sort()).toEqual([...keys].sort());
 }
 for(const key of ['finance.settings.manage','finance.journals.post','membership.proposeFinancial','shipment.update'])expect(login.user.permissionCodes).not.toContain(key);
 await capability({...login.user,id:login.user.userId},'pricing.orders.accept');
 expect((accepted as any).profileRevisions).toEqual([...allProfiles].sort());
});
it('self targets, self-checking and recipient checking reject without graph effects',async()=>{
 const g=await group();await unchanged(()=>proposeFinancialGrant(mockDb,g.a.actor,{...proposal(g),membershipId:g.a.companyMembershipId}));
 await authorizeFinancialDelegator(mockDb,financialOwner(g.a.companyMembershipId,g.legalEntity.id,'checker'));
 await authorizeFinancialDelegator(mockDb,financialOwner(g.target.accepted.companyMembershipId,g.legalEntity.id,'checker'));
 const p=await proposeFinancialGrant(mockDb,g.a.actor,proposal(g)),v={operationId:randomUUID(),proposalId:p.proposalId,fingerprint:p.fingerprint,reason:'Cannot self approve'};
 await unchanged(()=>acceptFinancialGrant(mockDb,g.a.actor,v));await unchanged(()=>acceptFinancialGrant(mockDb,g.target.actor,v));
});
it('foreign entity/company, ordinary operational grant authority and forbidden profile/scope inputs reject without effects',async()=>{
 const g=await group(),foreign=await admin();const e=await mockDb.financeLegalEntity.create({data:{tenantId:foreign.tenantId,companyId:foreign.companyId,baseCurrency:'UZS',createdByUserId:foreign.userId,updatedByUserId:foreign.userId}});
 for(const input of [{...proposal(g),legalEntityId:e.id},{...proposal(g),membershipId:foreign.companyMembershipId},{...proposal(g),profileRevisions:['cash-settlement-checker.v1']},{...proposal(g),warehouseIds:[randomUUID()]}])await unchanged(()=>proposeFinancialGrant(mockDb,g.a.actor,input));
 await unchanged(()=>proposeFinancialGrant(mockDb,foreign.actor,proposal(g)));
});
it('proposer and checker ceilings independently reject excessive new grants',async()=>{
 const g=await group(['pricing-maker.v1'],['pricing-checker.v1']);
 await unchanged(()=>proposeFinancialGrant(mockDb,g.a.actor,proposal(g,['manual-invoice-issuer.v1'])));
 const p=await proposeFinancialGrant(mockDb,g.a.actor,proposal(g,['pricing-maker.v1']));
 await unchanged(()=>acceptFinancialGrant(mockDb,g.checker.actor,{operationId:randomUUID(),proposalId:p.proposalId,fingerprint:p.fingerprint,reason:'Outside checker ceiling'}));
});
it('concurrent matching decisions produce one managed acceptance; conflicting reuse and a second acceptance identity reject',async()=>{
 const g=await group(),p=await proposeFinancialGrant(mockDb,g.a.actor,proposal(g)),v={operationId:randomUUID(),proposalId:p.proposalId,fingerprint:p.fingerprint,reason:'Concurrent exact intent'};
 const rows=await Promise.all([1,2,3].map(()=>acceptFinancialGrant(mockDb,g.checker.actor,v)));expect(rows[0]).toEqual(rows[1]);expect(rows[1]).toEqual(rows[2]);
 expect(await mockDb.financialGrantAction.count({where:{proposalId:p.proposalId}})).toBe(1);
 await unchanged(()=>acceptFinancialGrant(mockDb,g.checker.actor,{...v,reason:'Conflicting reason'}));
 await unchanged(()=>acceptFinancialGrant(mockDb,g.checker.actor,{...v,operationId:randomUUID()}));
 const before=await graphDigest();expect(await acceptFinancialGrant(mockDb,g.checker.actor,v)).toEqual(rows[0]);expect(await graphDigest()).toBe(before);
});
it('removed grant ceiling is enforced at proposal and decision; unrelated operational grants/scopes survive authorized replacement',async()=>{
 const g=await group(),first=await accept(g,proposal(g,['pricing-maker.v1','manual-invoice-issuer.v1']));
 const base=await mockDb.companyOperationalGrant.findUniqueOrThrow({where:{membershipId:g.target.accepted.companyMembershipId}});
 await authorizeFinancialDelegator(mockDb,financialOwner(g.a.companyMembershipId,g.legalEntity.id,'proposer',['pricing-maker.v1']));
 await unchanged(()=>proposeFinancialGrant(mockDb,g.a.actor,proposal(g,['pricing-maker.v1'],first.v.operationId)));
 await authorizeFinancialDelegator(mockDb,financialOwner(g.a.companyMembershipId,g.legalEntity.id));
 const p=await proposeFinancialGrant(mockDb,g.a.actor,proposal(g,['pricing-maker.v1'],first.v.operationId));
 await authorizeFinancialDelegator(mockDb,financialOwner(g.checker.accepted.companyMembershipId,g.legalEntity.id,'checker',['pricing-maker.v1']));
 await unchanged(()=>acceptFinancialGrant(mockDb,g.checker.actor,{operationId:randomUUID(),proposalId:p.proposalId,fingerprint:p.fingerprint,reason:'Cannot strip issuer'}));
 await authorizeFinancialDelegator(mockDb,financialOwner(g.checker.accepted.companyMembershipId,g.legalEntity.id,'checker'));
 await acceptFinancialGrant(mockDb,g.checker.actor,{operationId:randomUUID(),proposalId:p.proposalId,fingerprint:p.fingerprint,reason:'Approved replacement'});
 expect(await mockDb.membershipRole.findUnique({where:{membershipId_roleId:{membershipId:base.membershipId,roleId:base.roleId}}})).not.toBeNull();
 expect(await mockDb.membershipScope.count({where:{membershipId:base.membershipId,scopeType:'company',scopeRefId:g.a.companyId}})).toBe(1);
 await unchanged(()=>capability(g.target.actor,'finance.invoices.issue'));
});
it('revoked proposer cannot have a pending proposal accepted; revocation preserves existing accepted grants until explicitly revoked',async()=>{
 const g=await group(),first=await accept(g),p=await proposeFinancialGrant(mockDb,g.a.actor,proposal(g,['pricing-maker.v1'],first.v.operationId));
 await authorizeFinancialDelegator(mockDb,financialOwner(g.a.companyMembershipId,g.legalEntity.id,'proposer',allProfiles,'operator-revoke'));
 await unchanged(()=>acceptFinancialGrant(mockDb,g.checker.actor,{operationId:randomUUID(),proposalId:p.proposalId,fingerprint:p.fingerprint,reason:'Revoked source authority'}));
 await capability(g.target.actor,'pricing.write');
});
it('managed revocation invalidates receipts and prevents reinstatement without new independent acceptance',async()=>{
 const g=await group(),first=await accept(g),v={operationId:randomUUID(),membershipId:g.target.accepted.companyMembershipId,legalEntityId:g.legalEntity.id,expectedAcceptanceId:first.v.operationId,reason:'Immediate managed revocation'};
 const r=await revokeFinancialGrant(mockDb,g.checker.actor,v),before=await graphDigest();expect(await revokeFinancialGrant(mockDb,g.checker.actor,v)).toEqual(r);expect(await graphDigest()).toBe(before);
 await unchanged(()=>capability(g.target.actor,'pricing.write'));await unchanged(()=>acceptFinancialGrant(mockDb,g.checker.actor,first.v));
 await accept(g,proposal(g,['pricing-maker.v1'],first.v.operationId));await capability(g.target.actor,'pricing.write');
});
it('suspended recipient cannot act or receive replacement but its managed financial access remains revocable',async()=>{
 const g=await group(),first=await accept(g);
 await mockDb.companyMembership.update({where:{id:g.target.accepted.companyMembershipId},data:{status:'suspended'}});
 await unchanged(()=>capability(g.target.actor,'pricing.write'));
 await unchanged(()=>proposeFinancialGrant(mockDb,g.a.actor,proposal(g,['pricing-maker.v1'],first.v.operationId)));
 await revokeFinancialGrant(mockDb,g.checker.actor,{operationId:randomUUID(),membershipId:g.target.accepted.companyMembershipId,legalEntityId:g.legalEntity.id,expectedAcceptanceId:first.v.operationId,reason:'Remove dormant suspended financial access'});
 expect((await mockDb.financialMembershipGrant.findUniqueOrThrow({where:{membershipId:g.target.accepted.companyMembershipId}})).enabled).toBe(false);
});
it('financial replacement/revocation preserves another-company membership, grants and live session of the same identity',async()=>{
 const g=await group(),first=await accept(g),foreign=await admin(),current=await loginUser({email:g.target.input.email,password:g.target.pass});
 const inv=await createCompanyInvitation(mockDb,foreign.actor,inviteInput({email:g.target.input.email}));
 const joined=await acceptCompanyInvitation(mockDb,{token:inv.token,operationId:randomUUID()},current.token);
 const login=await loginUser({email:g.target.input.email,password:g.target.pass,companyMembershipId:joined.companyMembershipId});
 const before=await mockDb.companyMembership.findUniqueOrThrow({where:{id:joined.companyMembershipId},include:{roles:true,scopes:true}});
 await revokeFinancialGrant(mockDb,g.a.actor,{operationId:randomUUID(),membershipId:g.target.accepted.companyMembershipId,legalEntityId:g.legalEntity.id,expectedAcceptanceId:first.v.operationId,reason:'Selected-company revocation only'});
 expect(await mockDb.companyMembership.findUniqueOrThrow({where:{id:joined.companyMembershipId},include:{roles:true,scopes:true}})).toEqual(before);
 expect(await hasLiveAccessSession(jwt.decode(login.token) as any)).toBe(true);
});
it('managed driver eligibility and zero scopes remain exact; financial grants to the driver are rejected',async()=>{
 const g=await group(),owner=syntheticDriverOwner();
 try{
  await authorizeCompanyDriverDelegator(mockDb,owner.request(g.a.companyMembershipId));
  const inv=await createCompanyDriverInvitation(mockDb,g.a.actor,{operationId:randomUUID(),email:randomUUID()+'@example.invalid',profileRevision:'local-driver.v1',reason:'Separate approved driver enrollment'});
  const driver=await acceptCompanyDriverInvitation(mockDb,{token:inv.token,operationId:randomUUID(),name:'Synthetic driver',password});
  const before=await mockDb.companyMembership.findUniqueOrThrow({where:{id:driver.companyMembershipId},include:{roles:true,scopes:true}});
  await unchanged(()=>proposeFinancialGrant(mockDb,g.a.actor,{...proposal(g),membershipId:driver.companyMembershipId}));
  expect((await requireAcceptedDriver(mockDb,driver,driver.companyMembershipId)).driverType).toBe('local');
  expect(await mockDb.companyMembership.findUniqueOrThrow({where:{id:driver.companyMembershipId},include:{roles:true,scopes:true}})).toEqual(before);expect(before.scopes).toEqual([]);
 }finally{owner.cleanup();}
});
it('competing replacement and revocation serialize; stale loser makes no alternative accepted grant',async()=>{
 const g=await group(),first=await accept(g),p=await proposeFinancialGrant(mockDb,g.a.actor,proposal(g,['pricing-maker.v1'],first.v.operationId));
 const outcomes=await Promise.allSettled([acceptFinancialGrant(mockDb,g.checker.actor,{operationId:randomUUID(),proposalId:p.proposalId,fingerprint:p.fingerprint,reason:'Replacement'}),revokeFinancialGrant(mockDb,g.a.actor,{operationId:randomUUID(),membershipId:g.target.accepted.companyMembershipId,legalEntityId:g.legalEntity.id,expectedAcceptanceId:first.v.operationId,reason:'Competing revocation'})]);
 expect(outcomes.filter(r=>r.status==='fulfilled')).toHaveLength(1);
 expect(outcomes.filter(r=>r.status==='rejected')).toHaveLength(1);
 const grant=await mockDb.financialMembershipGrant.findUniqueOrThrow({where:{membershipId:g.target.accepted.companyMembershipId}});
 expect(grant.enabled?grant.profileRevisions:['revoked']).toEqual(outcomes[0].status==='fulfilled'?['pricing-maker.v1']:['revoked']);
});
it('acceptance transaction failure rolls back roles, versions, sessions, grant and immutable audit',async()=>{
 const g=await group(),p=await proposeFinancialGrant(mockDb,g.a.actor,proposal(g));
 await pool.query(`CREATE FUNCTION cp_financial_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='accept' THEN RAISE EXCEPTION 'Synthetic rollback'; END IF; RETURN NEW; END $$; CREATE TRIGGER cp_financial_fail BEFORE INSERT ON "FinancialGrantAction" FOR EACH ROW EXECUTE FUNCTION cp_financial_fail();`);
 try{await unchanged(()=>acceptFinancialGrant(mockDb,g.checker.actor,{operationId:randomUUID(),proposalId:p.proposalId,fingerprint:p.fingerprint,reason:'Injected failure'}));}
 finally{await pool.query('DROP TRIGGER cp_financial_fail ON "FinancialGrantAction"; DROP FUNCTION cp_financial_fail();');}
});
it('protected proposals/actions reject UPDATE DELETE TRUNCATE without changing grant graph',async()=>{
 const g=await group();await accept(g);
 for(const table of ['FinancialGrantProposal','FinancialGrantAction'])for(const action of ['UPDATE','DELETE','TRUNCATE']){
  const before=await graphDigest();
  const statement=action==='UPDATE'?`UPDATE "${table}" SET reason='tamper'`:action==='DELETE'?`DELETE FROM "${table}"`:`TRUNCATE "${table}" CASCADE`;
  await expect(pool.query(statement)).rejects.toMatchObject({code:'P0001',message:'Accepted onboarding audit is immutable'});expect(await graphDigest()).toBe(before);
 }
});
it('new compound grant constraints reject wrong user, foreign legal entity and non-acceptance source references',async()=>{
 const g=await group(),first=await accept(g),foreign=await admin();
 const entity=await mockDb.financeLegalEntity.create({data:{tenantId:foreign.tenantId,companyId:foreign.companyId,baseCurrency:'UZS',createdByUserId:foreign.userId,updatedByUserId:foreign.userId}});
 for(const [field,value] of [['userId',g.checker.actor.id],['legalEntityId',entity.id],['acceptedOperationId',first.p.proposalId]]){
  const before=await graphDigest();await expect(pool.query(`UPDATE "FinancialMembershipGrant" SET "${field}"=$1 WHERE "membershipId"=$2`,[value,g.target.accepted.companyMembershipId])).rejects.toMatchObject({code:'23503'});expect(await graphDigest()).toBe(before);
 }
});
it('actual provisioned maker/checker publish tariff and calculation policy; published plan update/delete remain denied',async()=>{
 const g=await group(),maker=await accept(g,proposal(g,['pricing-maker.v1'])),other=await staff(g.a),cg={...g,target:other};
 await accept(cg,proposal(cg,['pricing-checker.v1']));
 const plan=await createTariffPlan(g.target.actor,tariffInput());
 const current=await mockDb.tariffPlan.findUniqueOrThrow({where:{id:plan!.id}});
 const v=await proposeTariffVersion({user:g.target.actor,planId:current.id,expectedGeneration:current.contentGeneration,operationId:randomUUID(),reason:'Synthetic tariff publication'});
 await decideTariffVersion({user:other.actor,planId:current.id,versionId:v.id,operationId:randomUUID(),contentSha256:v.contentSha256,decision:'approved',reason:'Independent publication'});
 await unchanged(()=>updateTariffPlan(g.target.actor,current.id,tariffInput()));await unchanged(()=>deleteTariffPlan(g.target.actor,current.id));
 const before=await mockDb.tariffPlan.findUniqueOrThrow({where:{id:current.id}});await createTariffPlan(g.target.actor,tariffInput());expect(await mockDb.tariffPlan.findUniqueOrThrow({where:{id:current.id}})).toEqual(before);
 const policy=await proposeBillingPolicy(g.target.actor,{operationId:randomUUID(),reason:'Synthetic independently established billing configuration',content:syntheticBillingPolicy()});
 await decideBillingPolicy(other.actor,{versionId:policy.id,contentHash:policy.contentHash,operationId:randomUUID(),decision:'approved',reason:'Independent policy approval'});
 expect(maker.result).toHaveProperty('acceptanceId');
});
it('unpublished draft update/delete still work under accepted maker authority',async()=>{
 const g=await group();await accept(g,proposal(g,['pricing-maker.v1']));const p=await createTariffPlan(g.target.actor,tariffInput());
 await updateTariffPlan(g.target.actor,p!.id,{...tariffInput(),name:'Changed synthetic draft'});expect(await deleteTariffPlan(g.target.actor,p!.id)).toMatchObject({deleted:true});
});
it('provisioned company/entity actors bind payer, accept exact standard price and issue a same-currency manual invoice with matching retries',async()=>{
 const g=await group();await accept(g);const checker=await staff(g.a),cg={...g,target:checker};await accept(cg);
 const plan=await createTariffPlan(g.target.actor,tariffInput());
 const draft=await mockDb.tariffPlan.findUniqueOrThrow({where:{id:plan!.id}});
 const v=await proposeTariffVersion({user:g.target.actor,planId:plan!.id,expectedGeneration:draft.contentGeneration,operationId:randomUUID(),reason:'Synthetic tariff'});
 await decideTariffVersion({user:checker.actor,planId:plan!.id,versionId:v.id,operationId:randomUUID(),contentSha256:v.contentSha256,decision:'approved',reason:'Independent tariff'});
 const policy=await proposeBillingPolicy(g.target.actor,{operationId:randomUUID(),reason:'Synthetic configuration',content:syntheticBillingPolicy()});
 await decideBillingPolicy(checker.actor,{versionId:policy.id,contentHash:policy.contentHash,operationId:randomUUID(),decision:'approved',reason:'Independent policy'});
 const customer=await createCustomerEntity(g.target.actor,{type:'PERSON',name:'Synthetic DOM-03 customer'});
 // Synthetic order/address prerequisites isolate financial provisioning from unchanged order creation evidence.
 const addresses=await Promise.all(['Synthetic A','Synthetic B'].map(city=>mockDb.address.create({data:{tenantId:g.a.tenantId,customerEntityId:customer.id,city,country:'ZZ',street:'Synthetic street'}})));
 const o=await mockDb.order.create({data:{orderNumber:'SYN-'+randomUUID(),tenantId:g.a.tenantId,ownerOrgId:g.a.companyId,customerId:g.target.actor.id,customerEntityId:customer.id,
   senderAddressId:addresses[0].id,receiverAddressId:addresses[1].id,pickupAddress:'Synthetic A',dropoffAddress:'Synthetic B',weightKg:2,currency:'UZS',serviceType:'DOOR_TO_DOOR',paymentType:'CARD'}});
 const intent={orderId:o.id,operationId:randomUUID(),reason:'Synthetic exact price'},payer={...intent,operationId:randomUUID(),payerCustomerEntityId:customer.id,evidence:'Explicit synthetic bill-to instruction'};
 const bound=await bindOrderBillTo(g.target.actor,payer);expect(await bindOrderBillTo(g.target.actor,payer)).toEqual(bound);
 const price=await acceptOrderPrice(g.target.actor,intent);expect(price).toMatchObject({state:'accepted',total:'110.0100',currency:'UZS'});
 expect(await acceptOrderPrice(g.target.actor,intent)).toEqual(price);
 const revision=await acceptOrderPrice(g.target.actor,{...intent,operationId:randomUUID()});
 expect(revision.state).toBe('approval_required');
 const approval={...intent,operationId:randomUUID(),snapshotId:revision.id,contentHash:revision.contentHash};
 await unchanged(()=>approveOrderPrice(g.target.actor,approval));
 const confirmed=await approveOrderPrice(checker.actor,approval);expect(confirmed.state).toBe('accepted');
 const request={user:g.target.actor,orderId:o.id,operationId:randomUUID(),priceApprovalId:confirmed.id,reason:'Synthetic manual invoice'};
 const invoice=await issueOrderInvoiceForActor(request);expect(await issueOrderInvoiceForActor(request)).toEqual(invoice);
 expect(invoice).toMatchObject({currency:'UZS',amount:'110.0100'});
 expect(await mockDb.billingInvoiceOutbox.count({where:{invoiceId:invoice.id,state:'held_no_accounting_authority'}})).toBe(1);
 expect(await mockDb.financeJournalEntry.count()).toBe(0);
 await requireLegalEntityContext(g.target.actor,'finance.settings.read');
 await unchanged(()=>acceptOrderPrice(g.target.actor,{...intent,operationId:randomUUID()}));
});
it('HTTP and existing sockets in two actual isolated processes lose selected access after managed revocation',async()=>withSocketPeers(async(peers,wires)=>{
 const g=await group(),first=await accept(g,proposal(g,['pricing-maker.v1'])),login=await loginUser({email:g.target.input.email,password:g.target.pass});
 const app=Fastify();app.get('/protected',{preHandler:fastifyAuth({permission:'pricing.write'})},async()=>({ok:true}));
 try{expect((await app.inject({url:'/protected',headers:{authorization:'Bearer '+login.token}})).statusCode).toBe(200);
 for(const peer of peers)wires.push(await connectWire(peer,login.token));
 await revokeFinancialGrant(mockDb,g.a.actor,{operationId:randomUUID(),membershipId:g.target.accepted.companyMembershipId,legalEntityId:g.legalEntity.id,expectedAcceptanceId:first.v.operationId,reason:'Revocation transport test'});
 expect((await app.inject({url:'/protected',headers:{authorization:'Bearer '+login.token}})).statusCode).toBe(401);await Promise.all(wires.map(w=>awaitClosed(w)));
 }finally{await app.close();}
}));
it('actual financial HTTP proposal/accept/revoke contracts require current selected sessions and reject ownership fields',async()=>{
 const g=await group(),maker=await loginUser({email:g.a.actor.email,password}),checker=await loginUser({email:g.checker.input.email,password:g.checker.pass});
 const app=Fastify();await app.register(authRoutes,{prefix:'/api/auth'});
 try{
  const url='/api/auth/company-financial-grants/proposals',payload=proposal(g,['pricing-maker.v1']);
  expect((await app.inject({method:'POST',url,payload})).statusCode).toBe(401);
  const before=await graphDigest();expect((await app.inject({method:'POST',url,payload:{...payload,tenantId:g.a.tenantId},headers:{authorization:'Bearer '+maker.token}})).statusCode).toBe(400);expect(await graphDigest()).toBe(before);
  const proposed=await app.inject({method:'POST',url,payload,headers:{authorization:'Bearer '+maker.token}});expect(proposed.statusCode).toBe(201);
  const p=proposed.json(),operationId=randomUUID();
  const accepted=await app.inject({method:'POST',url:'/api/auth/company-financial-grants/accept',payload:{operationId,proposalId:p.proposalId,fingerprint:p.fingerprint,reason:'Independent HTTP acceptance'},headers:{authorization:'Bearer '+checker.token}});expect(accepted.statusCode).toBe(201);
  expect(accepted.json()).toMatchObject({companyMembershipId:g.target.accepted.companyMembershipId,legalEntityId:g.legalEntity.id,acceptanceId:operationId,profileRevisions:['pricing-maker.v1']});
  const revoked=await app.inject({method:'POST',url:'/api/auth/company-financial-grants/revoke',payload:{operationId:randomUUID(),membershipId:g.target.accepted.companyMembershipId,legalEntityId:g.legalEntity.id,expectedAcceptanceId:operationId,reason:'Immediate HTTP revocation'},headers:{authorization:'Bearer '+checker.token}});expect(revoked.statusCode).toBe(200);
 }finally{await app.close();}
});
