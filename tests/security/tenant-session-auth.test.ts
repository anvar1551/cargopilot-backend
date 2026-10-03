jest.mock("../../src/config/prismaClient", () => ({
  __esModule: true,
  default: require("./fixtures").database,
}));
jest.mock("../../src/config/redis", () => ({
  getRedisClient: jest.fn(async () => null),
  getRedisPrefix: () => "test",
  withRedisTimeout: async (_name: string, work: () => Promise<unknown>) => work(),
}));

import bcrypt from "bcryptjs";
import Fastify from "fastify";
import jwt from "jsonwebtoken";
import { database } from "./fixtures";
import routes from "../../src/modules/identity-access/transport/fastify-routes";
import { fastifyAuth } from "../../src/modules/identity-access/transport/fastify-auth";
import {
  InvalidMembershipSelectionError,
  loginUser,
  MembershipSelectionRequiredError,
  refreshUserSession,
} from "../../src/modules/identity-access/application/auth.service";
import {
  clearIdentityAccessCacheForUser,
  loadAccessSnapshot,
} from "../../src/modules/identity-access/access-control";

const secret = "synthetic-tenant-session-secret-32-characters";
const ids = {
  user: "10000000-0000-4000-8000-000000000001",
  tenantA: "20000000-0000-4000-8000-000000000001",
  tenantB: "20000000-0000-4000-8000-000000000002",
  tenantMembershipA: "30000000-0000-4000-8000-000000000001",
  tenantMembershipB: "30000000-0000-4000-8000-000000000002",
  membershipA: "40000000-0000-4000-8000-000000000001",
  membershipB: "40000000-0000-4000-8000-000000000002",
  companyA: "50000000-0000-4000-8000-000000000001",
  companyB: "50000000-0000-4000-8000-000000000002",
};

function membership(overrides: Record<string, unknown> = {}) {
  const tenantId = String(overrides.tenantId ?? ids.tenantA);
  const tenantMembershipId = String(overrides.tenantMembershipId ?? ids.tenantMembershipA);
  const companyId = String(overrides.companyId ?? ids.companyA);
  const id = String(overrides.id ?? ids.membershipA);
  return {
    id,
    userId: ids.user,
    companyId,
    branchId: null,
    status: "active",
    tenantId,
    tenantMembershipId,
    tenant: { id: tenantId, name: `Synthetic ${tenantId}`, status: "active" },
    tenantMembership: { id: tenantMembershipId, tenantId, userId: ids.user, status: "active" },
    company: { id: companyId, name: `Synthetic ${companyId}`, tenantId, isActive: true },
    branch: null,
    user: { id: ids.user, name: "Synthetic User", email: "user@example.test", warehouseId: null, customerEntityId: null },
    scopes: [{ scopeType: "company", scopeRefId: companyId }],
    roles: [{ role: { code: "worker", rolePermissions: [{ permission: { key: "shipment.view" } }] } }],
    ...overrides,
  };
}

const sameTenantMembershipB = () => membership({
  id: ids.membershipB,
  companyId: ids.companyB,
  company: { id: ids.companyB, name: "Synthetic Company B", tenantId: ids.tenantA, isActive: true },
  scopes: [{ scopeType: "company", scopeRefId: ids.companyB }],
});

const passwordHash = bcrypt.hashSync("correct-password", 4);
const allowLimiter = {
  consume: jest.fn(async () => ({ count: 1, resetAfterMs: 1_000, allowed: true,
    limit: 100, remaining: 99, backend: "local" as const })),
};

