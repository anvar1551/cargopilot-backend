jest.mock("../../src/modules/orders-core/proofs/proof", () => ({ requireProofSubmissionContext: jest.fn() }));
jest.mock("../../src/modules/orders-core", () => ({ requireOrderActor: (user: any) => user, submitProofForActor: jest.fn(), listOrderProofLinksForActor: jest.fn() }));
jest.mock("../../src/modules/orders-core/transport/shared", () => ({
  emitMutationInvalidation: jest.fn(async () => undefined), fieldValue: (v: any) => v?.value,
  parseMaxPhotoBytes: () => 1024 * 1024, sendError: (reply: any, error: any) => reply.code(error.statusCode ?? 500).send({ error: "Denied" }),
}));
jest.mock("../../src/modules/identity-access/transport/fastify-auth", () => ({ fastifyAuth: () => async (req: any, reply: any) => {
  if (!req.headers["x-synthetic-auth"]) return reply.code(401).send({ error: "Unauthorized" });
  req.user = { id: "driver", companyMembershipId: "exact-member", tenantId: "tenant", companyId: "company" };
} }));
import Fastify from "fastify";
import routes from "../../src/modules/orders-core/transport/routes/proofs.routes";
import { requireProofSubmissionContext } from "../../src/modules/orders-core/proofs/proof";
import { submitProofForActor } from "../../src/modules/orders-core";
const headers = { "x-synthetic-auth": "yes" };
beforeEach(() => {
  jest.clearAllMocks(); (requireProofSubmissionContext as jest.Mock).mockResolvedValue({ id: "order" });
  (submitProofForActor as jest.Mock).mockResolvedValue({ success: true, proof: { submissionId: "original-id" } });
});
async function app() { const server = Fastify(); await server.register(routes, { prefix: "/api/orders" }); return server; }
it("uses the specific proof context for capability; anonymous access never reaches preflight", async () => {
  const server = await app(); try {
    expect((await server.inject({ method: "GET", url: "/api/orders/order/proof-submission-capability" })).statusCode).toBe(401);
    expect(requireProofSubmissionContext).not.toHaveBeenCalled();
    const response = await server.inject({ method: "GET", url: "/api/orders/order/proof-submission-capability", headers });
    expect(response.json()).toEqual({ contract: "proof-submission-v1" });
    expect(requireProofSubmissionContext).toHaveBeenCalledWith(expect.objectContaining({ companyMembershipId: "exact-member" }), "order");
  } finally { await server.close(); }
});
it("denied proof context rejects before multipart consumption or submission", async () => {
  const server = await app(); try {
    (requireProofSubmissionContext as jest.Mock).mockRejectedValue(Object.assign(Error("Denied"), { statusCode: 403 }));
    const response = await server.inject({ method: "POST", url: "/api/orders/order/delivery-proof", headers: { ...headers, "content-type": "multipart/form-data; boundary=synthetic" }, payload: "not-multipart" });
    expect(response.statusCode).toBe(403); expect(submitProofForActor).not.toHaveBeenCalled();
  } finally { await server.close(); }
});
it("authorized upload preflights before forwarding the immutable original submission to the proof service", async () => {
  const server = await app(); try {
    const boundary = "synthetic-proof-boundary";
    const payload = `--${boundary}\r\nContent-Disposition: form-data; name="submissionId"\r\n\r\noriginal-id\r\n--${boundary}\r\nContent-Disposition: form-data; name="photo"; filename="photo.png"\r\nContent-Type: image/png\r\n\r\nsynthetic-mocked-content\r\n--${boundary}--\r\n`;
    const response = await server.inject({ method: "POST", url: "/api/orders/order/delivery-proof", headers: { ...headers, "content-type": `multipart/form-data; boundary=${boundary}` }, payload });
    expect(response.statusCode).toBe(200);
    expect(submitProofForActor).toHaveBeenCalledWith(expect.objectContaining({ orderId: "order", forcedStage: "delivery", actor: expect.objectContaining({ companyMembershipId: "exact-member" }), body: expect.objectContaining({ submissionId: "original-id" }) }));
    expect((requireProofSubmissionContext as jest.Mock).mock.invocationCallOrder[0]).toBeLessThan((submitProofForActor as jest.Mock).mock.invocationCallOrder[0]);
  } finally { await server.close(); }
});
