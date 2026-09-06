import Fastify from "fastify";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import routes from "../../src/modules/identity-access/transport/fastify-routes";
import * as authService from "../../src/modules/identity-access/application/auth.service";
import { loadAccessSnapshot, clearIdentityAccessCacheForUser } from "../../src/modules/identity-access/access-control";
import { BoundedLocalRateLimitStore, createAbuseRateLimiter } from "../../src/shared/http/abuseRateLimit";
import { database, databaseCalls, expectNoDatabaseCalls, expectNoSensitiveFields } from "./fixtures";

jest.mock("../../src/config/prismaClient", () => ({ __esModule: true, default: require("./fixtures").database }));
jest.mock("../../src/config/redis", () => ({
  getRedisClient: jest.fn(async () => null), getRedisPrefix: () => "test",
  withRedisTimeout: async (_name: string, work: () => Promise<unknown>) => work(),
}));
jest.mock("../../src/modules/identity-access/access-control", () => ({
  ...jest.requireActual("../../src/modules/identity-access/access-control"),
  loadAccessSnapshot: jest.fn(), clearIdentityAccessCacheForUser: jest.fn(),
}));

const keySecret = "synthetic-phase-0a-key-32-characters-long";
const snapshot = {
  userId: "user-a", membershipId: "membership-a", companyId: "company-a", branchId: null,
  name: "Alice", email: "alice@example.test", warehouseId: "warehouse-a", customerEntityId: null,
  roleCodes: ["worker"], permissionCodes: [], scopes: [{ scopeType: "warehouse" as const, scopeRefId: "warehouse-a" }],
};
const sessionToken = () => jwt.sign({ id: "user-a", membershipId: "membership-a", tokenType: "access" }, process.env.JWT_SECRET!);
const hash = bcrypt.hashSync("test-password", 10);

