// In-process tests never instantiate Prisma or connect to a service.
export const databaseCalls: Array<{ model: string; method: string; args: unknown[] }> = [];
const databaseSpies: jest.Mock[] = [];
export function expectNoDatabaseCalls() {
  databaseSpies.forEach((spy) => expect(spy).not.toHaveBeenCalled());
}
const models = new Map<string, unknown>();
export const database = new Proxy({} as any, {
  get(_target, model: string) {
    if (!models.has(model)) {
      const method = (name: string) => {
        const spy = jest.fn((...args: unknown[]) => {
          databaseCalls.push({ model, method: name, args });
          throw new Error(`Unexpected database operation: ${model}.${name}`);
        });
        databaseSpies.push(spy);
        return spy;
      };
      models.set(model, model.startsWith("$") ? method(model) : new Proxy({}, {
        get(target: any, name: string) { return target[name] ??= method(name); },
      }));
    }
    return models.get(model);
  },
});

export const sensitiveUser = {
  id: "user-a", name: "Warehouse worker", driverType: "local",
  email: "private@example.test", password: "SENSITIVE-CANARY", passwordHash: "SENSITIVE-CANARY",
  tokenHash: "SENSITIVE-CANARY", refreshToken: "SENSITIVE-CANARY",
  resetSecret: "SENSITIVE-CANARY", internalCredentials: "SENSITIVE-CANARY",
  liveLocationEnabled: true, ipAddress: "SENSITIVE-CANARY", userAgent: "SENSITIVE-CANARY",
  refreshSessions: [{ tokenHash: "SENSITIVE-CANARY" }],
  nested: { recovery: [{ secret: "SENSITIVE-CANARY" }] },
};

export function expectNoSensitiveFields(value: unknown): void {
  if (Array.isArray(value)) { value.forEach(expectNoSensitiveFields); return; }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      expect(key).not.toMatch(/password|token|secret|credential|session|recovery|reset|userAgent|ipAddress|liveLocation/i);
      expectNoSensitiveFields(child);
    }
  } else if (typeof value === "string") {
    expect(value).not.toContain("SENSITIVE-CANARY");
    expect(value).not.toContain("private@example.test");
  }
}
