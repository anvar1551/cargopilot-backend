import Fastify from "fastify";
import jwt from "jsonwebtoken";
import routes from "../../src/modules/warehouse-core/transport/fastify-routes";
import { loadAccessSnapshot } from "../../src/modules/identity-access/access-control";
import { database, sensitiveUser, expectNoSensitiveFields, expectNoDatabaseCalls } from "./fixtures";

jest.mock("../../src/config/prismaClient", () => ({ __esModule: true, default: require("./fixtures").database }));
jest.mock("../../src/modules/identity-access/access-control", () => ({
  ...jest.requireActual("../../src/modules/identity-access/access-control"), loadAccessSnapshot: jest.fn(),
}));

const secret = "synthetic-warehouse-tests-key";
const base = {
  id: "warehouse-a", name: "Warehouse A", type: "warehouse", location: "Test location",
  region: null, latitude: null, longitude: null, createdAt: new Date("2026-01-01"),
};
const dirty = {
  ...base, secret: "SENSITIVE-CANARY", users: [sensitiveUser, { ...sensitiveUser, id: "user-b" }],
  orders: [{ id: "order-a", orderNumber: "123", status: "pending", serviceType: null,
    createdAt: base.createdAt, updatedAt: base.createdAt, customer: sensitiveUser,
    assignedDriver: sensitiveUser, tracking: [{ actor: sensitiveUser }], senderPhone: "SENSITIVE-CANARY" }],
};
const snapshot = {
  userId: "user-a", membershipId: "membership-a", companyId: "company-a", branchId: null,
  name: "Worker", email: "worker@example.test", warehouseId: "warehouse-a", customerEntityId: null,
  roleCodes: ["worker"], permissionCodes: ["shipment.view", "shipment.update"],
  scopes: [{ scopeType: "warehouse" as const, scopeRefId: "warehouse-a" }],
};

describe("warehouse recursive response boundary (mocked DB, real routes/repository)", () => {
  const originalEnv = { ...process.env };
  beforeEach(() => {
    process.env.JWT_SECRET = secret;
    jest.mocked(loadAccessSnapshot).mockResolvedValue(snapshot);
    database.companyMembership.findFirst.mockResolvedValue(null);
    database.warehouse.findMany.mockResolvedValue([dirty, { ...dirty, id: "warehouse-b" }]);
    database.warehouse.findUnique.mockResolvedValue(dirty);
    database.warehouse.create.mockResolvedValue(dirty);
    database.warehouse.update.mockResolvedValue(dirty);
  });
  afterEach(() => { process.env = { ...originalEnv }; });

  async function app() {
    const server = Fastify();
    await server.register(routes, { prefix: "/api/warehouses" });
    return server;
  }
  function headers() {
    return { authorization: `Bearer ${jwt.sign({ id: "user-a", membershipId: "membership-a", tokenType: "access" }, secret)}` };
  }

  it.each([
    ["GET", "/api/warehouses", "findMany", 200],
    ["GET", "/api/warehouses/warehouse-a", "findUnique", 200],
    ["POST", "/api/warehouses", "create", 201],
    ["PUT", "/api/warehouses/warehouse-a", "update", 200],
  ] as const)("projects %s %s including unexpected nested model fields", async (method, url, operation, status) => {
    const server = await app();
    try {
      const result = await server.inject({ method, url, headers: headers(),
        ...(method === "POST" || method === "PUT" ? { payload: { name: base.name, location: base.location } } : {}),
      });
      expect(result.statusCode).toBe(status);
      expectNoSensitiveFields(result.json());
      const call = database.warehouse[operation].mock.calls[0][0];
      expect(call).not.toHaveProperty("include");
      expect(call.select).toBeDefined();
      if (operation === "findUnique") {
        expect(call.select.users.select).toEqual({ id: true, name: true, driverType: true });
        expect(result.json().users).toEqual([
          { id: "user-a", name: sensitiveUser.name, driverType: "local" },
          { id: "user-b", name: sensitiveUser.name, driverType: "local" },
        ]);
        expect(Object.keys(result.json().orders[0]).sort()).toEqual(["createdAt", "id", "orderNumber", "serviceType", "status", "updatedAt"]);
      } else {
        const row = Array.isArray(result.json()) ? result.json()[0] : result.json();
        expect(row).not.toHaveProperty("users");
        expect(row).toEqual(JSON.parse(JSON.stringify(base)));
      }
    } finally { await server.close(); }
  });

  it.each(["findMany", "findUnique", "create", "update"])("sanitizes %s exceptions recursively", async (operation) => {
    database.warehouse[operation].mockRejectedValueOnce(Object.assign(new Error("SENSITIVE-CANARY"), sensitiveUser));
    const methods = { findMany: "GET", findUnique: "GET", create: "POST", update: "PUT" } as const;
    const server = await app();
    try {
      const result = await server.inject({ method: methods[operation as keyof typeof methods],
        url: `/api/warehouses${["findUnique", "update"].includes(operation) ? "/warehouse-a" : ""}`,
        headers: headers(), ...(["create", "update"].includes(operation) ? { payload: { name: "A", location: "B" } } : {}),
      });
      expect(result.statusCode).toBe(500);
      expectNoSensitiveFields(result.json());
    } finally { await server.close(); }
  });

  it("preserves safe validation and not-found responses", async () => {
    const server = await app();
    database.warehouse.findUnique.mockResolvedValueOnce(null);
    try {
      const missing = await server.inject({ url: "/api/warehouses/missing", headers: headers() });
      expect(missing.statusCode).toBe(404);
      expectNoSensitiveFields(missing.json());
      const invalid = await server.inject({ method: "POST", url: "/api/warehouses", headers: headers(), payload: {} });
      expect(invalid.statusCode).toBe(400);
      expectNoSensitiveFields(invalid.json());
      expect(database.warehouse.create).not.toHaveBeenCalled();
    } finally { await server.close(); }
  });

  it("denies anonymous requests before reads or writes", async () => {
    const server = await app();
    try {
      for (const [method, url] of [["GET", "/api/warehouses"], ["GET", "/api/warehouses/warehouse-b"], ["POST", "/api/warehouses"], ["PUT", "/api/warehouses/warehouse-b"]] as const) {
        const result = await server.inject({ method, url });
        expect(result.statusCode).toBe(401);
        expectNoSensitiveFields(result.json());
      }
      expectNoDatabaseCalls();
    } finally { await server.close(); }
  });

  it("denies missing permissions without warehouse reads/writes", async () => {
    jest.mocked(loadAccessSnapshot).mockResolvedValue({ ...snapshot, permissionCodes: [] });
    const server = await app();
    try {
      const result = await server.inject({ url: "/api/warehouses/warehouse-b", headers: headers() });
      expect(result.statusCode).toBe(403);
      expectNoSensitiveFields(result.json());
      expect(database.warehouse.findUnique).not.toHaveBeenCalled();
    } finally { await server.close(); }
  });
});