describe("Phase 0A identity routes (real services, mocked database)", () => {
  const originalEnv = { ...process.env };
  beforeEach(() => {
    process.env = { NODE_ENV: "test", JWT_SECRET: keySecret, REFRESH_TOKEN_SECRET: keySecret,
      AUTH_RATE_LIMIT_MAX: "2" };
    databaseCalls.length = 0;
    jest.mocked(loadAccessSnapshot).mockResolvedValue(snapshot);
    database.companyMembership.findFirst.mockResolvedValue(null);
  });
  afterEach(() => { process.env = { ...originalEnv }; jest.restoreAllMocks(); });

  async function appWith(limiter = createAbuseRateLimiter({ sharedStore: new BoundedLocalRateLimitStore() })) {
    const app = Fastify();
    await app.register(routes, { prefix: "/api/auth", rateLimiter: limiter });
    return app;
  }

  it("rejects every enrollment payload, including malformed JSON, without business effects", async () => {
    const consume = jest.fn();
    const app = await appWith({ consume });
    const create = jest.spyOn(authService, "createUserByCompanyAdmin");
    const sign = jest.spyOn(jwt, "sign");
    const hashPassword = jest.spyOn(bcrypt, "hash");
    const payloads: unknown[] = [
      {}, { email: "existing@example.test" }, { email: "new@example.test" },
      ...["company-a", "company-b"].flatMap((companyId) => ["super_admin", "owner", "manager"].map((role) => ({
        name: "Attacker", email: "new@example.test", password: "test-password",
        companyId, tenantId: companyId, roleCodes: [role], role, isAdmin: true,
        permissions: ["*"], membershipId: "victim-membership", warehouseId: "warehouse-b",
        scopes: [{ scopeType: "company", scopeRefId: companyId }],
      }))),
      "{malformed-json", "x".repeat(20000),
    ];
    try {
      for (const payload of payloads) {
        const result = await app.inject({ method: "POST", url: "/api/auth/register",
          headers: { "content-type": "application/json" }, payload: payload as any });
        expect(result.statusCode).toBe(403);
        expect(result.json()).toEqual({ error: "Registration is unavailable" });
        expect(result.headers["cache-control"]).toBe("no-store");
      }
      // This denial needs no DB calls. Sanitized security telemetry is allowed by policy.
      expect(databaseCalls).toEqual([]);
      expectNoDatabaseCalls();
      expect(create).not.toHaveBeenCalled();
      expect(sign).not.toHaveBeenCalled();
      expect(hashPassword).not.toHaveBeenCalled();
      expect(loadAccessSnapshot).not.toHaveBeenCalled();
      expect(clearIdentityAccessCacheForUser).not.toHaveBeenCalled();
      expect(consume).not.toHaveBeenCalled();
      expect((authService as any).registerUser).toBeUndefined();
    } finally { await app.close(); }
  });

  it.each([
    ["anonymous", []],
    ["worker", []],
    ["inviter", ["membership.invite"]],
    ["super_admin", ["membership.invite", "role.bindPermissions"]],
  ] as const)("contains administrative creation for %s, including system-role and foreign-scope payloads", async (role, permissions) => {
    jest.mocked(loadAccessSnapshot).mockResolvedValue({ ...snapshot,
      roleCodes: [role], permissionCodes: [...permissions],
    });
    const headers = role === "anonymous" ? {} : { authorization: `Bearer ${sessionToken()}` };
    const consume = jest.fn();
    const app = await appWith({ consume });
    const create = jest.spyOn(authService, "createUserByCompanyAdmin");
    const sign = jest.spyOn(jwt, "sign");
    const hashPassword = jest.spyOn(bcrypt, "hash");
    const bodies = [
      { name: "New worker", email: "new@example.test", password: "test-password", roleCodes: ["worker"] },
      { companyId: "company-a", roleCodes: ["super_admin"], isAdmin: true, permissions: ["*"] },
      { companyId: "company-b", tenantId: "tenant-b", roleCodes: ["owner"],
        membershipId: "membership-b", branchId: "branch-b", warehouseId: "warehouse-b", customerEntityId: "customer-b",
        scopes: [{ scopeType: "company", scopeRefId: "company-b" }, { scopeType: "warehouse", scopeRefId: "warehouse-b" }] },
      { companyId: "company-a", warehouseId: "warehouse-a", roleCodes: ["worker"],
        scopes: [{ scopeType: "warehouse", scopeRefId: "warehouse-a" }] },
    ];
    try {
      for (const url of ["/api/auth", "/api/auth/"]) {
        for (const payload of bodies) {
          const result = await app.inject({ method: "POST", url, headers, payload });
          expect(result.statusCode).toBe(403);
          expect(result.json()).toEqual({ error: "User creation is unavailable" });
          expect(result.headers["cache-control"]).toBe("no-store");
          expectNoSensitiveFields(result.json());
        }
        const malformed = await app.inject({ method: "POST", url,
          headers: { ...headers, "content-type": "application/json" }, payload: "{malformed-json" });
        expect(malformed.statusCode).toBe(403);
        expect(malformed.json()).toEqual({ error: "User creation is unavailable" });
      }
      expectNoDatabaseCalls(); // No user/membership/role/scope/session/outbox mutations.
      expect(create).not.toHaveBeenCalled();
      expect(sign).not.toHaveBeenCalled();
      expect(hashPassword).not.toHaveBeenCalled();
      expect(loadAccessSnapshot).not.toHaveBeenCalled();
      expect(clearIdentityAccessCacheForUser).not.toHaveBeenCalled();
      expect(consume).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });

  it("keeps an authenticated inviter's session usable while creation is contained", async () => {
    const inviter = { ...snapshot, permissionCodes: ["membership.invite"] };
    jest.mocked(loadAccessSnapshot).mockResolvedValue(inviter);
    const app = await appWith();
    const headers = { authorization: `Bearer ${sessionToken()}` };
    const create = jest.spyOn(authService, "createUserByCompanyAdmin");
    try {
      const before = await app.inject({ url: "/api/auth/me", headers });
      expect(before.statusCode).toBe(200);
      expect(before.json().user.permissionCodes).toContain("membership.invite");
      const result = await app.inject({ method: "POST", url: "/api/auth", headers,
        payload: { name: "New user", email: "new@example.test", password: "test-password", roleCodes: ["super_admin"] } });
      expect(result.statusCode).toBe(403);
      const after = await app.inject({ url: "/api/auth/me", headers });
      expect(after.statusCode).toBe(200);
      expect(after.json()).toEqual(before.json());
      expect(create).not.toHaveBeenCalled();
      expectNoDatabaseCalls();
    } finally { await app.close(); }
  });

  it("preserves successful login and refresh response contracts with actual signing/hashing", async () => {
    database.user.findUnique.mockResolvedValue({ id: "user-a", password: hash });
    database.companyMembership.findFirst.mockResolvedValue({ id: "membership-a", companyId: "company-a", branchId: null });
    database.userRefreshSession.create.mockResolvedValue({});
    database.userRefreshSession.update.mockResolvedValue({});
    const app = await appWith();
    try {
      const login = await app.inject({ method: "POST", url: "/api/auth/login",
        payload: { email: " Alice@example.test ", password: "test-password", companyId: "company-b", roleCodes: ["super_admin"] } });
      expect(login.statusCode).toBe(200);
      const body = login.json();
      expect(body.user).toEqual(snapshot);
      expect(body.accessTokenExpiresInSec).toBeGreaterThan(0);
      const access = jwt.verify(body.token, keySecret) as any;
      expect(access).toMatchObject({ id: "user-a", companyId: "company-a", membershipId: "membership-a", tokenType: "access" });
      const saved = database.userRefreshSession.create.mock.calls.slice(-1)[0][0].data;
      expect(saved.tokenHash).not.toBe(body.refreshToken);
      expect(saved.ipAddress).toBe("127.0.0.1");
      database.userRefreshSession.findUnique.mockResolvedValue({ ...saved, user: { id: "user-a" }, revokedAt: null });
      const refreshed = await app.inject({ method: "POST", url: "/api/auth/refresh", payload: { refreshToken: body.refreshToken } });
      expect(refreshed.statusCode).toBe(200);
      expect(refreshed.json().user).toEqual(snapshot);
      expect(refreshed.json().refreshToken).not.toBe(body.refreshToken);
      expect(database.userRefreshSession.update).toHaveBeenCalledWith(expect.objectContaining({ data: { revokedAt: expect.any(Date) } }));
      expect(body.user).not.toHaveProperty("password");
      expect(refreshed.json()).not.toHaveProperty("tokenHash");
    } finally { await app.close(); }
  });

  it.each(["unknown", "wrong-password", "inactive-membership"])("returns the same error for %s", async (state) => {
    const compare = jest.spyOn(bcrypt, "compare");
    database.user.findUnique.mockResolvedValue(state === "unknown" ? null : { id: "user-a", password: hash });
    database.companyMembership.findFirst.mockResolvedValue(null);
    const app = await appWith();
    try {
      const result = await app.inject({ method: "POST", url: "/api/auth/login",
        payload: { email: "alice@example.test", password: state === "wrong-password" ? "wrong" : "test-password" } });
      expect(result.statusCode).toBe(401);
      expect(result.json()).toEqual({ error: "Invalid credentials" });
      expect(compare).toHaveBeenCalledTimes(1);
      expect(database.userRefreshSession.create).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });

  it("limits bursts despite spoofed IPs and shares normalized principal keys across IPs", async () => {
    const login = jest.spyOn(authService, "loginUser").mockRejectedValue(new Error("Invalid email or password"));
    const app = await appWith();
    try {
      for (let i = 0; i < 3; i++) {
        const result = await app.inject({ method: "POST", url: "/api/auth/login",
          headers: { "x-forwarded-for": `198.51.100.${i}`, "x-real-ip": `198.51.100.${i}` },
          payload: { email: `user${i}@example.test`, password: "wrong" } });
        expect(result.statusCode).toBe(i < 2 ? 401 : 429);
      }
      for (let i = 0; i < 3; i++) {
        const result = await app.inject({ method: "POST", url: "/api/auth/login", remoteAddress: `192.0.2.${i + 1}`,
          payload: { email: i % 2 ? " Alice@example.test " : "alice@example.test", password: "wrong" } });
        expect(result.statusCode).toBe(i < 2 ? 401 : 429);
      }
      expect(login).toHaveBeenCalledTimes(4);
    } finally { await app.close(); }
  });

  it.each(["login", "refresh", "logout", "change-password"])("fails closed on %s with no service calls or writes", async (route) => {
    const limiter = createAbuseRateLimiter({ environment: "production", keySecret,
      sharedStore: { consume: async () => { throw new Error("private Redis detail"); } } });
    const app = await appWith(limiter);
    try {
      const result = await app.inject({ method: "POST", url: `/api/auth/${route}`, payload: {} });
      expect(result.statusCode).toBe(503);
      expect(result.json()).toEqual({ error: "Request cannot be processed" });
      expect(databaseCalls).toEqual([]);
      expectNoDatabaseCalls();
      expect(loadAccessSnapshot).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });

  it.each(["refresh", "logout"])("limits %s bursts before session service effects", async (route) => {
    const service = route === "refresh"
      ? jest.spyOn(authService, "refreshUserSession").mockRejectedValue(new Error("Invalid refresh token"))
      : jest.spyOn(authService, "revokeRefreshSession").mockResolvedValue(undefined);
    const app = await appWith();
    try {
      for (let i = 0; i < 3; i++) {
        const result = await app.inject({ method: "POST", url: `/api/auth/${route}`,
          payload: { refreshToken: "synthetic-refresh-token" } });
        expect(result.statusCode).toBe(i === 2 ? 429 : route === "refresh" ? 401 : 200);
      }
      expect(service).toHaveBeenCalledTimes(2);
      expectNoDatabaseCalls();
    } finally { await app.close(); }
  });

  it("limits password guesses by authenticated identity across source IPs", async () => {
    const service = jest.spyOn(authService, "changeUserPassword").mockResolvedValue(undefined);
    const app = await appWith();
    try {
      for (let i = 0; i < 3; i++) {
        const result = await app.inject({ method: "POST", url: "/api/auth/change-password", remoteAddress: `192.0.2.${i + 1}`,
          headers: { authorization: `Bearer ${sessionToken()}` },
          payload: { currentPassword: "old-password", newPassword: "new-password" } });
        expect(result.statusCode).toBe(i < 2 ? 200 : 429);
      }
      expect(service).toHaveBeenCalledTimes(2);
      expectNoDatabaseCalls();
    } finally { await app.close(); }
  });

  it("sanitizes refresh validation, invalid tokens and internal failures", async () => {
    const app = await appWith();
    try {
      for (const refreshToken of ["short", "invalid-long-refresh-token"]) {
        const result = await app.inject({ method: "POST", url: "/api/auth/refresh", payload: { refreshToken } });
        expect(result.statusCode).toBe(401);
        expect(result.json()).toEqual({ error: "Invalid session" });
      }
      database.user.findUnique.mockRejectedValueOnce(new Error("SENSITIVE-CANARY token database error"));
      const result = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "alice@example.test", password: "wrong" } });
      expect(result.statusCode).toBe(500);
      expectNoSensitiveFields(result.json());
    } finally { await app.close(); }
  });
});
