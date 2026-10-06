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
const tables = ["Tenant", "Organization", "User", "TenantMembership", "CompanyMembership", "Role", "RolePermission", "MembershipRole", "MembershipScope", "TenantOnboardingReceipt", "CompanyDelegationAuthority", "CompanyInvitation", "CompanyOperationalGrant", "CompanyDelegationAction", "UserRefreshSession", "CredentialSecurityEvent", "CompanyDriverDelegationAuthority", "CompanyDriverInvitation", "CompanyDriverEligibility", "CompanyDriverAction"];
async function counts() { const result: Record<string, number> = {}; for (const table of tables)
    result[table] = Number((await pool.query(`SELECT count(*) AS count FROM "${table}"`)).rows[0].count); return result; }
let driverOwner: ReturnType<typeof syntheticDriverOwner>;
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
    driverOwner = syntheticDriverOwner();
}, 30000);
beforeEach(() => writeFileSync(registryPath, JSON.stringify(registry)));
afterAll(async () => {
    driverOwner?.cleanup();
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
import { collectOrderCash, handoffOrderCash, settleOrderCash } from "../../src/modules/orders-core/cash/custody.service";
import { hasLiveAccessSession } from "../../src/modules/identity-access/application/access-session";
async function admin() { process.env.CARGOPILOT_ONBOARDING_REGISTRY_PATH=registryPath; writeFileSync(registryPath, JSON.stringify(registry)); const args = request(), result = await onboardTenant(mockDb, args); const login = await loginUser({ email: args.intent.administrator.email, password }); return { ...result, actor: { ...login.user, id: login.user.userId }, login }; }

import { syntheticDriverOwner } from "./driver-provisioning.fixture";
import { authorizeCompanyDriverDelegator, createCompanyDriverInvitation, acceptCompanyDriverInvitation, cancelCompanyDriverInvitation, mutateCompanyDriverEligibility } from "../../src/modules/identity-access/application/driver-delegation";
import { DRIVER_PROFILES } from "../../src/modules/identity-access/application/driver-profiles";
import { loadAccessSnapshot } from "../../src/modules/identity-access/access-control";
import { requireAcceptedDriver } from "../../src/modules/identity-access/application/driver-eligibility";
import { listCustodyWork } from "../../src/modules/orders-core/read/custody-work";
import { requireProofSubmissionContext } from "../../src/modules/orders-core/proofs/proof";
async function driverAdmin(profiles?: string[]) { const a = await admin(); driverOwner.register(); const request = driverOwner.request(a.companyMembershipId, profiles); await authorizeCompanyDriverDelegator(mockDb,request); return {...a,request}; }
const driverInput = (extra:any={}) => ({ operationId:randomUUID(), email:randomUUID()+"@example.invalid", profileRevision:"local-driver.v1",reason:"Synthetic reviewed driver invitation",...extra });
async function enroll(a:any,extra:any={}) { const input=driverInput(extra), invitation=await createCompanyDriverInvitation(mockDb,a.actor,input), op=randomUUID(); const accepted=await acceptCompanyDriverInvitation(mockDb,{token:invitation.token,operationId:op,name:"Synthetic driver",password}); const login=await loginUser({email:input.email,password,companyMembershipId:accepted.companyMembershipId}); return {input,invitation,op,accepted,login,actor:{...login.user,id:accepted.userId}}; }
async function graphDigest() { const graph:Record<string,unknown>={}; for(const table of tables)graph[table]=(await pool.query('SELECT to_jsonb(t) AS row FROM "'+table+'" t ORDER BY to_jsonb(t)::text')).rows; return createHash("sha256").update(JSON.stringify(graph)).digest("hex"); }
async function unchanged(work:()=>Promise<unknown>) { const before=await graphDigest(); await expect(work()).rejects.toThrow(); expect(await graphDigest()).toBe(before); }
const change=(e:any,extra:any={})=>({operationId:randomUUID(),membershipId:e.accepted.companyMembershipId,action:"grant",profileRevision:"linehaul-driver.v1",reason:"Synthetic explicit profile change",...extra});

it("separate owner authority is required; v2 operational ceiling and registry cannot mint driver grants",async()=>{
 const a=await admin(); await unchanged(()=>createCompanyDriverInvitation(mockDb,a.actor,driverInput()));
 await unchanged(()=>authorizeCompanyDriverDelegator(mockDb,driverOwner.request(a.companyMembershipId)));
 expect(await mockDb.companyDriverDelegationAuthority.count()).toBe(0);
 driverOwner.register(); const r=driverOwner.request(a.companyMembershipId); await authorizeCompanyDriverDelegator(mockDb,r); const before=await graphDigest();
 expect(await authorizeCompanyDriverDelegator(mockDb,r)).toMatchObject({enabled:true}); expect(await graphDigest()).toBe(before);
 expect((await mockDb.companyDelegationAuthority.findUniqueOrThrow({where:{membershipId:a.companyMembershipId}})).warehouseIds).toEqual([]);
});
it.each(["local-driver.v1","linehaul-driver.v1"])("%s enrollment and selected login preserve exact allowlist, zero scopes and null shared type",async(profileRevision)=>{
 const a=await driverAdmin(),e=await enroll(a,{profileRevision});
 expect(e.login.user.permissionCodes.sort()).toEqual([...DRIVER_PROFILES[profileRevision as keyof typeof DRIVER_PROFILES]].sort());expect(e.login.user.scopes).toEqual([]);
 expect((await mockDb.user.findUniqueOrThrow({where:{id:e.accepted.userId}})).driverType).toBeNull();
 const eligible=await requireAcceptedDriver(mockDb,e.accepted,e.accepted.companyMembershipId);expect(eligible.driverType).toBe(profileRevision.startsWith("local")?"local":"linehaul");
 const before=await graphDigest();expect(await acceptCompanyDriverInvitation(mockDb,{token:e.invitation.token,operationId:e.op},e.login.token)).toEqual(e.accepted);expect(await graphDigest()).toBe(before);
 expect((await listCustodyWork(e.actor,{kind:"driver"})).items).toEqual([]);
});
it("normalized invitation retries return no raw token; conflicts, scopes, forbidden profiles and self grants leave no effects",async()=>{
 const a=await driverAdmin(["local-driver.v1"]), input=driverInput(), inv=await createCompanyDriverInvitation(mockDb,a.actor,input), before=await graphDigest();
 const retry=await createCompanyDriverInvitation(mockDb,a.actor,{...input,email:input.email.toUpperCase()});expect(retry.invitationId).toBe(inv.invitationId);expect(retry.token).toBeUndefined();expect(await graphDigest()).toBe(before);
 for(const extra of [{profileRevision:"linehaul-driver.v1"},{profileRevision:"finance-checker.v1"},{warehouseIds:[randomUUID()]},{permissions:["shipment.update"]},{email:a.actor.email}]) await unchanged(()=>createCompanyDriverInvitation(mockDb,a.actor,{...input,...extra}));
 await unchanged(()=>mutateCompanyDriverEligibility(mockDb,a.actor,{...change({accepted:a}),membershipId:a.companyMembershipId}));
});
it("existing recipient must prove identity; other-company context, credentials and grants survive enrollment/replacement/revocation",async()=>{
 const a=await driverAdmin(),b=await admin();driverOwner.register();const old=await mockDb.user.findUniqueOrThrow({where:{id:b.actor.id}}),beforeOther=await mockDb.companyMembership.findUniqueOrThrow({where:{id:b.companyMembershipId},include:{roles:true,scopes:true}});
 const inv=await createCompanyDriverInvitation(mockDb,a.actor,driverInput({email:b.actor.email}));
 await unchanged(()=>acceptCompanyDriverInvitation(mockDb,{token:inv.token,operationId:randomUUID(),name:"adopt",password}));
 await unchanged(()=>acceptCompanyDriverInvitation(mockDb,{token:inv.token,operationId:randomUUID()},a.login.token));
 const accepted=await acceptCompanyDriverInvitation(mockDb,{token:inv.token,operationId:randomUUID()},b.login.token),e={accepted};
 await mutateCompanyDriverEligibility(mockDb,a.actor,change(e));
 await mutateCompanyDriverEligibility(mockDb,a.actor,change(e,{action:"revoke"}));
 expect(await mockDb.companyMembership.findUniqueOrThrow({where:{id:b.companyMembershipId},include:{roles:true,scopes:true}})).toEqual(beforeOther);
 expect((await mockDb.user.findUniqueOrThrow({where:{id:b.actor.id}})).password).toBe(old.password);expect(await hasLiveAccessSession(jwt.decode(b.login.token) as any)).toBe(true);
});
it("concurrent acceptance produces one identity/eligibility/action; authenticated matching retry succeeds",async()=>{
 const a=await driverAdmin(),input=driverInput(),inv=await createCompanyDriverInvitation(mockDb,a.actor,input),op=randomUUID(),before=await counts();
 const settled=await Promise.allSettled([1,2].map(()=>acceptCompanyDriverInvitation(mockDb,{token:inv.token,operationId:op,name:"concurrent",password})));
 expect(settled.filter(x=>x.status==="fulfilled")).toHaveLength(1);expect(settled.filter(x=>x.status==="rejected")).toHaveLength(1);
 const after=await counts();for(const table of ["User","CompanyMembership","CompanyDriverEligibility","CompanyDriverAction"])expect(after[table]-before[table]).toBe(1);
 const login=await loginUser({email:input.email,password});expect(await acceptCompanyDriverInvitation(mockDb,{token:inv.token,operationId:op},login.token)).toEqual((settled.find(x=>x.status==="fulfilled") as PromiseFulfilledResult<any>).value);
});
it("cancelled/expired/reused invitation and revoked inviter authority reject without enrollment",async()=>{
 const a=await driverAdmin(),first=await createCompanyDriverInvitation(mockDb,a.actor,driverInput());
 await cancelCompanyDriverInvitation(mockDb,a.actor,{operationId:randomUUID(),invitationId:first.invitationId,reason:"Synthetic cancellation"});
 await unchanged(()=>acceptCompanyDriverInvitation(mockDb,{token:first.token,operationId:randomUUID(),name:"cancelled",password}));
 const expired=await createCompanyDriverInvitation(mockDb,a.actor,driverInput());await pool.query(`UPDATE "CompanyDriverInvitation" SET "expiresAt"=now()-interval '1 second' WHERE id=$1`,[expired.invitationId]);
 await unchanged(()=>acceptCompanyDriverInvitation(mockDb,{token:expired.token,operationId:randomUUID(),name:"expired",password}));
 const pending=await createCompanyDriverInvitation(mockDb,a.actor,driverInput());await authorizeCompanyDriverDelegator(mockDb,driverOwner.request(a.companyMembershipId,undefined,"operator-revoke"));
 await unchanged(()=>acceptCompanyDriverInvitation(mockDb,{token:pending.token,operationId:randomUUID(),name:"revoked",password}));
});
it("foreign context/targets and narrower replacement ceilings reject; matching grant receipt rechecks actor authority",async()=>{
 const a=await driverAdmin(),e=await enroll(a),b=await driverAdmin(["local-driver.v1"]);driverOwner.register();
 await unchanged(()=>mutateCompanyDriverEligibility(mockDb,b.actor,change(e)));
 await unchanged(()=>createCompanyDriverInvitation(mockDb,{...a.actor,tenantId:b.tenantId},driverInput()));
 const c=change(e);await mutateCompanyDriverEligibility(mockDb,a.actor,c);const before=await graphDigest();expect(await mutateCompanyDriverEligibility(mockDb,a.actor,c)).toMatchObject({profileRevision:"linehaul-driver.v1"});expect(await graphDigest()).toBe(before);
 await authorizeCompanyDriverDelegator(mockDb,driverOwner.request(a.companyMembershipId,["local-driver.v1"]));
 await unchanged(()=>mutateCompanyDriverEligibility(mockDb,a.actor,change(e,{profileRevision:"local-driver.v1"})));
 await unchanged(()=>mutateCompanyDriverEligibility(mockDb,a.actor,c));
});
it("enrollment and profile mutations roll back memberships/roles/eligibility/version/sessions/audit together",async()=>{
 const a=await driverAdmin(),e=await enroll(a),inv=await createCompanyDriverInvitation(mockDb,a.actor,driverInput());
 await pool.query(`CREATE FUNCTION cp_driver_fail() RETURNS trigger LANGUAGE plpgsql AS $driver_test$ BEGIN RAISE EXCEPTION 'Synthetic driver rollback'; END $driver_test$; CREATE TRIGGER cp_driver_fail BEFORE INSERT ON "CompanyDriverAction" FOR EACH ROW EXECUTE FUNCTION cp_driver_fail()`);
 try {await unchanged(()=>acceptCompanyDriverInvitation(mockDb,{token:inv.token,operationId:randomUUID(),name:"rollback",password}));await unchanged(()=>mutateCompanyDriverEligibility(mockDb,a.actor,change(e)));}finally{await pool.query('DROP TRIGGER cp_driver_fail ON "CompanyDriverAction"; DROP FUNCTION cp_driver_fail()');}
});
it("eligibility ignores forged shared user type and token metadata; unmanaged scopes/roles fail closed",async()=>{
 const a=await driverAdmin(),e=await enroll(a);await mockDb.user.update({where:{id:e.accepted.userId},data:{driverType:"linehaul"}});
 expect((await requireAcceptedDriver(mockDb,e.accepted,e.accepted.companyMembershipId,"local")).driverType).toBe("local");
 await expect(requireAcceptedDriver(mockDb,e.accepted,e.accepted.companyMembershipId,"linehaul")).rejects.toThrow();
 await mockDb.membershipScope.create({data:{membershipId:e.accepted.companyMembershipId,scopeType:"company",scopeRefId:a.companyId}});
 expect(await loadAccessSnapshot({...e.login.user,membershipId:e.accepted.companyMembershipId,requireFresh:true})).toBeNull();
 await unchanged(()=>mutateCompanyDriverEligibility(mockDb,a.actor,change(e)));
});
it("compound bridges and immutable driver action journal reject foreign updates/delete/truncate",async()=>{
 const a=await driverAdmin(),e=await enroll(a),b=await driverAdmin();
 for(const sql of ['UPDATE "CompanyDriverEligibility" SET "tenantId"=$1 WHERE "membershipId"=$2','UPDATE "CompanyDriverEligibility" SET "companyId"=$1 WHERE "membershipId"=$2','UPDATE "CompanyDriverEligibility" SET "acceptedOperationId"=$1 WHERE "membershipId"=$2']){
 const before=await graphDigest();await expect(pool.query(sql,[sql.includes('"tenantId"')?b.tenantId:b.companyId,e.accepted.companyMembershipId])).rejects.toThrow();expect(await graphDigest()).toBe(before);}
 for(const sql of [`UPDATE "CompanyDriverAction" SET reason='tampered'`,'DELETE FROM "CompanyDriverAction"','TRUNCATE "CompanyDriverAction"']){const before=await graphDigest();await expect(pool.query(sql)).rejects.toThrow();expect(await graphDigest()).toBe(before);}
});

import { fork, ChildProcess } from "child_process";
import path from "path";
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

it("driver revocation invalidates actual HTTP tokens and existing sockets in two processes without changing another company",async()=>{
 const a=await driverAdmin(),e=await enroll(a),app=Fastify();
 for(const permission of ["drivers.telemetry","shipment.changeStatus","shipment.update","shipment.view","shipment.assignCourier"])
 app.get('/'+permission,{preHandler:fastifyAuth({permission})},async()=>({ok:true}));
 try{
 for(const permission of ["drivers.telemetry","shipment.changeStatus"]){const response=await app.inject({url:'/'+permission,headers:{authorization:'Bearer '+e.login.token}});expect(response.statusCode).toBe(200);}
 for(const permission of ["shipment.update","shipment.view","shipment.assignCourier"]){const before=await graphDigest();expect((await app.inject({url:'/'+permission,headers:{authorization:'Bearer '+e.login.token}})).statusCode).toBe(403);expect(await graphDigest()).toBe(before);}
 for(const operation of [collectOrderCash,handoffOrderCash,settleOrderCash]) {
  const before=await graphDigest();
  await expect(operation({actor:e.actor,orderId:randomUUID(),kind:"cod",operationId:randomUUID(),expectedEventId:randomUUID()})).rejects.toThrow("Cash permission required");
  expect(await graphDigest()).toBe(before);
 }
 await withSocketPeers(async(peers,wires)=>{
 for(const peer of peers)wires.push(await connectWire(peer,e.login.token));
 await mutateCompanyDriverEligibility(mockDb,a.actor,change(e,{action:"revoke",profileRevision:"local-driver.v1"}));
 expect(await hasLiveAccessSession(jwt.decode(e.login.token) as any)).toBe(false);
 expect((await app.inject({url:'/drivers.telemetry',headers:{authorization:'Bearer '+e.login.token}})).statusCode).toBe(401);
 await Promise.all(wires.map(w=>awaitClosed(w)));
 await expect(listCustodyWork(e.actor,{kind:"driver"})).rejects.toThrow();
 await expect(acceptCompanyDriverInvitation(mockDb,{token:e.invitation.token,operationId:e.op},e.login.token)).rejects.toThrow();
 });
 }finally{await app.close();}
});
it("one human can be local in A and linehaul in B; revocation of A preserves B eligibility and session",async()=>{
 const a=await driverAdmin(),e=await enroll(a),b=await driverAdmin();
 const inv=await createCompanyDriverInvitation(mockDb,b.actor,driverInput({email:e.input.email,profileRevision:"linehaul-driver.v1"}));
 const accepted=await acceptCompanyDriverInvitation(mockDb,{token:inv.token,operationId:randomUUID()},e.login.token);
 const loginB=await loginUser({email:e.input.email,password,companyMembershipId:accepted.companyMembershipId});
 expect((await requireAcceptedDriver(mockDb,e.accepted,e.accepted.companyMembershipId)).driverType).toBe("local");
 expect((await requireAcceptedDriver(mockDb,accepted,accepted.companyMembershipId)).driverType).toBe("linehaul");
 await expect(loginUser({email:e.input.email,password})).rejects.toMatchObject({code:"MEMBERSHIP_SELECTION_REQUIRED"});
 await mutateCompanyDriverEligibility(mockDb,a.actor,change(e,{action:"revoke",profileRevision:"local-driver.v1"}));
 expect(await hasLiveAccessSession(jwt.decode(e.login.token) as any)).toBe(false);
 expect(await hasLiveAccessSession(jwt.decode(loginB.token) as any)).toBe(true);
 expect((await requireAcceptedDriver(mockDb,accepted,accepted.companyMembershipId)).driverType).toBe("linehaul");
 expect((await loginUser({email:e.input.email,password})).user.companyMembershipId).toBe(accepted.companyMembershipId);
});
it("disabled tenant/company, wrong bridge and legacy unaccepted driver classification never establish eligibility",async()=>{
 const a=await driverAdmin(),e=await enroll(a);
 await mockDb.tenant.update({where:{id:a.tenantId},data:{status:"suspended"}});
 try {await unchanged(()=>listCustodyWork(e.actor,{kind:"driver"})); await unchanged(()=>mutateCompanyDriverEligibility(mockDb,a.actor,change(e)));}
 finally {await mockDb.tenant.update({where:{id:a.tenantId},data:{status:"active"}});}
 await mockDb.organization.update({where:{id:a.companyId},data:{isActive:false}});
 try {await unchanged(()=>requireAcceptedDriver(mockDb,e.accepted,e.accepted.companyMembershipId));}
 finally {await mockDb.organization.update({where:{id:a.companyId},data:{isActive:true}});}
 await unchanged(()=>requireAcceptedDriver(mockDb,{...e.accepted,companyId:randomUUID()},e.accepted.companyMembershipId));
 await mockDb.user.update({where:{id:a.userId},data:{driverType:"local"}});
 await unchanged(()=>requireAcceptedDriver(mockDb,a,a.companyMembershipId));
});
