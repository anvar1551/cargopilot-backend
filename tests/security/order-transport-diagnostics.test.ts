jest.mock("../../src/config/prismaClient", () => ({ __esModule: true, default: require("./fixtures").database }));
jest.mock("../../src/middleware/analyticsInvalidate", () => ({ emitAnalyticsInvalidationForMutation: jest.fn() }));
jest.mock("../../src/modules/identity-access", () => ({ authorize: jest.fn(), buildOrderScopeWhere: jest.fn() }));
import { sendError, emitMutationInvalidation } from "../../src/modules/orders-core/transport/shared";
import { emitAnalyticsInvalidationForMutation } from "../../src/middleware/analyticsInvalidate";
import { expectNoDatabaseCalls } from "./fixtures";

const canary = "UNTRUSTED-DIAGNOSTIC-CANARY";
let errorLog: jest.SpyInstance;
let warningLog: jest.SpyInstance;
beforeEach(() => {
  errorLog = jest.spyOn(console, "error").mockImplementation(() => undefined);
  warningLog = jest.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => { errorLog.mockRestore(); warningLog.mockRestore(); expectNoDatabaseCalls(); });
it.each([undefined, 500, 503, "500", 200, 999])("sanitizes unexpected request errors for status %s", (statusCode) => {
  const reply = { code: jest.fn().mockReturnThis(), send: jest.fn() };
  sendError(reply, Object.assign(new Error(canary), { stack: canary, statusCode }), "Failed to import orders");
  const expected = statusCode === 503 ? 503 : 500;
  expect(reply.code).toHaveBeenCalledWith(expected);
  expect(reply.send).toHaveBeenCalledWith({ error: "Failed to import orders" });
  expect(errorLog).toHaveBeenCalledWith("ORDER_REQUEST_FAILED", { statusCode: expected });
  expect(JSON.stringify([reply.send.mock.calls, errorLog.mock.calls])).not.toContain(canary);
});
it("preserves expected client-error status and business message", () => {
  const reply = { code: jest.fn().mockReturnThis(), send: jest.fn() };
  sendError(reply, { statusCode: 409, message: "Operation identity conflict" });
  expect(reply.code).toHaveBeenCalledWith(409);
  expect(reply.send).toHaveBeenCalledWith({ error: "Operation identity conflict" });
  expect(errorLog).not.toHaveBeenCalled();
});
it("sanitizes best-effort analytics invalidation failures", async () => {
  (emitAnalyticsInvalidationForMutation as jest.Mock).mockRejectedValueOnce(Object.assign(new Error(canary), { stack: canary }));
  await expect(emitMutationInvalidation("order_mutation")).resolves.toBeUndefined();
  expect(warningLog).toHaveBeenCalledWith("ORDER_ANALYTICS_INVALIDATION_SKIPPED", { reason: "order_mutation" });
  expect(JSON.stringify(warningLog.mock.calls)).not.toContain(canary);
});