function resetDatabaseMocks() {
  [database.user.findUnique, database.companyMembership.findFirst, database.companyMembership.findMany,
    database.userRefreshSession.create, database.userRefreshSession.findUnique,
    database.userRefreshSession.updateMany, database.$transaction,
    database.order.create, database.customerEntity.create].forEach((mock) => mock.mockReset());
  database.user.findUnique.mockResolvedValue({ id: ids.user, password: passwordHash });
  database.$executeRaw.mockReset().mockResolvedValue(0);
  database.$queryRaw.mockReset().mockImplementation(async (sql: any) => sql.text.includes('FROM "User"') ? [{ id: ids.user, password: passwordHash }] : sql.text.includes('WITH RECURSIVE') ? [{ id: ids.user, userId: ids.user, tenantId: ids.tenantA, tenantMembershipId: ids.tenantMembershipA, companyMembershipId: ids.membershipA, rotationDepth: 0, replacementDepth: null, replacedBySessionId: null, revokedAt: null, expiresAt: new Date(Date.now()+3600000), hop: 0 }] : []);
  database.credentialSecurityEvent.create.mockReset().mockResolvedValue({});
  database.userRefreshSession.create.mockResolvedValue({});
  database.userRefreshSession.updateMany.mockResolvedValue({ count: 1 });
  database.$transaction.mockImplementation(async (run: (tx: typeof database) => Promise<unknown>) => run(database));
  allowLimiter.consume.mockClear();
  clearIdentityAccessCacheForUser(ids.user);
}

