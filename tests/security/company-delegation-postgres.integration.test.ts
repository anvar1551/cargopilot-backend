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
const tables = ["Tenant", "Organization", "User", "TenantMembership", "CompanyMembership", "Role", "RolePermission", "MembershipRole", "MembershipScope", "TenantOnboardingReceipt", "CompanyDelegationAuthority", "CompanyInvitation", "CompanyOperationalGrant", "CompanyDelegationAction", "UserRefreshSession", "CredentialSecurityEvent"];
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
async function admin() { const args = request(), result = await onboardTenant(mockDb, args); const login = await loginUser({ email: args.intent.administrator.email, password }); return { ...result, actor: { ...login.user, id: login.user.userId }, login }; }
const inviteInput = (extra: any = {}) => ({ operationId: randomUUID(), email: randomUUID() + "@example.invalid", profileRevision: "operational-clerk.v1", warehouseIds: [], reason: "Synthetic approved invitation", ...extra });
async function enrolled(a: any, extra: any = {}) { const input = inviteInput(extra), invitation = await createCompanyInvitation(mockDb, a.actor, input); const pass = randomUUID() + "-synthetic"; const accepted = await acceptCompanyInvitation(mockDb, { token: invitation.token, operationId: randomUUID(), name: "Synthetic recipient", password: pass }); return { input, invitation, accepted, pass }; }
function ownerRequest(membershipId: string, warehouseIds: string[] = [], action = "operator-authorize") { const intent = { operationId: randomUUID(), membershipId, action, warehouseIds, ceilingRevision: DELEGATION_REVISION, profileRevision: ONBOARDING_PROFILE_V2, reason: "Synthetic reviewed owner authority" }; const now = Date.now(); const permit = { version: 1, operatorId: ONBOARDING_OPERATOR, keyFingerprint, operationId: intent.operationId, intentFingerprint: delegationFingerprint("operator-authority", intent), profileRevision: ONBOARDING_PROFILE_V2, issuedAt: new Date(now).toISOString(), expiresAt: new Date(now + 240000).toISOString() }; return { intent, permit, signature: sign(null, Buffer.from(canonicalOnboardingPermit(permit)), keys.privateKey).toString("base64") }; }
async function graphDigest() { const graph: Record<string, unknown> = {}; for (const table of tables)
    graph[table] = (await pool.query(`SELECT to_jsonb(record) AS row FROM "${table}" AS record ORDER BY to_jsonb(record)::text`)).rows; return createHash("sha256").update(JSON.stringify(graph)).digest("hex"); }
