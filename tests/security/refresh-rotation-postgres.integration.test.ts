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
import { refreshUserSession } from "../../src/modules/identity-access/application/auth.service";
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