describe("tenant-bound authentication sessions (mocked database evidence)", () => {
  const originalEnv = { ...process.env };
  beforeEach(() => {
    process.env = { ...originalEnv, NODE_ENV: "test", JWT_SECRET: secret, REFRESH_TOKEN_SECRET: secret };
    resetDatabaseMocks();
  });
  afterAll(() => { process.env = originalEnv; });

  it("allows deterministic compatibility login only when one membership is eligible", async () => {
    database.companyMembership.findMany.mockResolvedValue([membership()]);
    database.companyMembership.findFirst.mockResolvedValue(membership());

    const result = await loginUser({ email: "user@example.test", password: "correct-password" });
    const access = jwt.verify(result.token, secret) as any;
    const refresh = jwt.verify(result.refreshToken, secret) as any;
    expect(access).toMatchObject({ id: ids.user, membershipId: ids.membershipA,
      companyMembershipId: ids.membershipA, companyId: ids.companyA,
      tenantId: ids.tenantA, tenantMembershipId: ids.tenantMembershipA, tokenType: "access" });
    expect(refresh).toMatchObject({ id: ids.user, companyMembershipId: ids.membershipA,
      companyId: ids.companyA, tenantId: ids.tenantA,
      tenantMembershipId: ids.tenantMembershipA, tokenType: "refresh" });
    expect(result.user).toMatchObject({ membershipId: ids.membershipA,
      companyMembershipId: ids.membershipA, companyId: ids.companyA,
      tenantId: ids.tenantA, tenantMembershipId: ids.tenantMembershipA });
    expect(database.userRefreshSession.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
      userId: ids.user, tenantId: ids.tenantA, tenantMembershipId: ids.tenantMembershipA,
      companyMembershipId: ids.membershipA,
    }) }));
  });

  it("returns choices only after valid credentials and issues no session before explicit multi-membership selection", async () => {
    database.companyMembership.findMany.mockResolvedValue([sameTenantMembershipB(), membership()]);
    const app = Fastify();
    await app.register(routes, { prefix: "/api/auth", rateLimiter: allowLimiter });
    try {
      const response = await app.inject({ method: "POST", url: "/api/auth/login",
        payload: { email: "user@example.test", password: "correct-password" } });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({
        error: "Membership selection required",
        code: "MEMBERSHIP_SELECTION_REQUIRED",
        memberships: [
          { companyMembershipId: ids.membershipA, companyName: `Synthetic ${ids.companyA}`,
            tenantName: `Synthetic ${ids.tenantA}` },
          { companyMembershipId: ids.membershipB, companyName: "Synthetic Company B",
            tenantName: `Synthetic ${ids.tenantA}` },
        ],
      });
      expect(response.json()).not.toHaveProperty("token");
      expect(database.userRefreshSession.create).not.toHaveBeenCalled();

      resetDatabaseMocks();
      database.user.findUnique.mockResolvedValue({ id: ids.user, password: passwordHash });
      database.companyMembership.findMany.mockResolvedValue([membership(), sameTenantMembershipB()]);
      const denied = await app.inject({ method: "POST", url: "/api/auth/login",
        payload: { email: "user@example.test", password: "wrong-password" } });
      expect(denied.statusCode).toBe(401);
      expect(denied.json()).toEqual({ error: "Invalid credentials" });
      expect(database.companyMembership.findMany).not.toHaveBeenCalled();
      expect(database.userRefreshSession.create).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });

  it("rejects conflicting membership selector aliases after credential verification without writes", async () => {
    await expect(loginUser({
      email: "user@example.test",
      password: "correct-password",
      companyMembershipId: ids.membershipA,
      membershipId: ids.membershipB,
    })).rejects.toBeInstanceOf(InvalidMembershipSelectionError);
    expect(database.user.findUnique).toHaveBeenCalledTimes(1);
    expect(database.companyMembership.findFirst).not.toHaveBeenCalled();
    expect(database.companyMembership.findMany).not.toHaveBeenCalled();
    expect(database.userRefreshSession.create).not.toHaveBeenCalled();
  });

  it("uses an explicitly verified membership for a multi-membership user", async () => {
    database.companyMembership.findFirst.mockResolvedValue(sameTenantMembershipB());
    const result = await loginUser({ email: "user@example.test", password: "correct-password",
      companyMembershipId: ids.membershipB });
    expect(database.companyMembership.findMany).not.toHaveBeenCalled();
    expect(result.user).toMatchObject({ companyMembershipId: ids.membershipB,
      companyId: ids.companyB, tenantId: ids.tenantA, tenantMembershipId: ids.tenantMembershipA });
  });

  it.each([
    ["foreign", null],
    ["suspended company membership", membership({ status: "suspended" })],
    ["suspended tenant membership", membership({ tenantMembership: {
      id: ids.tenantMembershipA, tenantId: ids.tenantA, userId: ids.user, status: "suspended" } })],
    ["suspended tenant", membership({ tenant: { id: ids.tenantA, name: "Synthetic Tenant A", status: "suspended" } })],
    ["inactive company", membership({ company: { id: ids.companyA, name: "Synthetic Company A",
      tenantId: ids.tenantA, isActive: false } })],
    ["wrong-user tenant bridge", membership({ tenantMembership: {
      id: ids.tenantMembershipA, tenantId: ids.tenantA, userId: "another-user", status: "active" } })],
    ["cross-tenant tenant-membership bridge", membership({ tenantMembership: {
      id: ids.tenantMembershipA, tenantId: ids.tenantB, userId: ids.user, status: "active" } })],
    ["cross-tenant company bridge", membership({ company: { id: ids.companyA, name: "Synthetic Company A",
      tenantId: ids.tenantB, isActive: true } })],
    ["tenant-only partial bridge", membership({ tenantMembershipId: null, tenantMembership: null })],
    ["tenant-membership-only partial bridge", membership({ tenantId: null, tenant: null })],
    ["unbound", membership({ tenantId: null, tenantMembershipId: null, tenant: null, tenantMembership: null })],
  ])("rejects an explicit %s selection without writes", async (_case, selected) => {
    database.companyMembership.findFirst.mockResolvedValue(selected);
    await expect(loginUser({ email: "user@example.test", password: "correct-password",
      companyMembershipId: ids.membershipA })).rejects.toBeInstanceOf(InvalidMembershipSelectionError);
    expect(database.userRefreshSession.create).not.toHaveBeenCalled();
    expect(database.userRefreshSession.updateMany).not.toHaveBeenCalled();
    expect(database.order.create).not.toHaveBeenCalled();
    expect(database.customerEntity.create).not.toHaveBeenCalled();
  });

  it("refreshes only the exact stored eligible context and rotates atomically", async () => {
    database.companyMembership.findMany.mockResolvedValue([membership()]);
    database.companyMembership.findFirst.mockResolvedValue(membership());
    const login = await loginUser({ email: "user@example.test", password: "correct-password" });
    const saved = database.userRefreshSession.create.mock.calls[0][0].data;
    database.userRefreshSession.create.mockClear(); database.$transaction.mockClear();
    database.userRefreshSession.findUnique.mockResolvedValue({ ...saved, user: { id: ids.user }, revokedAt: null });

    const refreshed = await refreshUserSession({ refreshToken: login.refreshToken });
    const nextAccess = jwt.verify(refreshed.token, secret) as any;
    expect(nextAccess).toMatchObject({ companyMembershipId: ids.membershipA,
      companyId: ids.companyA, tenantId: ids.tenantA, tenantMembershipId: ids.tenantMembershipA });
    expect(database.userRefreshSession.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ companyMembershipId: ids.membershipA,
        tenantId: ids.tenantA, tenantMembershipId: ids.tenantMembershipA, revokedAt: null,
        expiresAt: { gt: expect.any(Date) },
        tenant: { is: { id: ids.tenantA, status: "active" } },
        companyMembership: { is: {
          id: ids.membershipA, userId: ids.user, tenantId: ids.tenantA,
          tenantMembershipId: ids.tenantMembershipA, companyId: ids.companyA,
          status: "active",
          company: { is: { id: ids.companyA, tenantId: ids.tenantA, type: "company", isActive: true } },
          tenantMembership: { is: { id: ids.tenantMembershipA, userId: ids.user, tenantId: ids.tenantA, status: "active" } },
        } },
      }),
    }));
    expect(database.userRefreshSession.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
      companyMembershipId: ids.membershipA, tenantId: ids.tenantA,
      tenantMembershipId: ids.tenantMembershipA,
    }) }));
    expect(database.$transaction).toHaveBeenCalledTimes(1);
  });

  it("rejects failed consumption after eligible prechecks without issuing a replacement", async () => {
    database.companyMembership.findMany.mockResolvedValue([membership()]);
    database.companyMembership.findFirst.mockResolvedValue(membership());
    const login = await loginUser({ email: "user@example.test", password: "correct-password" });
    const saved = database.userRefreshSession.create.mock.calls[0][0].data;
    database.userRefreshSession.create.mockClear(); database.$transaction.mockClear();
    database.userRefreshSession.findUnique.mockResolvedValue({ ...saved, user: { id: ids.user }, revokedAt: null });
    database.userRefreshSession.updateMany.mockResolvedValue({ count: 0 });
    await expect(refreshUserSession({ refreshToken: login.refreshToken })).rejects.toThrow("revoked");
    expect(database.userRefreshSession.create).not.toHaveBeenCalled();
  });

  it("rejects revoked, legacy-unbound and mismatched refresh contexts without rotation", async () => {
    const legacy = jwt.sign({ id: ids.user, sid: "legacy-session", tokenType: "refresh" }, secret);
    await expect(refreshUserSession({ refreshToken: legacy })).rejects.toThrow("fresh login");
    expect(database.userRefreshSession.findUnique).not.toHaveBeenCalled();

    database.companyMembership.findMany.mockResolvedValue([membership()]);
    database.companyMembership.findFirst.mockResolvedValue(membership());
    const login = await loginUser({ email: "user@example.test", password: "correct-password" });
    const saved = database.userRefreshSession.create.mock.calls[0][0].data;
    database.userRefreshSession.create.mockClear(); database.$transaction.mockClear();
    database.userRefreshSession.findUnique.mockResolvedValue({ ...saved, revokedAt: new Date(), user: { id: ids.user } });
    await expect(refreshUserSession({ refreshToken: login.refreshToken })).rejects.toThrow("revoked");

    database.userRefreshSession.findUnique.mockResolvedValue({ ...saved,
      tenantMembershipId: ids.tenantMembershipB, revokedAt: null, user: { id: ids.user } });
    await expect(refreshUserSession({ refreshToken: login.refreshToken })).rejects.toThrow("context mismatch");
    expect(database.$transaction).not.toHaveBeenCalled();
    expect(database.userRefreshSession.updateMany).not.toHaveBeenCalled();
    expect(database.userRefreshSession.create).not.toHaveBeenCalled();
  });

  it("rejects refresh when the exact stored membership is no longer eligible", async () => {
    database.companyMembership.findMany.mockResolvedValue([membership()]);
    database.companyMembership.findFirst.mockResolvedValue(membership());
    const login = await loginUser({ email: "user@example.test", password: "correct-password" });
    const saved = database.userRefreshSession.create.mock.calls[0][0].data;
    database.userRefreshSession.create.mockClear(); database.$transaction.mockClear();
    database.userRefreshSession.findUnique.mockResolvedValue({ ...saved, revokedAt: null, user: { id: ids.user } });
    database.companyMembership.findFirst.mockResolvedValue(membership({ status: "suspended" }));

    await expect(refreshUserSession({ refreshToken: login.refreshToken }))
      .rejects.toThrow("no longer eligible");
    expect(database.$transaction).not.toHaveBeenCalled();
    expect(database.userRefreshSession.updateMany).not.toHaveBeenCalled();
    expect(database.userRefreshSession.create).not.toHaveBeenCalled();
  });

  it.each([256, 257, -1, 0.5])("requires fresh login at invalid/exhausted rotation depth %s without consuming or creating", async rotationDepth => {
    database.companyMembership.findMany.mockResolvedValue([membership()]);
    database.companyMembership.findFirst.mockResolvedValue(membership());
    const login = await loginUser({ email: "user@example.test", password: "correct-password" });
    const saved = database.userRefreshSession.create.mock.calls[0][0].data;
    database.userRefreshSession.create.mockClear(); database.$transaction.mockClear();
    database.userRefreshSession.findUnique.mockResolvedValue({ ...saved, rotationDepth, revokedAt: null, user: { id: ids.user } });
    await expect(refreshUserSession({ refreshToken: login.refreshToken })).rejects.toThrow("fresh login");
    expect(database.$transaction).not.toHaveBeenCalled();
    expect(database.userRefreshSession.updateMany).not.toHaveBeenCalled();
    expect(database.userRefreshSession.create).not.toHaveBeenCalled();
  });

  it("rejects forged or mismatched access-token context before granting HTTP access", async () => {
    const app = Fastify();
    app.get("/protected", { preHandler: fastifyAuth() }, async (request) => ({ user: request.user }));
    await app.ready();
    try {
      const internallyMismatched = jwt.sign({ id: ids.user, membershipId: ids.membershipA,
        companyMembershipId: ids.membershipB, companyId: ids.companyA, tenantId: ids.tenantA,
        tenantMembershipId: ids.tenantMembershipA, tokenType: "access" }, secret);
      let response = await app.inject({ url: "/protected", headers: { authorization: `Bearer ${internallyMismatched}` } });
      expect(response.statusCode).toBe(401);
      expect(database.companyMembership.findFirst).not.toHaveBeenCalled();

      database.companyMembership.findFirst.mockResolvedValue(membership());
      const forgedCompany = jwt.sign({ id: ids.user, membershipId: ids.membershipA,
        companyMembershipId: ids.membershipA, companyId: ids.companyB, tenantId: ids.tenantA,
        tenantMembershipId: ids.tenantMembershipA, tokenType: "access" }, secret);
      response = await app.inject({ url: "/protected", headers: { authorization: `Bearer ${forgedCompany}` } });
      expect(response.statusCode).toBe(401);

      const valid = jwt.sign({ id: ids.user, sid: ids.user, membershipId: ids.membershipA,
        companyMembershipId: ids.membershipA, companyId: ids.companyA, tenantId: ids.tenantA,
        tenantMembershipId: ids.tenantMembershipA, tokenType: "access" }, secret, { expiresIn: "1h" });
      database.companyMembership.findFirst.mockResolvedValue(membership());
      response = await app.inject({ url: "/protected", headers: { authorization: `Bearer ${valid}` } });
      expect(response.statusCode).toBe(200);
      database.companyMembership.findFirst.mockResolvedValue(membership({ status: "suspended" }));
      response = await app.inject({ url: "/protected", headers: { authorization: `Bearer ${valid}` } });
      expect(response.statusCode).toBe(401);
    } finally { await app.close(); }
  });

  it("does not select an arbitrary membership when more than one is eligible", async () => {
    database.companyMembership.findMany.mockResolvedValue([sameTenantMembershipB(), membership()]);
    await expect(loginUser({ email: "user@example.test", password: "correct-password" }))
      .rejects.toBeInstanceOf(MembershipSelectionRequiredError);
    expect(database.companyMembership.findFirst).not.toHaveBeenCalled();
    expect(database.userRefreshSession.create).not.toHaveBeenCalled();
  });

  it("keeps cached access snapshots isolated by selected company membership", async () => {
    database.companyMembership.findFirst
      .mockResolvedValueOnce(membership())
      .mockResolvedValueOnce(sameTenantMembershipB());

    const first = await loadAccessSnapshot({ userId: ids.user, membershipId: ids.membershipA });
    const second = await loadAccessSnapshot({ userId: ids.user, membershipId: ids.membershipB });

    expect(first).toMatchObject({ companyMembershipId: ids.membershipA, companyId: ids.companyA });
    expect(second).toMatchObject({ companyMembershipId: ids.membershipB, companyId: ids.companyB });
    expect(database.companyMembership.findFirst).toHaveBeenCalledTimes(2);
  });
});