async function unchanged(work: () => Promise<unknown>) { const before = await graphDigest(); await expect(work()).rejects.toThrow(); expect(await graphDigest()).toBe(before); }
it("v2 creates separate accepted authority; v1 stays exactly six grants with no automatic ceiling", async () => {
    const a = await admin();
    const auth = await pool.query('SELECT * FROM "CompanyDelegationAuthority" WHERE "membershipId"=$1', [a.companyMembershipId]);
    expect(auth.rows[0].warehouseIds).toEqual([]);
    expect(a.actor.permissionCodes.sort()).toEqual([...ONBOARDING_PERMISSIONS, "membership.invite", "membership.delegateOperational"].sort());
    writeFileSync(registryPath, JSON.stringify({ ...registry, profileRevision: ONBOARDING_PROFILE }));
    const args = request();
    args.intent.profileRevision = ONBOARDING_PROFILE;
    const permit = { ...args.permit, profileRevision: ONBOARDING_PROFILE, intentFingerprint: normalizeTenantOnboardingIntent(args.intent).fingerprint };
    args.permit = permit;
    args.signature = sign(null, Buffer.from(canonicalOnboardingPermit(permit)), keys.privateKey).toString("base64");
    const b = await onboardTenant(mockDb, args);
    expect((await pool.query('SELECT * FROM "CompanyDelegationAuthority" WHERE "membershipId"=$1', [b.companyMembershipId])).rows).toHaveLength(0);
});
it("new enrollment/login creates only the approved profile, matching invitation retry has no token and conflicts reject", async () => {
    const a = await admin(), input = inviteInput(), first = await createCompanyInvitation(mockDb, a.actor, input), before = await counts();
    const retry = await createCompanyInvitation(mockDb, a.actor, { ...input, email: input.email.toUpperCase() });
    expect(retry.token).toBeUndefined();
    expect(retry.invitationId).toBe(first.invitationId);
    expect(await counts()).toEqual(before);
    await unchanged(() => createCompanyInvitation(mockDb, a.actor, { ...input, profileRevision: "operational-dispatcher.v1" }));
    const op = randomUUID(), result = await acceptCompanyInvitation(mockDb, { token: first.token, operationId: op, name: "Synthetic", password });
    const login = await loginUser({ email: input.email, password });
    expect(login.user.companyMembershipId).toBe(result.companyMembershipId);
    expect(login.user.permissionCodes.sort()).toEqual([...ONBOARDING_PERMISSIONS].sort());
    const graph = await counts();
    expect(await acceptCompanyInvitation(mockDb, { token: first.token, operationId: op }, login.token)).toEqual(result);
    expect(await counts()).toEqual(graph);
    await unchanged(() => acceptCompanyInvitation(mockDb, { token: first.token, operationId: randomUUID() }, login.token));
});
it("existing recipient must authenticate exact identity; no password replacement or email adoption", async () => {
    const a = await admin(), b = await admin(), input = inviteInput({ email: b.actor.email }), inv = await createCompanyInvitation(mockDb, a.actor, input);
    await unchanged(() => acceptCompanyInvitation(mockDb, { token: inv.token, operationId: randomUUID(), name: "Adopt", password }));
    await unchanged(() => acceptCompanyInvitation(mockDb, { token: inv.token, operationId: randomUUID() }, a.login.token));
    await unchanged(() => acceptCompanyInvitation(mockDb, { token: inv.token, operationId: randomUUID() }, jwt.sign({ ...jwt.decode(b.login.token) as object, id: a.actor.id }, process.env.JWT_SECRET!)));
    const old = await mockDb.user.findUniqueOrThrow({ where: { id: b.actor.id } });
    const accepted = await acceptCompanyInvitation(mockDb, { token: inv.token, operationId: randomUUID() }, b.login.token);
    expect(accepted.userId).toBe(b.actor.id);
    expect((await mockDb.user.findUniqueOrThrow({ where: { id: b.actor.id } })).password).toBe(old.password);
});
it("concurrent token acceptance creates one membership/grant/audit and no duplicate graph", async () => {
    const a = await admin(), input = inviteInput(), inv = await createCompanyInvitation(mockDb, a.actor, input), before = await counts();
    const body = { token: inv.token, operationId: randomUUID(), name: "Concurrent", password };
    const results = await Promise.allSettled([acceptCompanyInvitation(mockDb, body), acceptCompanyInvitation(mockDb, body)]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(r => r.status === "rejected")).toHaveLength(1);
    const after = await counts();
    expect(after.User - before.User).toBe(1);
    expect(after.CompanyMembership - before.CompanyMembership).toBe(1);
    expect(after.CompanyOperationalGrant - before.CompanyOperationalGrant).toBe(1);
    expect(after.CompanyDelegationAction - before.CompanyDelegationAction).toBe(1);
});
it("ceilings, foreign warehouse scopes, forbidden profiles and self grants deny without effects", async () => {
    const a = await admin(), b = await admin();
    await unchanged(() => createCompanyInvitation(mockDb, a.actor, inviteInput({ email: a.actor.email })));
    await unchanged(() => createCompanyInvitation(mockDb, a.actor, inviteInput({ profileRevision: "finance-checker.v1" })));
    await unchanged(() => createCompanyInvitation(mockDb, a.actor, inviteInput({ profileRevision: "operational-warehouse.v1", warehouseIds: [randomUUID()] })));
    await unchanged(() => createCompanyInvitation(mockDb, { ...a.actor, tenantId: b.tenantId }, inviteInput()));
    await unchanged(() => mutateCompanyOperationalGrant(mockDb, a.actor, { operationId: randomUUID(), membershipId: a.companyMembershipId, action: "grant", profileRevision: "operational-clerk.v1", warehouseIds: [], reason: "self" }));
    const w = await mockDb.warehouse.create({ data: { name: "Synthetic warehouse", location: "Synthetic foreign location", tenantId: b.tenantId } });
    await unchanged(() => authorizeCompanyDelegator(mockDb, ownerRequest(a.companyMembershipId, [w.id])));
});
it("owner authorizes exact warehouse ceiling; scoped enrollment excludes company access; targets remain company-bound", async () => {
    const a = await admin(), b = await admin();
    const w = await mockDb.warehouse.create({ data: { name: "Synthetic owned", location: "Synthetic owned location", tenantId: a.tenantId } });
    const permit = ownerRequest(a.companyMembershipId, [w.id]);
    await authorizeCompanyDelegator(mockDb, permit);
    const before = await counts();
    expect(await authorizeCompanyDelegator(mockDb, permit)).toMatchObject({ enabled: true });
    expect(await counts()).toEqual(before);
    const e = await enrolled(a, { profileRevision: "operational-warehouse.v1", warehouseIds: [w.id] });
    const login = await loginUser({ email: e.input.email, password: e.pass });
    expect(login.user.scopes).toEqual([{ scopeType: "warehouse", scopeRefId: w.id }]);
    expect(login.user.permissionCodes).not.toContain("membership.delegateOperational");
    await unchanged(() => mutateCompanyOperationalGrant(mockDb, b.actor, { operationId: randomUUID(), membershipId: e.accepted.companyMembershipId, action: "revoke", profileRevision: "operational-warehouse.v1", warehouseIds: [w.id], reason: "foreign" }));
});
it.each(["expired", "cancelled", "revoked-inviter"])("%s invitation rejects before membership writes", async (kind) => {
    const a = await admin(), input = inviteInput(), inv = await createCompanyInvitation(mockDb, a.actor, input);
    if (kind === "expired")
        await pool.query(`UPDATE "CompanyInvitation" SET "expiresAt"=now()-interval '1 second' WHERE id=$1`, [inv.invitationId]);
    if (kind === "cancelled")
        await cancelCompanyInvitation(mockDb, a.actor, { operationId: randomUUID(), invitationId: inv.invitationId, reason: "delivery cancelled" });
    if (kind === "revoked-inviter")
        await authorizeCompanyDelegator(mockDb, ownerRequest(a.companyMembershipId, [], "operator-revoke"));
    await unchanged(() => acceptCompanyInvitation(mockDb, { token: inv.token, operationId: randomUUID(), name: "Rejected", password }));
});
it("profile replacement/revocation atomically disables old HTTP/session authority without touching another company", async () => {
    const a = await admin(), e = await enrolled(a);
    const login = await loginUser({ email: e.input.email, password: e.pass });
    const claims = jwt.decode(login.token) as any;
    expect(await hasLiveAccessSession(claims)).toBe(true);
    const app = Fastify();
    app.get('/protected', { preHandler: fastifyAuth({ permission: "shipment.create" }) }, async () => ({ ok: true }));
    try {
        expect((await app.inject({ url: '/protected', headers: { authorization: 'Bearer ' + login.token } })).statusCode).toBe(200);
        const input = { operationId: randomUUID(), membershipId: e.accepted.companyMembershipId, action: "grant", profileRevision: "operational-dispatcher.v1", warehouseIds: [], reason: "operational change" };
        await mutateCompanyOperationalGrant(mockDb, a.actor, input);
        expect(await hasLiveAccessSession(claims)).toBe(false);
        expect((await app.inject({ url: '/protected', headers: { authorization: 'Bearer ' + login.token } })).statusCode).toBe(401);
        const updated = await loginUser({ email: e.input.email, password: e.pass });
        expect(updated.user.permissionCodes).toContain('shipment.assignCourier');
        expect(updated.user.permissionCodes).not.toContain('shipment.create');
        const before = await counts();
        expect(await mutateCompanyOperationalGrant(mockDb, a.actor, input)).toMatchObject({ action: 'grant' });
        expect(await counts()).toEqual(before);
        await unchanged(() => mutateCompanyOperationalGrant(mockDb, a.actor, { ...input, profileRevision: 'operational-clerk.v1' }));
        await mutateCompanyOperationalGrant(mockDb, a.actor, { ...input, operationId: randomUUID(), action: 'revoke' });
        expect(await hasLiveAccessSession(jwt.decode(updated.token) as any)).toBe(false);
        expect(await hasLiveAccessSession(jwt.decode(a.login.token) as any)).toBe(true);
        const m = await mockDb.companyMembership.findUniqueOrThrow({ where: { id: e.accepted.companyMembershipId }, include: { roles: true, scopes: true } });
        expect(m.roles).toHaveLength(0);
        expect(m.scopes).toHaveLength(0);
    }
    finally {
        await app.close();
    }
});
it("injected accepted-audit failure rolls back identity, grants, token consumption and receipts", async () => {
    const a = await admin(), input = inviteInput(), inv = await createCompanyInvitation(mockDb, a.actor, input);
    await pool.query(`CREATE FUNCTION cp_delegation_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='accept' THEN RAISE EXCEPTION 'synthetic failure'; END IF; RETURN NEW; END; $$; CREATE TRIGGER cp_delegation_fail BEFORE INSERT ON "CompanyDelegationAction" FOR EACH ROW EXECUTE FUNCTION cp_delegation_fail();`);
    try {
        await unchanged(() => acceptCompanyInvitation(mockDb, { token: inv.token, operationId: randomUUID(), name: "Rollback", password }));
        expect((await pool.query('SELECT state FROM "CompanyInvitation" WHERE id=$1', [inv.invitationId])).rows[0].state).toBe('pending');
    }
    finally {
        await pool.query('DROP TRIGGER cp_delegation_fail ON "CompanyDelegationAction"; DROP FUNCTION cp_delegation_fail();');
    }
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
it("managed-grant revocation disconnects existing sockets in two real isolated processes", async () => withSocketPeers(async (peers, wires) => { const a = await admin(), e = await enrolled(a), login = await loginUser({ email: e.input.email, password: e.pass }); for (const peer of peers)
    wires.push(await connectWire(peer, login.token)); await mutateCompanyOperationalGrant(mockDb, a.actor, { operationId: randomUUID(), membershipId: e.accepted.companyMembershipId, action: "revoke", profileRevision: "operational-clerk.v1", warehouseIds: [], reason: "Synthetic controlled revocation" }); await Promise.all(wires.map(wire => awaitClosed(wire, 15000))); expect(await hasLiveAccessSession(jwt.decode(login.token) as any)).toBe(false); }));
import authRoutes from "../../src/modules/identity-access/transport/fastify-routes";
import { BoundedLocalRateLimitStore, createAbuseRateLimiter } from "../../src/shared/http/abuseRateLimit";
it("actual invitation HTTP contracts enforce authority, safe errors and explicit authenticated acceptance", async () => {
    const a = await admin(), app = Fastify();
    await app.register(authRoutes, { prefix: '/api/auth', rateLimiter: createAbuseRateLimiter({ sharedStore: new BoundedLocalRateLimitStore() }) });
    try {
        const input = inviteInput();
        const denied = await app.inject({ method: 'POST', url: '/api/auth/company-invitations', payload: input });
        expect(denied.statusCode).toBe(401);
        const created = await app.inject({ method: 'POST', url: '/api/auth/company-invitations', headers: { authorization: 'Bearer ' + a.login.token }, payload: input });
        expect(created.statusCode).toBe(200);
        expect(created.headers['cache-control']).toBe('no-store');
        const invite = created.json();
        const accepted = await app.inject({ method: 'POST', url: '/api/auth/company-invitations/accept', payload: { token: invite.token, operationId: randomUUID(), name: 'Synthetic HTTP recipient', password } });
        expect(accepted.statusCode).toBe(200);
        expect(accepted.json()).not.toHaveProperty('password');
        const invalid = await app.inject({ method: 'POST', url: '/api/auth/company-invitations/accept', payload: { token: invite.token, operationId: randomUUID(), password, unknownSecret: 'never echo' } });
        expect(invalid.statusCode).toBe(400);
        expect(invalid.body).not.toContain(invite.token);
        expect(invalid.body).not.toContain(password);
        expect(invalid.body).not.toContain('never echo');
    }
    finally {
        await app.close();
    }
});
it("concurrent matching grants commit one authorization revision and one action receipt", async () => { const a = await admin(), e = await enrolled(a); const input = { operationId: randomUUID(), membershipId: e.accepted.companyMembershipId, action: "grant", profileRevision: "operational-dispatcher.v1", warehouseIds: [], reason: "Concurrent grant" }; const before = await counts(), version = (await mockDb.companyMembership.findUniqueOrThrow({ where: { id: e.accepted.companyMembershipId } })).authorizationVersion; const results = await Promise.all([mutateCompanyOperationalGrant(mockDb, a.actor, input), mutateCompanyOperationalGrant(mockDb, a.actor, input)]); expect(results[0]).toEqual(results[1]); expect((await counts()).CompanyDelegationAction - before.CompanyDelegationAction).toBe(1); expect((await mockDb.companyMembership.findUniqueOrThrow({ where: { id: e.accepted.companyMembershipId } })).authorizationVersion).toBe(version + 1); });
it("grant and revocation audit failures roll back roles, scopes, version and sessions", async () => { const a = await admin(), e = await enrolled(a); const login = await loginUser({ email: e.input.email, password: e.pass }); await pool.query(`CREATE FUNCTION cp_grant_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action IN ('grant','revoke') THEN RAISE EXCEPTION 'synthetic failure'; END IF; RETURN NEW; END; $$; CREATE TRIGGER cp_grant_fail BEFORE INSERT ON "CompanyDelegationAction" FOR EACH ROW EXECUTE FUNCTION cp_grant_fail();`); try {
    for (const action of ['grant', 'revoke'])
        await unchanged(() => mutateCompanyOperationalGrant(mockDb, a.actor, { operationId: randomUUID(), membershipId: e.accepted.companyMembershipId, action, profileRevision: 'operational-clerk.v1', warehouseIds: [], reason: 'Injected rollback' }));
    expect(await hasLiveAccessSession(jwt.decode(login.token) as any)).toBe(true);
}
finally {
    await pool.query('DROP TRIGGER cp_grant_fail ON "CompanyDelegationAction"; DROP FUNCTION cp_grant_fail();');
} });
it("missing context, unsupported driver profile, actor without accepted ceiling and unmanaged scopes reject", async () => { const a = await admin(), e = await enrolled(a), login = await loginUser({ email: e.input.email, password: e.pass }); await unchanged(() => createCompanyInvitation(mockDb, { ...a.actor, tenantId: "" }, inviteInput())); await unchanged(() => createCompanyInvitation(mockDb, a.actor, inviteInput({ profileRevision: 'driver.v1' }))); await unchanged(() => createCompanyInvitation(mockDb, { ...login.user, id: login.user.userId }, inviteInput())); await mockDb.membershipScope.create({ data: { membershipId: e.accepted.companyMembershipId, scopeType: 'warehouse', scopeRefId: randomUUID() } }); await unchanged(() => mutateCompanyOperationalGrant(mockDb, a.actor, { operationId: randomUUID(), membershipId: e.accepted.companyMembershipId, action: 'grant', profileRevision: 'operational-dispatcher.v1', warehouseIds: [], reason: 'Do not delete unmanaged scope' })); });
it("new delegation audit rejects UPDATE DELETE TRUNCATE and binds operator fingerprint", async () => { const a = await admin(); const receipt = (await pool.query(`SELECT "operatorKeyFingerprint" FROM "CompanyDelegationAction" WHERE "targetMembershipId"=$1 AND action='operator-authorize'`, [a.companyMembershipId])).rows[0]; expect(receipt.operatorKeyFingerprint).toBe(keyFingerprint); for (const statement of [`UPDATE "CompanyDelegationAction" SET reason='tamper'`, 'DELETE FROM "CompanyDelegationAction"', 'TRUNCATE "CompanyDelegationAction"'])
    await unchanged(() => pool.query(statement)); });

import { refreshUserSession, revokeRefreshSession } from "../../src/modules/identity-access/application/auth.service";
it("authenticated acceptance preserves live refresh lineage and rejects successor logout",async()=>{const a=await admin(),b=await admin(),input=inviteInput({email:b.actor.email}),inv=await createCompanyInvitation(mockDb,a.actor,input);const rotated=await refreshUserSession({refreshToken:b.login.refreshToken});expect(await hasLiveAccessSession(jwt.decode(b.login.token) as any)).toBe(true);const accepted=await acceptCompanyInvitation(mockDb,{token:inv.token,operationId:randomUUID()},b.login.token);expect(accepted.userId).toBe(b.actor.id);const d=await admin(),other=await createCompanyInvitation(mockDb,d.actor,inviteInput({email:b.actor.email}));await revokeRefreshSession(rotated.refreshToken);await unchanged(()=>acceptCompanyInvitation(mockDb,{token:other.token,operationId:randomUUID()},b.login.token));});

it("recipient audit compound constraint preserves actual acceptance and rejects a different user",async()=>{const a=await admin(),b=await admin(),e=await enrolled(a),before=await graphDigest();await expect(pool.query(`INSERT INTO "CompanyDelegationAction" ("operationId","tenantId","companyId",action,fingerprint,"actorUserId","actorMembershipId","targetMembershipId","recipientUserId",reason,result) VALUES ($1,$2,$3,'accept',$4,$5,$6,$7,$8,'Synthetic invalid recipient','{}')`,[randomUUID(),a.tenantId,a.companyId,'a'.repeat(64),a.actor.id,a.companyMembershipId,e.accepted.companyMembershipId,b.actor.id])).rejects.toMatchObject({code:'23503',constraint:'CompanyDelegationAction_recipient_context_fkey'});expect(await graphDigest()).toBe(before);const row=await pool.query(`SELECT "recipientUserId" FROM "CompanyDelegationAction" WHERE "targetMembershipId"=$1 AND action='accept'`,[e.accepted.companyMembershipId]);expect(row.rows[0].recipientUserId).toBe(e.accepted.userId);});

it("same recipient retains other-company sessions while foreign-company grant mutation rejects",async()=>{const a=await admin(),b=await admin(),input=inviteInput({email:b.actor.email}),inv=await createCompanyInvitation(mockDb,a.actor,input),accepted=await acceptCompanyInvitation(mockDb,{token:inv.token,operationId:randomUUID()},b.login.token);const action={operationId:randomUUID(),membershipId:accepted.companyMembershipId,action:'revoke',profileRevision:'operational-clerk.v1',warehouseIds:[],reason:'Company-bound revocation'};const foreign=await admin(),before=await graphDigest();await expect(mutateCompanyOperationalGrant(mockDb,b.actor,action)).rejects.toMatchObject({code:'DELEGATION_TARGET_REJECTED'});expect(await graphDigest()).toBe(before);await expect(mutateCompanyOperationalGrant(mockDb,foreign.actor,action)).rejects.toMatchObject({code:'DELEGATION_FOREIGN_TARGET'});expect(await graphDigest()).toBe(before);const selected=await loginUser({email:b.actor.email,password,companyMembershipId:accepted.companyMembershipId});await mutateCompanyOperationalGrant(mockDb,a.actor,{...action,operationId:randomUUID()});expect(await hasLiveAccessSession(jwt.decode(selected.token) as any)).toBe(false);expect(await hasLiveAccessSession(jwt.decode(b.login.token) as any)).toBe(true);const refreshed=await refreshUserSession({refreshToken:b.login.refreshToken});expect(refreshed.user.companyMembershipId).toBe(b.companyMembershipId);});

// Test-only barriers wrap actual Prisma transactions/SQL, never replace results.
// Every wait is bounded and released in finally; no production scheduling hooks.
function queryBarrier(match: (sql: string) => boolean, method = "$queryRaw") {
    let signal!: () => void, resume!: () => void, used = false;
    const reached = new Promise<void>(resolve => { signal = resolve; });
    const releaseGate = new Promise<void>(resolve => { resume = resolve; });
    const db = new Proxy(mockDb, { get(target, key) {
        if (key === "$transaction") return (work: any, options: any) => target.$transaction(async tx => {
            const wrapped = new Proxy(tx, { get(source, field) {
                const value = (source as any)[field];
                if (field === method) return async (...args: any[]) => {
                    const result = await value.apply(source, args);
                    const sql = Array.isArray(args[0]) ? args[0].join("?") : args[0]?.sql ?? "";
                    if (!used && match(sql)) { used = true; signal(); await bounded(releaseGate); }
                    return result;
                };
                return typeof value === "function" ? value.bind(source) : value;
            } });
            return work(wrapped);
        }, options);
        const value = (target as any)[key]; return typeof value === "function" ? value.bind(target) : value;
    } });
    return { db, reached: () => bounded(reached), release: resume };
}
async function bounded<T>(work: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error("Test barrier deadline exceeded")), 5000); })]); }
    finally { clearTimeout(timer); }
}
function taggedTransactions(applicationName: string) {
    return new Proxy(mockDb, { get(target, key) {
        if (key === "$transaction") return (work: any, options: any) => target.$transaction(async tx => {
            await tx.$queryRaw`SELECT set_config('application_name',${applicationName},true)`;
            return work(tx);
        }, options);
        const value = (target as any)[key]; return typeof value === "function" ? value.bind(target) : value;
    } });
}
async function waitForDatabaseBlock(applicationName: string) {
    for (let i = 0; i < 50; i++) {
        const result = await pool.query('SELECT pid FROM pg_stat_activity WHERE application_name=$1 AND cardinality(pg_blocking_pids(pid))>0', [applicationName]);
        if (result.rows.length) return;
        await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw Error("Expected competing transaction was not blocked in PostgreSQL");
}

it("review correction: cancellation commits between initial lookup and locked acceptance decision", async () => {
    const a = await admin(), input = inviteInput(), inv = await createCompanyInvitation(mockDb, a.actor, input);
    const barrier = queryBarrier(sql => sql.includes('FROM "CompanyInvitation" WHERE "tokenHash"'));
    const acceptance = acceptCompanyInvitation(barrier.db, { token: inv.token, operationId: randomUUID(), name: "Cancelled recipient", password });
    const outcome = acceptance.then(value => ({ value }), error => ({ error }));
    try {
        await barrier.reached();
        expect(await cancelCompanyInvitation(mockDb, a.actor, { operationId: randomUUID(), invitationId: inv.invitationId, reason: "Cancel while acceptance is paused" })).toMatchObject({ state: "cancelled" });
        const graph = await graphDigest(); barrier.release();
        expect(await outcome).toMatchObject({ error: { code: "INVITATION_UNAVAILABLE" } });
        expect(await graphDigest()).toBe(graph);
        expect(await mockDb.user.count({ where: { email: input.email } })).toBe(0);
    } finally { barrier.release(); await outcome; }
});

it("review correction: acceptance holds authority and invitation until commit; cancellation cannot succeed", async () => {
    const a = await admin(), input = inviteInput(), inv = await createCompanyInvitation(mockDb, a.actor, input);
    const barrier = queryBarrier(sql => sql.includes('SET state=\'accepted\''), "$executeRaw");
    const op = randomUUID(), acceptance = acceptCompanyInvitation(barrier.db, { token: inv.token, operationId: op, name: "Accepted recipient", password });
    const accepted = acceptance.then(value => ({ value }), error => ({ error }));
    let cancellation: Promise<any> | undefined;
    try {
        await barrier.reached();
        const tag = "cp-cancel-" + randomUUID();
        cancellation = cancelCompanyInvitation(taggedTransactions(tag), a.actor, { operationId: randomUUID(), invitationId: inv.invitationId, reason: "Competing cancellation" })
            .then(value => ({ value }), error => ({ error }));
        await waitForDatabaseBlock(tag); barrier.release();
        expect(await accepted).toHaveProperty("value");
        expect(await cancellation).toMatchObject({ error: { code: "INVITATION_STATE_CONFLICT" } });
        const login = await loginUser({ email: input.email, password }), before = await graphDigest();
        expect(await acceptCompanyInvitation(mockDb, { token: inv.token, operationId: op }, login.token)).toEqual((await accepted as any).value);
        expect(await graphDigest()).toBe(before);
        expect((await pool.query('SELECT state FROM "CompanyInvitation" WHERE id=$1', [inv.invitationId])).rows[0].state).toBe("accepted");
    } finally { barrier.release(); await accepted; await cancellation; }
});

it("review correction: owner revocation wins after initial lookup and acceptance leaves graph unchanged", async () => {
    const a = await admin(), inv = await createCompanyInvitation(mockDb, a.actor, inviteInput());
    const barrier = queryBarrier(sql => sql.includes('FROM "CompanyInvitation" WHERE "tokenHash"'));
    const outcome = acceptCompanyInvitation(barrier.db, { token: inv.token, operationId: randomUUID(), name: "Revoked inviter", password })
        .then(value => ({ value }), error => ({ error }));
    try {
        await barrier.reached(); await authorizeCompanyDelegator(mockDb, ownerRequest(a.companyMembershipId, [], "operator-revoke"));
        const graph = await graphDigest(); barrier.release();
        expect(await outcome).toMatchObject({ error: { code: "DELEGATION_AUTHORITY_REQUIRED" } });
        expect(await graphDigest()).toBe(graph);
    } finally { barrier.release(); await outcome; }
});

it("review correction: zero-row pending transition rolls back the complete enrollment graph", async () => {
    const a = await admin(), inv = await createCompanyInvitation(mockDb, a.actor, inviteInput());
    await pool.query(`CREATE FUNCTION cp_skip_acceptance() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.state='accepted' THEN RETURN NULL; END IF; RETURN NEW; END; $$; CREATE TRIGGER cp_skip_acceptance BEFORE UPDATE ON "CompanyInvitation" FOR EACH ROW EXECUTE FUNCTION cp_skip_acceptance();`);
    try {
        const before = await graphDigest();
        await expect(acceptCompanyInvitation(mockDb, { token: inv.token, operationId: randomUUID(), name: "No transition", password })).rejects.toMatchObject({ code: "INVITATION_STATE_CONFLICT" });
        expect(await graphDigest()).toBe(before);
    } finally { await pool.query('DROP TRIGGER cp_skip_acceptance ON "CompanyInvitation"; DROP FUNCTION cp_skip_acceptance();'); }
});

it("review correction: confirmed acceptance retries revalidate recipient session and inviter authority", async () => {
    const a = await admin(), input = inviteInput(), inv = await createCompanyInvitation(mockDb, a.actor, input), operationId = randomUUID();
    const accepted = await acceptCompanyInvitation(mockDb, { token: inv.token, operationId, name: "Retry recipient", password });
    const login = await loginUser({ email: input.email, password });
    const retry = { token: inv.token, operationId }, before = await graphDigest();
    expect(await acceptCompanyInvitation(mockDb, retry, login.token)).toEqual(accepted);
    expect(await graphDigest()).toBe(before);
    await revokeRefreshSession(login.refreshToken);
    await unchanged(() => acceptCompanyInvitation(mockDb, retry, login.token));
    const fresh = await loginUser({ email: input.email, password });
    await authorizeCompanyDelegator(mockDb, ownerRequest(a.companyMembershipId, [], "operator-revoke"));
    await unchanged(() => acceptCompanyInvitation(mockDb, retry, fresh.token));
});

async function distinctCompanyCeilings() {
    const a = await admin(), b = await admin();
    const invite = await createCompanyInvitation(mockDb, a.actor, inviteInput({ email: b.actor.email }));
    const joined = await acceptCompanyInvitation(mockDb, { token: invite.token, operationId: randomUUID() }, b.login.token);
    const warehouses = await Promise.all(["A", "B"].map(name => mockDb.warehouse.create({ data: { name: "Synthetic " + name, location: "Synthetic location", tenantId: a.tenantId } })));
    await authorizeCompanyDelegator(mockDb, ownerRequest(a.companyMembershipId, [warehouses[0].id]));
    await authorizeCompanyDelegator(mockDb, ownerRequest(joined.companyMembershipId, warehouses.map(w => w.id)));
    const login = await loginUser({ email: b.actor.email, password, companyMembershipId: joined.companyMembershipId });
    const bActor = { ...login.user, id: login.user.userId };
    const target = await enrolled({ actor: bActor }, { profileRevision: "operational-warehouse.v1", warehouseIds: [warehouses[1].id] });
    await loginUser({ email: target.input.email, password: target.pass }); // Include live target sessions in rejection snapshot.
    return { a, bActor, warehouses, target };
}
it.each(["operational-clerk.v1", "operational-dispatcher.v1", "operational-warehouse.v1"])("review correction: A-only delegator cannot replace B-scoped target with %s", async profileRevision => {
    const { a, warehouses, target } = await distinctCompanyCeilings();
    const before = await graphDigest();
    await expect(mutateCompanyOperationalGrant(mockDb, a.actor, { operationId: randomUUID(), membershipId: target.accepted.companyMembershipId, action: "grant", profileRevision,
        warehouseIds: profileRevision === "operational-warehouse.v1" ? [warehouses[0].id] : [], reason: "Cannot remove unowned B scope" })).rejects.toMatchObject({ code: "DELEGATION_SCOPE_CEILING" });
    expect(await graphDigest()).toBe(before);
});
it("review correction: ceiling covering existing and new scopes allows replacements and write-free matching receipts", async () => {
    const { bActor, warehouses, target } = await distinctCompanyCeilings();
    for (const profileRevision of ["operational-clerk.v1", "operational-dispatcher.v1", "operational-warehouse.v1"]) {
        const restore = { operationId: randomUUID(), membershipId: target.accepted.companyMembershipId, action: "grant", profileRevision: "operational-warehouse.v1", warehouseIds: [warehouses[1].id], reason: "Restore approved B scope" };
        await mutateCompanyOperationalGrant(mockDb, bActor, restore);
        const input = { ...restore, operationId: randomUUID(), profileRevision, warehouseIds: profileRevision === "operational-warehouse.v1" ? [warehouses[0].id] : [] };
        const result = await mutateCompanyOperationalGrant(mockDb, bActor, input), before = await graphDigest();
        expect(await mutateCompanyOperationalGrant(mockDb, bActor, input)).toEqual(result);
        expect(await graphDigest()).toBe(before);
        const m = await mockDb.companyMembership.findUniqueOrThrow({ where: { id: target.accepted.companyMembershipId }, include: { scopes: true } });
        expect(m.scopes.map(s => `${s.scopeType}:${s.scopeRefId}`)).toEqual([profileRevision === "operational-warehouse.v1" ? `warehouse:${warehouses[0].id}` : `company:${bActor.companyId}`]);
    }
});
