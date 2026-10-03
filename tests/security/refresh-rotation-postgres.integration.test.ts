jest.mock("../../src/config/prismaClient", () => ({ __esModule: true, default: new Proxy({}, { get: (_target, name) => { const value = (mockPrisma as any)[name]; return typeof value === "function" ? value.bind(mockPrisma) : value; } }) }));
// Domain envelope only is mocked to guarantee no Redis/logger import; actual transactional outbox writes run.
jest.mock("../../src/modules/analytics-core/realtime/analyticsEvents", () => ({ buildCargoPilotDomainEvent: (input: any) => ({ ...input, id: require("crypto").randomUUID(), occurredAt: new Date().toISOString(), schemaVersion: 1 }) }));
import { Pool } from "pg";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { randomUUID } from "crypto";
import { createTenantDemoFixture, TENANT_DEMO_IDS as ids } from "../../src/modules/tenancy/demo-fixtures";
import { persistTenantDemoFixture } from "../tenancy/postgres-fixture.persistence";
jest.mock("../../src/config/redis",()=>({getRedisClient:jest.fn(async()=>null),getRedisPrefix:()=>"disposable-refresh",withRedisTimeout:async(_name:string,work:()=>Promise<unknown>)=>work()}));
import jwt from "jsonwebtoken";
import { createHash } from "crypto";
import { refreshUserSession, loginUser, changeUserPassword } from "../../src/modules/identity-access/application/auth.service";
import bcrypt from "bcryptjs";
import Fastify from "fastify";
import { fastifyAuth } from "../../src/modules/identity-access/transport/fastify-auth";
import { hasLiveAccessSession } from "../../src/modules/identity-access/application/access-session";
import { fork, ChildProcess } from "child_process";
import path from "path";
const WebSocket = require("ws");
const url=process.env.CARGOPILOT_WORKER_TEST_DATABASE_URL,runId=process.env.CARGOPILOT_WORKER_RUN_ID;
if(!url||!runId||!/^[a-f0-9]{12}$/.test(runId))throw Error("Disposable refresh identity required");
const target=new URL(url);
if(target.hostname!=="127.0.0.1"||target.username!=="cp_worker_it"||target.pathname!==`/cp_worker_${runId}`)throw Error("Refusing existing PostgreSQL target");
const pool=new Pool({connectionString:url,max:2,connectionTimeoutMillis:3000,options:"-c statement_timeout=5000"});
let mockPrisma:PrismaClient;
const fixture=createTenantDemoFixture();
const context={id:ids.users.maker,tenantId:ids.tenants.transAsia,tenantMembershipId:ids.tenantMemberships.makerTransAsia,companyId:ids.organizations.transAsiaUz,companyMembershipId:ids.companyMemberships.makerTransAsiaUz};
const secret="synthetic-disposable-refresh-only-signing";
async function accepted(){const sid=randomUUID();const token=jwt.sign({...context,sid,tokenType:"refresh"},secret,{expiresIn:"1h"});await mockPrisma.userRefreshSession.create({data:{id:sid,userId:context.id,tenantId:context.tenantId,tenantMembershipId:context.tenantMembershipId,companyMembershipId:context.companyMembershipId,tokenHash:createHash("sha256").update(token).digest("hex"),expiresAt:new Date(Date.now()+3600000)}});return {sid,token};}
const rows=()=>mockPrisma.userRefreshSession.findMany({where:{userId:context.id},orderBy:{id:"asc"}});
it.each(["expiry", "company membership", "tenant membership", "tenant", "company"])(
  "%s becoming ineligible after precheck prevents actual consumption and replacement",
  async (condition) => {
    const original = await accepted();
    const originalTransaction = mockPrisma.$transaction.bind(mockPrisma);
    let before: Awaited<ReturnType<typeof rows>> | undefined;
    let arrivals = 0;
    const change = async (restore: boolean) => {
      if (condition === "expiry") {
        if (!restore) await mockPrisma.userRefreshSession.update({ where: { id: original.sid }, data: { expiresAt: new Date(Date.now() - 1000) } });
      } else if (condition === "company membership") {
        await mockPrisma.companyMembership.update({ where: { id: context.companyMembershipId }, data: { status: restore ? "active" : "suspended" } });
      } else if (condition === "tenant membership") {
        await mockPrisma.tenantMembership.update({ where: { id: context.tenantMembershipId }, data: { status: restore ? "active" : "suspended" } });
      } else if (condition === "tenant") {
        await mockPrisma.tenant.update({ where: { id: context.tenantId }, data: { status: restore ? "active" : "suspended" } });
      } else {
        await mockPrisma.organization.update({ where: { id: context.companyId }, data: { isActive: restore } });
      }
    };
    // This test barrier changes committed eligibility only after every real precheck.
    const spy = jest.spyOn(mockPrisma, "$transaction").mockImplementation(async (fn: any, opts: any) => {
      arrivals++;
      await change(false);
      before = await rows();
      return originalTransaction(fn, opts);
    });
    try {
      await expect(refreshUserSession({ refreshToken: original.token })).rejects.toThrow("revoked");
      expect(arrivals).toBe(1);
      expect(before).toBeDefined();
      expect(await rows()).toEqual(before);
      expect((await rows()).find(row => row.id === original.sid)!.revokedAt).toBeNull();
    } finally {
      spy.mockRestore();
      await change(true);
    }
  },
);
beforeAll(async()=>{const marker=await pool.query('SELECT "runId" FROM "_CPDisposableRun"');if(marker.rows.length!==1||marker.rows[0].runId!==runId)throw Error("Disposable ownership mismatch");const client=await pool.connect();try{await client.query("BEGIN");await persistTenantDemoFixture(client,fixture);await client.query("COMMIT");}finally{client.release();}mockPrisma=new PrismaClient({adapter:new PrismaPg({connectionString:url,max:6,connectionTimeoutMillis:3000,options:"-c statement_timeout=5000"})});process.env.JWT_SECRET=secret;process.env.REFRESH_TOKEN_SECRET=secret;});
afterAll(async()=>{await mockPrisma?.$disconnect();await pool.end();delete process.env.JWT_SECRET;delete process.env.REFRESH_TOKEN_SECRET;});
it("three simultaneous actual refresh requests consume one token and create one exact-context replacement",async()=>{const original=await accepted();const before=await rows();const originalTransaction=mockPrisma.$transaction.bind(mockPrisma);let arrivals=0;let release!:()=>void;let fail!:(e:Error)=>void;const gate=new Promise<void>((resolve,reject)=>{release=resolve;fail=reject;});const deadline=setTimeout(()=>fail(Error("synthetic refresh barrier deadline")),5000);const spy=jest.spyOn(mockPrisma,"$transaction").mockImplementation(async(fn:any,opts:any)=>{arrivals++;if(arrivals===3)release();await gate;return originalTransaction(fn,opts);});let outcomes:PromiseSettledResult<any>[];try{outcomes=await Promise.allSettled([1,2,3].map(()=>refreshUserSession({refreshToken:original.token})));expect(arrivals).toBe(3);}finally{clearTimeout(deadline);spy.mockRestore();}const success=outcomes.filter((r):r is PromiseFulfilledResult<any>=>r.status==="fulfilled");expect(success).toHaveLength(1);expect(outcomes.filter(r=>r.status==="rejected")).toHaveLength(2);const after=await rows();expect(after.length-before.length).toBe(1);expect(after.find(r=>r.id===original.sid)!.revokedAt).not.toBeNull();const payload=jwt.verify(success[0].value.refreshToken,secret) as any;expect(payload).toMatchObject(context);const replacement=after.find(r=>r.id===payload.sid)!;expect(replacement).toMatchObject({userId:context.id,tenantId:context.tenantId,tenantMembershipId:context.tenantMembershipId,companyMembershipId:context.companyMembershipId,revokedAt:null});await expect(refreshUserSession({refreshToken:original.token})).rejects.toThrow("revoked");expect(await rows()).toEqual(after);});
it("actual replacement INSERT failure rolls back consumption and permits the original token to retry",async()=>{const original=await accepted();const before=await rows();await pool.query(`CREATE FUNCTION cp_refresh_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."userAgent"='synthetic-insert-failure' THEN RAISE EXCEPTION 'synthetic refresh insert failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER cp_refresh_fail BEFORE INSERT ON "UserRefreshSession" FOR EACH ROW EXECUTE FUNCTION cp_refresh_fail();`);try{await expect(refreshUserSession({refreshToken:original.token,userAgent:"synthetic-insert-failure"})).rejects.toThrow("synthetic refresh insert failure");expect(await rows()).toEqual(before);}finally{await pool.query('DROP TRIGGER cp_refresh_fail ON "UserRefreshSession"; DROP FUNCTION cp_refresh_fail();');}expect(await refreshUserSession({refreshToken:original.token})).toHaveProperty("refreshToken");expect((await rows()).length-before.length).toBe(1);});
it("revoked membership denies actual refresh without creating or consuming sessions",async()=>{const original=await accepted();const before=await rows();await mockPrisma.companyMembership.update({where:{id:context.companyMembershipId},data:{status:"suspended"}});try{await expect(refreshUserSession({refreshToken:original.token})).rejects.toThrow("no longer eligible");expect(await rows()).toEqual(before);}finally{await mockPrisma.companyMembership.update({where:{id:context.companyMembershipId},data:{status:"active"}});}});
import { revokeRefreshSession } from "../../src/modules/identity-access/application/auth.service";
const sessionBusinessCounts = async () => ({ orders: await mockPrisma.order.count(), invoices: await mockPrisma.invoice.count(), finance: await mockPrisma.financeJournalEntry.count(), outbox: await mockPrisma.analyticsDomainEventOutbox.count() });
it("logout binding PostgreSQL wrong-purpose and conflicting signed context/hash cannot revoke another stored session", async () => {
  const businessBefore = await sessionBusinessCounts();
  const patches = [{ tokenType: "access" }, { tenantId: ids.tenants.unrelated }, { tenantMembershipId: ids.tenantMemberships.checkerTransAsia }, { companyMembershipId: ids.companyMemberships.multiTransAsiaDe }, { companyId: ids.organizations.transAsiaDe }, { id: ids.users.checker }, { tenantId: undefined }];
  for (const patch of patches) {
    const sid = randomUUID(), token = jwt.sign({ ...context, sid, tokenType: "refresh", ...patch }, secret, { expiresIn: "1h" });
    // Simulates a wrongly issued signed token: stored hash matches, stored authority remains maker's exact context.
    await mockPrisma.userRefreshSession.create({ data: { id: sid, userId: context.id, tenantId: context.tenantId, tenantMembershipId: context.tenantMembershipId, companyMembershipId: context.companyMembershipId, tokenHash: createHash("sha256").update(token).digest("hex"), expiresAt: new Date(Date.now() + 3600000) } });
    const before = await rows(); await revokeRefreshSession(token); expect(await rows()).toEqual(before);
  }
  const original = await accepted(), before = await rows();
  const changedToken = jwt.sign({ ...context, sid: original.sid, tokenType: "refresh", nonce: "synthetic-changed-content" }, secret, { expiresIn: "1h" });
  await revokeRefreshSession(changedToken); expect(await rows()).toEqual(before); expect(await sessionBusinessCounts()).toEqual(businessBefore);
});
it("logout binding PostgreSQL concurrent exact cleanup changes one row only and permits cleanup after suspension", async () => {
  const original = await accepted(), separate = await accepted(), before = await rows(), businessBefore = await sessionBusinessCounts();
  await mockPrisma.companyMembership.update({ where: { id: context.companyMembershipId }, data: { status: "suspended" } });
  try {
    await Promise.all([1, 2, 3].map(() => revokeRefreshSession(original.token)));
    const after = await rows(); expect(after).toHaveLength(before.length); expect(after.find(row => row.id === original.sid)!.revokedAt).not.toBeNull();
    expect(after.filter(row => row.id !== original.sid)).toEqual(before.filter(row => row.id !== original.sid)); expect(after.find(row => row.id === separate.sid)!.revokedAt).toBeNull();
    await revokeRefreshSession(original.token); expect(await rows()).toEqual(after); expect(await sessionBusinessCounts()).toEqual(businessBefore);
  } finally { await mockPrisma.companyMembership.update({ where: { id: context.companyMembershipId }, data: { status: "active" } }); }
});
const refreshSid = (token: string) => (jwt.verify(token, secret) as any).sid as string;
it("lineage PostgreSQL actual rotations publish immutable context/depth links and old-token logout revokes only recorded successors", async () => {
  const original = await accepted(), separate = await accepted(), one = await refreshUserSession({ refreshToken: original.token }), two = await refreshUserSession({ refreshToken: one.refreshToken });
  const chain = await rows(), first = chain.find(row => row.id === original.sid)!, middle = chain.find(row => row.id === refreshSid(one.refreshToken))!, leaf = chain.find(row => row.id === refreshSid(two.refreshToken))!;
  expect(first.replacedBySessionId).toBe(middle.id); expect(first.replacementDepth).toBe(1); expect(middle.replacedBySessionId).toBe(leaf.id); expect(middle.replacementDepth).toBe(2); expect(leaf.rotationDepth).toBe(2); expect(leaf.revokedAt).toBeNull();
  const before = await rows(), businessBefore = await sessionBusinessCounts();
  await expect(refreshUserSession({ refreshToken: original.token })).rejects.toThrow("revoked"); expect(await rows()).toEqual(before);
  await revokeRefreshSession(original.token); const after = await rows(); expect(after.find(row => row.id === leaf.id)!.revokedAt).not.toBeNull(); expect(after.find(row => row.id === separate.sid)!.revokedAt).toBeNull();
  expect(after.find(row => row.id === original.sid)!.replacedBySessionId).toBe(middle.id); await expect(refreshUserSession({ refreshToken: two.refreshToken })).rejects.toThrow("revoked"); await revokeRefreshSession(original.token); expect(await rows()).toEqual(after); expect(await sessionBusinessCounts()).toEqual(businessBefore);
});
it("lineage PostgreSQL failed pointer publication rolls back consume, successor and related state", async () => {
  const original = await accepted(), before = await rows(), businessBefore = await sessionBusinessCounts();
  await pool.query(`CREATE FUNCTION cp_lineage_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id='${original.sid}' AND NEW."replacedBySessionId" IS NOT NULL THEN RAISE EXCEPTION 'synthetic lineage publication failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER cp_lineage_fail BEFORE UPDATE ON "UserRefreshSession" FOR EACH ROW EXECUTE FUNCTION cp_lineage_fail();`);
  try { await expect(refreshUserSession({ refreshToken: original.token })).rejects.toThrow("synthetic lineage publication failure"); expect(await rows()).toEqual(before); expect(await sessionBusinessCounts()).toEqual(businessBefore); }
  finally { await pool.query('DROP TRIGGER cp_lineage_fail ON "UserRefreshSession"; DROP FUNCTION cp_lineage_fail();'); }
  const next = await refreshUserSession({ refreshToken: original.token }); expect((await rows()).find(row => row.id === original.sid)!.replacedBySessionId).toBe(refreshSid(next.refreshToken));
});
it("lineage PostgreSQL cross-user/tenant/company, partial-null, merge and immutable reference updates reject without effects", async () => {
  const original = await accepted(), issued = await refreshUserSession({ refreshToken: original.token }), successor = refreshSid(issued.refreshToken), before = await rows(), businessBefore = await sessionBusinessCounts();
  for (const data of [{ replacedBySessionId: null, replacementDepth: null }, { rotationDepth: 9 }, { tenantId: ids.tenants.unrelated }, { revokedAt: null }]) await expect(mockPrisma.userRefreshSession.update({ where: { id: original.sid }, data })).rejects.toThrow();
  const waiting = await accepted(); await mockPrisma.userRefreshSession.update({ where: { id: waiting.sid }, data: { revokedAt: new Date() } }); const withWaiting = await rows();
  await expect(mockPrisma.userRefreshSession.update({ where: { id: waiting.sid }, data: { replacedBySessionId: successor, replacementDepth: 1 } })).rejects.toThrow();
  await expect(mockPrisma.userRefreshSession.update({ where: { id: waiting.sid }, data: { replacedBySessionId: successor } })).rejects.toThrow();
  await expect(mockPrisma.userRefreshSession.update({ where: { id: waiting.sid }, data: { replacedBySessionId: waiting.sid, replacementDepth: 1 } })).rejects.toThrow();
  await expect(mockPrisma.userRefreshSession.delete({ where: { id: original.sid } })).rejects.toThrow();
  await expect(pool.query('TRUNCATE "UserRefreshSession"')).rejects.toThrow();
  expect(await rows()).toEqual(withWaiting); expect(await sessionBusinessCounts()).toEqual(businessBefore);
  const contexts = [
    { ...context, id: ids.users.checker, tenantMembershipId: ids.tenantMemberships.checkerTransAsia, companyMembershipId: ids.companyMemberships.checkerTransAsiaUz },
    { ...context, id: ids.users.multiTenant, tenantMembershipId: ids.tenantMemberships.multiTransAsia, companyMembershipId: ids.companyMemberships.multiTransAsiaDe, companyId: ids.organizations.transAsiaDe },
    { ...context, id: ids.users.multiTenant, tenantId: ids.tenants.unrelated, tenantMembershipId: ids.tenantMemberships.multiUnrelated, companyMembershipId: ids.companyMemberships.multiUnrelated, companyId: ids.organizations.unrelated },
  ];
  for (const selected of contexts) {
    const sid = randomUUID(), token = jwt.sign({ ...selected, sid, tokenType: "refresh" }, secret, { expiresIn: "1h" });
    await mockPrisma.userRefreshSession.create({ data: { id: sid, userId: selected.id, tenantId: selected.tenantId, tenantMembershipId: selected.tenantMembershipId, companyMembershipId: selected.companyMembershipId, tokenHash: createHash("sha256").update(token).digest("hex"), expiresAt: new Date(Date.now() + 3600000) } });
    const target = await refreshUserSession({ refreshToken: token }); const source = await accepted(); await mockPrisma.userRefreshSession.update({ where: { id: source.sid }, data: { revokedAt: new Date() } }); const allBefore = await mockPrisma.userRefreshSession.findMany({ orderBy: { id: "asc" } });
    await expect(mockPrisma.userRefreshSession.update({ where: { id: source.sid }, data: { replacedBySessionId: refreshSid(target.refreshToken), replacementDepth: 1 } })).rejects.toThrow(); expect(await mockPrisma.userRefreshSession.findMany({ orderBy: { id: "asc" } })).toEqual(allBefore);
  }
  const orphan = { id: randomUUID(), userId: context.id, tenantId: context.tenantId, tenantMembershipId: context.tenantMembershipId, companyMembershipId: context.companyMembershipId, tokenHash: randomUUID(), expiresAt: new Date(Date.now() + 3600000), rotationDepth: 1 };
  const beforeOrphan = await rows(); await expect(mockPrisma.userRefreshSession.create({ data: orphan })).rejects.toThrow("atomic predecessor acceptance"); expect(await rows()).toEqual(beforeOrphan);
  const catalog = await pool.query(`SELECT conname, convalidated, pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conname IN ('UserRefreshSession_lineage_fkey','UserRefreshSession_lineage_presence_check')`); expect(catalog.rows).toHaveLength(2); expect(catalog.rows.every(row => !row.convalidated)).toBe(true); expect(catalog.rows.find(row => row.conname === 'UserRefreshSession_lineage_fkey').definition).toContain('"replacementDepth"');
  expect(before.find(row => row.id === original.sid)!.replacedBySessionId).toBe(successor);
});
it("lineage PostgreSQL logout wins against a rotation held after successful prechecks", async () => {
  const original = await accepted(), businessBefore = await sessionBusinessCounts(), originalTransaction = mockPrisma.$transaction.bind(mockPrisma);
  let enter!: () => void, release!: () => void; const entered = new Promise<void>(resolve => { enter = resolve; }), gate = new Promise<void>(resolve => { release = resolve; }); let calls = 0;
  const deadline = setTimeout(() => release(), 5000); const spy = jest.spyOn(mockPrisma, "$transaction").mockImplementation(async (fn: any, options: any) => { if (++calls === 1) { enter(); await gate; } return originalTransaction(fn, options); });
  const rotation = refreshUserSession({ refreshToken: original.token }); rotation.catch(() => undefined);
  try { await entered; await revokeRefreshSession(original.token); const before = await rows(); release(); await expect(rotation).rejects.toThrow("revoked"); expect(await rows()).toEqual(before); expect(await sessionBusinessCounts()).toEqual(businessBefore); }
  finally { release(); clearTimeout(deadline); await Promise.allSettled([rotation]); spy.mockRestore(); }
});
it("lineage PostgreSQL logout waiting on committed rotation reloads and revokes the new successor", async () => {
  const original = await accepted(), separate = await accepted(), before = await rows(), businessBefore = await sessionBusinessCounts(), originalTransaction = mockPrisma.$transaction.bind(mockPrisma);
  let enter!: () => void, release!: () => void; const entered = new Promise<void>(resolve => { enter = resolve; }), gate = new Promise<void>(resolve => { release = resolve; }); let calls = 0;
  const deadline = setTimeout(() => release(), 5000);
  const spy = jest.spyOn(mockPrisma, "$transaction").mockImplementation(async (fn: any, options: any) => originalTransaction(async tx => {
    if (++calls !== 1) return fn(tx);
    const proxy = new Proxy(tx, { get(target: any, key) { if (key !== "userRefreshSession") { const value = target[key]; return typeof value === "function" ? value.bind(target) : value; }
      return new Proxy(target.userRefreshSession, { get(model: any, method) { if (method !== "create") return model[method]; return async (args: any) => { const result = await model.create(args); enter(); await gate; return result; }; } }); } });
    return fn(proxy);
  }, options));
  const rotation = refreshUserSession({ refreshToken: original.token }); rotation.catch(() => undefined); let logout: Promise<void> | undefined;
  try {
    await entered; logout = revokeRefreshSession(original.token); logout.catch(() => undefined);
    let observed = false; const until = Date.now() + 1500;
    while (Date.now() < until) { const waiting = await pool.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event='advisory'"); if (waiting.rows[0].n > 0) { observed = true; break; } await new Promise(resolve => setTimeout(resolve, 25)); }
    expect(observed).toBe(true); release(); const issued = await rotation; await logout; const after = await rows(); expect(after).toHaveLength(before.length + 1); expect(after.find(row => row.id === original.sid)!.replacedBySessionId).toBe(refreshSid(issued.refreshToken)); expect(after.find(row => row.id === refreshSid(issued.refreshToken))!.revokedAt).not.toBeNull(); expect(after.find(row => row.id === separate.sid)!.revokedAt).toBeNull(); expect(await sessionBusinessCounts()).toEqual(businessBefore);
  } finally { release(); clearTimeout(deadline); await Promise.allSettled([rotation, ...(logout ? [logout] : [])]); spy.mockRestore(); }
});
it("lineage PostgreSQL final logout write failure rolls back all revocation and retains retryable chain", async () => {
  const original = await accepted(), next = await refreshUserSession({ refreshToken: original.token }), sid = refreshSid(next.refreshToken), before = await rows(), businessBefore = await sessionBusinessCounts();
  await pool.query(`CREATE FUNCTION cp_logout_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id='${sid}' AND OLD."revokedAt" IS NULL AND NEW."revokedAt" IS NOT NULL THEN RAISE EXCEPTION 'synthetic lineage logout failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER cp_logout_fail BEFORE UPDATE ON "UserRefreshSession" FOR EACH ROW EXECUTE FUNCTION cp_logout_fail();`);
  try { await expect(revokeRefreshSession(original.token)).rejects.toThrow("synthetic lineage logout failure"); expect(await rows()).toEqual(before); expect(await sessionBusinessCounts()).toEqual(businessBefore); }
  finally { await pool.query('DROP TRIGGER cp_logout_fail ON "UserRefreshSession"; DROP FUNCTION cp_logout_fail();'); }
  await revokeRefreshSession(original.token); expect((await rows()).find(row => row.id === sid)!.revokedAt).not.toBeNull();
});

const passwordActor: any = { ...context, membershipId: context.companyMembershipId, branchId: null };
const oldPassword = "synthetic-native-old-password", newPassword = "synthetic-native-new-password";
const passwordChange = () => changeUserPassword({ actor: passwordActor, currentPassword: oldPassword, newPassword });
const passwordLogin = (password = oldPassword) => loginUser({ email: fixture.users.find(user => user.id === context.id)!.email, password, companyMembershipId: context.companyMembershipId });
async function withCredentials(work: () => Promise<void>) {
  const original = await mockPrisma.user.findUniqueOrThrow({ where: { id: context.id }, select: { password: true } });
  await mockPrisma.user.update({ where: { id: context.id }, data: { password: bcrypt.hashSync(oldPassword, 4) } });
  try { await work(); } finally { await mockPrisma.user.update({ where: { id: context.id }, data: { password: original.password } }); }
}
it("credential PostgreSQL valid change atomically revokes every own context/root, retains other users and permits only new credentials", async () => withCredentials(async () => {
  const original = await accepted(); await refreshUserSession({ refreshToken: original.token }); await accepted();
  const foreignBefore = await mockPrisma.userRefreshSession.findMany({ where: { userId: { not: context.id } }, orderBy: { id: "asc" } });
  const business = await sessionBusinessCounts(); await passwordChange();
  expect((await rows()).every(row => row.revokedAt !== null)).toBe(true);
  expect(await mockPrisma.userRefreshSession.findMany({ where: { userId: { not: context.id } }, orderBy: { id: "asc" } })).toEqual(foreignBefore);
  await expect(passwordLogin()).rejects.toThrow("Invalid email or password"); const next = await passwordLogin(newPassword);
  expect((await rows()).find(row => row.id === refreshSid(next.refreshToken))!.revokedAt).toBeNull(); expect(next.user.companyMembershipId).toBe(context.companyMembershipId);
  expect(await sessionBusinessCounts()).toEqual(business);
}));
it("credential PostgreSQL failed refresh cleanup rolls back password and every session, leaving old credentials usable", async () => withCredentials(async () => {
  const original = await accepted(), before = await rows(), userBefore = await mockPrisma.user.findUniqueOrThrow({ where: { id: context.id } }), business = await sessionBusinessCounts();
  await pool.query(`CREATE FUNCTION cp_credential_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id='${original.sid}' AND OLD."revokedAt" IS NULL AND NEW."revokedAt" IS NOT NULL THEN RAISE EXCEPTION 'synthetic credential cleanup failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER cp_credential_fail BEFORE UPDATE ON "UserRefreshSession" FOR EACH ROW EXECUTE FUNCTION cp_credential_fail();`);
  try { await expect(passwordChange()).rejects.toThrow("synthetic credential cleanup failure"); expect(await rows()).toEqual(before); expect(await mockPrisma.user.findUniqueOrThrow({ where: { id: context.id } })).toEqual(userBefore); expect(await sessionBusinessCounts()).toEqual(business); }
  finally { await pool.query('DROP TRIGGER cp_credential_fail ON "UserRefreshSession"; DROP FUNCTION cp_credential_fail();'); }
  const next = await passwordLogin(); expect((await rows()).find(row => row.id === refreshSid(next.refreshToken))!.revokedAt).toBeNull();
}));
async function passwordWinsPrecheckedOperation(operation: () => Promise<unknown>, expected: string) {
  const originalTransaction = mockPrisma.$transaction.bind(mockPrisma); let enter!: () => void, release!: () => void, calls = 0;
  const entered = new Promise<void>(resolve => { enter = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const deadline = setTimeout(() => release(), 5000);
  const spy = jest.spyOn(mockPrisma, "$transaction").mockImplementation(async (fn: any, options: any) => { if (++calls === 1) { enter(); await gate; } return originalTransaction(fn, options); });
  const pending = operation(); pending.catch(() => undefined);
  try { await entered; await passwordChange(); const sessions = await rows(), user = await mockPrisma.user.findUniqueOrThrow({ where: { id: context.id } }), business = await sessionBusinessCounts(); release(); await expect(pending).rejects.toThrow(expected); expect(await rows()).toEqual(sessions); expect(await mockPrisma.user.findUniqueOrThrow({ where: { id: context.id } })).toEqual(user); expect(await sessionBusinessCounts()).toEqual(business); }
  finally { release(); clearTimeout(deadline); await Promise.allSettled([pending]); spy.mockRestore(); }
}
it("credential PostgreSQL old-password login prechecked before committed password change creates no session", async () => withCredentials(() => passwordWinsPrecheckedOperation(() => passwordLogin(), "Invalid email or password")));
it("credential PostgreSQL refresh prechecked before committed password change cannot consume or create a successor", async () => withCredentials(async () => { const original = await accepted(); await passwordWinsPrecheckedOperation(() => refreshUserSession({ refreshToken: original.token }), "revoked"); }));
it("credential PostgreSQL password change waits for accepted rotation then revokes its committed successor", async () => withCredentials(async () => {
  const original = await accepted(), business = await sessionBusinessCounts(), originalTransaction = mockPrisma.$transaction.bind(mockPrisma);
  let enter!: () => void, release!: () => void, calls = 0; const entered = new Promise<void>(resolve => { enter = resolve; }), gate = new Promise<void>(resolve => { release = resolve; }); const deadline = setTimeout(() => release(), 5000);
  const spy = jest.spyOn(mockPrisma, "$transaction").mockImplementation(async (fn: any, options: any) => originalTransaction(async tx => {
    if (++calls !== 1) return fn(tx);
    const proxy = new Proxy(tx, { get(target: any, key) { if (key !== "userRefreshSession") { const value = target[key]; return typeof value === "function" ? value.bind(target) : value; }
      return new Proxy(target.userRefreshSession, { get(model: any, method) { if (method !== "create") return model[method]; return async (args: any) => { const result = await model.create(args); enter(); await gate; return result; }; } }); } }); return fn(proxy);
  }, options));
  const rotation = refreshUserSession({ refreshToken: original.token }); rotation.catch(() => undefined); let change: Promise<void> | undefined;
  try { await entered; change = passwordChange(); change.catch(() => undefined); let observed = false; const until = Date.now() + 1500;
    while (Date.now() < until) { const waiting = await pool.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%FROM \"User\"%'"); if (waiting.rows[0].n > 0) { observed = true; break; } await new Promise(resolve => setTimeout(resolve, 25)); }
    expect(observed).toBe(true); release(); const issued = await rotation; await change; expect((await rows()).find(row => row.id === refreshSid(issued.refreshToken))!.revokedAt).not.toBeNull(); expect((await rows()).every(row => row.revokedAt !== null)).toBe(true); expect(await sessionBusinessCounts()).toEqual(business);
  } finally { release(); clearTimeout(deadline); await Promise.allSettled([rotation, ...(change ? [change] : [])]); spy.mockRestore(); }
}));
it("credential PostgreSQL three preverified password changes accept one hash transition and reject stale competitors without session effects", async () => withCredentials(async () => {
  await accepted(); const before = await rows(), business = await sessionBusinessCounts(), originalTransaction = mockPrisma.$transaction.bind(mockPrisma);
  let release!: () => void, calls = 0; const gate = new Promise<void>(resolve => { release = resolve; }); const deadline = setTimeout(() => release(), 5000);
  const spy = jest.spyOn(mockPrisma, "$transaction").mockImplementation(async (fn: any, options: any) => { if (++calls === 3) release(); await gate; return originalTransaction(fn, options); });
  try { const results = await Promise.allSettled([passwordChange(), passwordChange(), passwordChange()]); expect(calls).toBe(3); expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1); expect(results.filter(result => result.status === "rejected").every(result => String((result as PromiseRejectedResult).reason.message).includes("incorrect"))).toBe(true); const after = await rows(); expect(after).toHaveLength(before.length); expect(after.every(row => row.revokedAt !== null)).toBe(true); expect(await bcrypt.compare(newPassword, (await mockPrisma.user.findUniqueOrThrow({ where: { id: context.id } })).password)).toBe(true); expect(await sessionBusinessCounts()).toEqual(business); }
  finally { release(); clearTimeout(deadline); spy.mockRestore(); }
}));

async function protectedHttp(token: string) {
  const app = Fastify(); let effects = 0;
  app.get("/protected", { preHandler: fastifyAuth() }, async request => { effects++; return { companyId: request.user!.companyId }; });
  try { const reply = await app.inject({ url: "/protected", headers: { authorization: `Bearer ${token}` } }); return { status: reply.statusCode, body: reply.json(), effects }; }
  finally { await app.close(); }
}
const accessClaims = (token: string) => jwt.verify(token, secret) as any;
it("access PostgreSQL actual issued SID, recorded rotations and successor logout govern existing HTTP access without business effects", async () => withCredentials(async () => {
  const login = await passwordLogin(), separate = await passwordLogin(), business = await sessionBusinessCounts();
  expect(accessClaims(login.token).sid).toBe(refreshSid(login.refreshToken)); expect((await protectedHttp(login.token)).status).toBe(200);
  const rotated = await refreshUserSession({ refreshToken: login.refreshToken }), twice = await refreshUserSession({ refreshToken: rotated.refreshToken });
  expect((await protectedHttp(login.token)).status).toBe(200); expect((await protectedHttp(twice.token)).status).toBe(200);
  await revokeRefreshSession(rotated.refreshToken);
  for (const token of [login.token,rotated.token,twice.token]) { const response = await protectedHttp(token); expect(response).toEqual({status:401,body:{error:"Unauthorized"},effects:0}); }
  expect((await protectedHttp(separate.token)).status).toBe(200); expect(await sessionBusinessCounts()).toEqual(business);
}));
it("access PostgreSQL password cleanup rejects all prior HTTP roots and allows new login", async () => withCredentials(async () => {
  const login = await passwordLogin(), next = await refreshUserSession({refreshToken:login.refreshToken}), other = await passwordLogin(), business = await sessionBusinessCounts();
  await passwordChange(); for (const token of [login.token,next.token,other.token]) expect((await protectedHttp(token)).effects).toBe(0);
  expect((await protectedHttp((await passwordLogin(newPassword)).token)).status).toBe(200); expect(await sessionBusinessCounts()).toEqual(business);
}));
it("access PostgreSQL selected tenant/company/user mismatches, missing roots and legacy/expired JWTs fail without writes", async () => withCredentials(async () => {
  const login = await passwordLogin(), c=accessClaims(login.token), before=await rows(), business=await sessionBusinessCounts();
  for (const patch of [{sid:randomUUID()},{sid:undefined},{companyId:ids.organizations.transAsiaDe},{tenantId:ids.tenants.unrelated},{tenantMembershipId:ids.tenantMemberships.multiTransAsia},{companyMembershipId:ids.companyMemberships.multiTransAsiaDe,membershipId:ids.companyMemberships.multiTransAsiaDe},{id:ids.users.checker},{tokenType:"refresh"},{exp:Math.floor(Date.now()/1000)-1}]) {
    const response=await protectedHttp(jwt.sign({...c,...patch},secret)); expect(response).toEqual({status:401,body:{error:"Unauthorized"},effects:0});
  }
  expect(await rows()).toEqual(before); expect(await sessionBusinessCounts()).toEqual(business);
}));
it("access PostgreSQL fresh owner suspension and expired terminal session deny previously accepted tokens", async () => withCredentials(async () => {
  const login=await passwordLogin(), business=await sessionBusinessCounts();
  await mockPrisma.tenant.update({where:{id:context.tenantId},data:{status:"suspended"}});
  try { expect((await protectedHttp(login.token)).status).toBe(401); } finally { await mockPrisma.tenant.update({where:{id:context.tenantId},data:{status:"active"}}); }
  expect((await protectedHttp(login.token)).status).toBe(200);
  await mockPrisma.userRefreshSession.update({where:{id:refreshSid(login.refreshToken)},data:{expiresAt:new Date(0)}});
  expect(await hasLiveAccessSession(accessClaims(login.token))).toBe(false); expect((await protectedHttp(login.token)).effects).toBe(0); expect(await sessionBusinessCounts()).toEqual(business);
}));

type Peer = { child: ChildProcess; port: number; emit: () => Promise<void>; close: () => Promise<void> };
async function startSocketPeer(): Promise<Peer> {
  const env: NodeJS.ProcessEnv = { NODE_ENV:"test", JWT_SECRET:secret, CARGOPILOT_WORKER_TEST_DATABASE_URL:url, CARGOPILOT_WORKER_RUN_ID:runId };
  for(const key of ["PATH","SystemRoot","TEMP","TMP","USERPROFILE","APPDATA","LOCALAPPDATA"]) if(process.env[key]) env[key]=process.env[key];
  const child=fork(path.join(__dirname,"socket-session-process.ts"),[],{execArgv:["-r","ts-node/register/transpile-only"],env,stdio:["ignore","pipe","pipe","ipc"]});
  // Bounded diagnostic capture without printing credentials/query arguments.
  let diagnosticBytes=0; for(const stream of [child.stdout,child.stderr]) stream?.on("data",buffer=>{diagnosticBytes+=buffer.length; if(diagnosticBytes>65536) child.kill();});
  const waitMessage=(predicate:(m:any)=>boolean,ms:number)=>new Promise<any>((resolve,reject)=>{
    const timer=setTimeout(()=>{cleanup();reject(Error("Socket process deadline"));},ms);
    const onMessage=(m:any)=>{if(m?.kind==='startup-failed'||m?.kind==='failed'){cleanup();reject(Error("Socket process failed"));}else if(predicate(m)){cleanup();resolve(m);}};
    const onExit=()=>{cleanup();reject(Error("Socket process exited"));}; const cleanup=()=>{clearTimeout(timer);child.off("message",onMessage);child.off("exit",onExit);}; child.on("message",onMessage);child.on("exit",onExit);
  });
  const close=async()=>{ if(child.exitCode!==null) return; const ended=new Promise<void>(resolve=>child.once("exit",()=>resolve())); child.send({kind:"shutdown"}); const timer=setTimeout(()=>child.kill(),5000); try{await ended;}finally{clearTimeout(timer);} };
  try { const ready=await waitMessage(m=>m.kind==='ready',15000); return {child,port:ready.port,close,emit:async()=>{const request=randomUUID(),done=waitMessage(m=>m.kind==='done'&&m.request===request,10000);child.send({kind:"emit-order",request,userId:context.id,payload:{orderId:ids.orders.transAsiaUz,status:"assigned",updatedAt:new Date().toISOString()}});await done;}}; }
  catch(error){await close();throw error;}
}
type Wire = { ws: any; events: string[]; closed: Promise<void> };
async function connectWire(peer:Peer,token:string):Promise<Wire> {
  const ws=new WebSocket(`ws://127.0.0.1:${peer.port}/socket.io/?EIO=4&transport=websocket`),events:string[]=[];
  const closed=new Promise<void>(resolve=>ws.once("close",()=>resolve()));
  await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>{ws.terminate();reject(Error("Socket connection deadline"));},7000);
    ws.on("error",()=>{clearTimeout(timer);reject(Error("Socket transport failure"));});
    ws.on("message",(buffer:any)=>{const packet=buffer.toString(); if(packet.startsWith('0'))ws.send('40'+JSON.stringify({token})); else if(packet==='2')ws.send('3'); else if(packet.startsWith('42')){const event=JSON.parse(packet.slice(2));events.push(event[0]);if(event[0]==='driver:realtime:ready'){clearTimeout(timer);resolve();}} else if(packet.startsWith('44')){clearTimeout(timer);ws.terminate();reject(Error("Unauthorized socket"));}});
  }); return {ws,events,closed};
}
async function awaitClosed(wire:Wire,ms=7500){let timer:NodeJS.Timeout|undefined;try{await Promise.race([wire.closed,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error("Revoked socket did not close")),ms);})]);}finally{if(timer)clearTimeout(timer);}}
async function withSocketPeers(work:(peers:Peer[],wires:Wire[])=>Promise<void>){const peers:Peer[]=[],wires:Wire[]=[];try{peers.push(await startSocketPeer());peers.push(await startSocketPeer());await work(peers,wires);}finally{for(const wire of wires)wire.ws.terminate();await Promise.all(peers.map(peer=>peer.close()));}}
async function enableSyntheticDriver(){
  const permission=await mockPrisma.permission.upsert({where:{key:"drivers.telemetry"},create:{key:"drivers.telemetry",resource:"drivers",action:"telemetry",description:"Synthetic transport test"},update:{}});
  const role=await mockPrisma.role.create({data:{companyId:context.companyId,code:"synthetic_transport_driver",name:"Synthetic transport driver",isSystem:false}});
  await mockPrisma.membershipRole.create({data:{membershipId:context.companyMembershipId,roleId:role.id}});
  const previous=await mockPrisma.order.findUniqueOrThrow({where:{id:ids.orders.transAsiaUz},select:{assignedDriverId:true}});
  const grant=await mockPrisma.rolePermission.upsert({where:{roleId_permissionId:{roleId:role.id,permissionId:permission.id}},create:{roleId:role.id,permissionId:permission.id},update:{}});
  await mockPrisma.order.update({where:{id:ids.orders.transAsiaUz},data:{assignedDriverId:context.id}});
  return async()=>{await mockPrisma.order.update({where:{id:ids.orders.transAsiaUz},data:previous});await mockPrisma.rolePermission.delete({where:{roleId_permissionId:{roleId:grant.roleId,permissionId:grant.permissionId}}});await mockPrisma.membershipRole.delete({where:{membershipId_roleId:{membershipId:context.companyMembershipId,roleId:role.id}}});await mockPrisma.role.delete({where:{id:role.id}});};
}
it("socket transport PostgreSQL two independent processes deny successor-logout delivery to existing sockets but retain a separate root",async()=>withCredentials(async()=>{
  const restore=await enableSyntheticDriver();try{await withSocketPeers(async(peers,wires)=>{
    const login=await passwordLogin(), separate=await passwordLogin();for(const peer of peers)wires.push(await connectWire(peer,login.token));wires.push(await connectWire(peers[1],separate.token));
    for(const peer of peers)await peer.emit(); await new Promise(resolve=>setTimeout(resolve,100));expect(wires.every(wire=>wire.events.includes("driver:order-updated"))).toBe(true);
    const rotated=await refreshUserSession({refreshToken:login.refreshToken}); for(const peer of peers)await peer.emit();
    await revokeRefreshSession(login.refreshToken); const counts=wires.map(wire=>wire.events.filter(event=>event==='driver:order-updated').length);
    for(const peer of peers)await peer.emit();await Promise.all(wires.slice(0,2).map(wire=>awaitClosed(wire)));await new Promise(resolve=>setTimeout(resolve,100));
    expect(wires[0].events.filter(event=>event==='driver:order-updated')).toHaveLength(counts[0]);expect(wires[1].events.filter(event=>event==='driver:order-updated')).toHaveLength(counts[1]);expect(wires[2].events.filter(event=>event==='driver:order-updated')).toHaveLength(counts[2]+1);
    await expect(connectWire(peers[0],rotated.token)).rejects.toThrow("Unauthorized");
  });}finally{await restore();}
}));
it("socket transport PostgreSQL password change disconnects existing idle sessions in two processes without a business emit",async()=>withCredentials(async()=>{
  await withSocketPeers(async(peers,wires)=>{const login=await passwordLogin();for(const peer of peers)wires.push(await connectWire(peer,login.token));await passwordChange();await Promise.all(wires.map(wire=>awaitClosed(wire)));expect(wires.every(wire=>!wire.events.includes('driver:order-updated'))).toBe(true);});
}));
it("socket transport PostgreSQL existing JWT expiry disconnects idle connection and legacy access cannot connect",async()=>withCredentials(async()=>{
  await withSocketPeers(async(peers,wires)=>{const login=await passwordLogin(),claims=accessClaims(login.token);await expect(connectWire(peers[0],jwt.sign({...claims,sid:undefined},secret))).rejects.toThrow("Unauthorized");wires.push(await connectWire(peers[0],jwt.sign({...claims,exp:Math.floor(Date.now()/1000)+2},secret)));await awaitClosed(wires[0]);expect(wires[0].events).toEqual(['driver:realtime:ready']);});
}));