describe("accepted login security audit",()=>{
 const previousEnv=process.env;
 beforeEach(()=>{process.env={...previousEnv,NODE_ENV:"test",JWT_SECRET:secret,REFRESH_TOKEN_SECRET:secret};resetDatabaseMocks();database.companyMembership.findMany.mockResolvedValue([membership()]);database.companyMembership.findFirst.mockResolvedValue(membership());});
 afterAll(()=>{process.env=previousEnv;});
 it("accepted login appends exact selected ownership in the session transaction without sensitive fields",async()=>{
  await loginUser({email:"user@example.test",password:"correct-password",companyMembershipId:ids.membershipA});
  expect(database.credentialSecurityEvent.create).toHaveBeenCalledWith({data:{actorUserId:ids.user,tenantId:ids.tenantA,tenantMembershipId:ids.tenantMembershipA,companyId:ids.companyA,companyMembershipId:ids.membershipA,action:"LOGIN_ACCEPTED"}});
  expect(database.$transaction).toHaveBeenCalledTimes(1);expect(database.userRefreshSession.create.mock.invocationCallOrder[0]).toBeLessThan(database.credentialSecurityEvent.create.mock.invocationCallOrder[0]);
 });
 it.each(["credentials","selection","foreign"])("%s rejection issues no accepted audit or session",async kind=>{
  if(kind==="selection")database.companyMembership.findMany.mockResolvedValue([membership(),sameTenantMembershipB()]);
  if(kind==="foreign")database.companyMembership.findFirst.mockResolvedValue(null);
  await expect(loginUser({email:"user@example.test",password:kind==="credentials"?"wrong":"correct-password",...(kind==="foreign"?{companyMembershipId:ids.membershipB}:{})})).rejects.toBeDefined();
  expect(database.credentialSecurityEvent.create).not.toHaveBeenCalled();expect(database.userRefreshSession.create).not.toHaveBeenCalled();
 });
 it("audit failure cannot return issued tokens; actual rollback is separately tested in PostgreSQL",async()=>{
  database.credentialSecurityEvent.create.mockRejectedValue(Error("synthetic login audit failure"));
  await expect(loginUser({email:"user@example.test",password:"correct-password",companyMembershipId:ids.membershipA})).rejects.toThrow("audit failure");
 });
});
