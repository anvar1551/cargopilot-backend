"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const multipart_1 = __importDefault(require("@fastify/multipart"));
const fastify_auth_1 = require("../../../identity-access/transport/fastify-auth");
const __1 = require("../..");
const shared_1 = require("../shared");
async function handleProofSubmit(request, reply, forcedStage) {
    const file = await request.file();
    if (!file)
        return reply.code(400).send({ error: "photo is required" });
    const buffer = await file.toBuffer();
    const stage = (0, shared_1.fieldValue)(file.fields?.stage);
    const signedBy = (0, shared_1.fieldValue)(file.fields?.signedBy);
    const signatureSvg = (0, shared_1.fieldValue)(file.fields?.signatureSvg);
    const savedAt = (0, shared_1.fieldValue)(file.fields?.savedAt);
    const signaturePaths = (0, shared_1.fieldValue)(file.fields?.signaturePaths);
    const actor = (0, __1.requireOrderActor)(request.user);
    try {
        const result = await (0, __1.submitProofForActor)({
            actor,
            orderId: String(request.params?.id ?? "").trim(),
            body: { stage, signedBy, signatureSvg, savedAt, signaturePaths },
            file: { buffer, originalname: file.filename, mimetype: file.mimetype, size: buffer.length },
            forcedStage,
        });
        await (0, shared_1.emitMutationInvalidation)("order_mutation");
        return reply.send(result);
    }
    catch (err) {
        return (0, shared_1.sendError)(reply, err, "Failed");
    }
}
const proofsRoutes = async (fastify) => {
    await fastify.register(multipart_1.default, { limits: { files: 1, fileSize: (0, shared_1.parseMaxPhotoBytes)() } });
    fastify.get("/:id/proofs", { preHandler: (0, fastify_auth_1.fastifyAuth)({ permission: "shipment.view" }) }, async (request, reply) => {
        try {
            const user = request.user;
            const result = await (0, __1.listOrderProofLinksForActor)({
                user,
                orderId: String(request.params?.id ?? "").trim(),
                query: (request.query ?? {}),
            });
            return reply.send(result);
        }
        catch (err) {
            return (0, shared_1.sendError)(reply, err, "Failed");
        }
    });
    fastify.post("/:id/proofs", { preHandler: (0, fastify_auth_1.fastifyAuth)({ permission: "shipment.update" }) }, async (request, reply) => handleProofSubmit(request, reply));
    fastify.post("/:id/delivery-proof", { preHandler: (0, fastify_auth_1.fastifyAuth)({ permission: "shipment.update" }) }, async (request, reply) => handleProofSubmit(request, reply, "delivery"));
};
exports.default = proofsRoutes;
