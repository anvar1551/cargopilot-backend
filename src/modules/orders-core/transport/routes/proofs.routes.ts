import { requireProofSubmissionContext } from "../../proofs/proof";
import { requireAuthorizedOrder } from "../../domain/order-access";
import { MAX_PROOF_BYTES } from "../../proofs/raster-processing";
import { FastifyPluginAsync } from "fastify";
import fastifyMultipart from "@fastify/multipart";
import { fastifyAuth } from "../../../identity-access/transport/fastify-auth";
import { listOrderProofLinksForActor, requireOrderActor, submitProofForActor } from "../..";
import { emitMutationInvalidation, fieldValue, parseMaxPhotoBytes, sendError } from "../shared";
import type { AppUser } from "../../../../types/app-user";

async function handleProofSubmit(request: any, reply: any, forcedStage?: "delivery") {
  const receivedAt = new Date();
  await requireAuthorizedOrder(requireOrderActor(request.user), String(request.params?.id ?? "").trim(), "shipment.update");
  const file = await request.file();
  if (!file) return reply.code(400).send({ error: "photo is required" });
  const buffer = await file.toBuffer();
  const submissionId = fieldValue((file.fields as any)?.submissionId);
  const stage = fieldValue((file.fields as any)?.stage);
  const signedBy = fieldValue((file.fields as any)?.signedBy);
  const signatureSvg = fieldValue((file.fields as any)?.signatureSvg);
  const savedAt = fieldValue((file.fields as any)?.savedAt);
  const clientCapturedAt = fieldValue((file.fields as any)?.clientCapturedAt);
  const signaturePaths = fieldValue((file.fields as any)?.signaturePaths);
  const actor = requireOrderActor(request.user);
  try {
    const result = await submitProofForActor({
      actor,
      orderId: String(request.params?.id ?? "").trim(),
      body: { submissionId, stage, signedBy, signatureSvg, savedAt, clientCapturedAt, signaturePaths },
      file: { buffer, originalname: file.filename, mimetype: file.mimetype, size: buffer.length },
      forcedStage,
      receivedAt,
    });
    if (!result.proofReplay) await emitMutationInvalidation("order_mutation");
    return reply.send(result);
  } catch (err: any) {
    if (err?.code === "PROOF_SUBMISSION_INCOMPLETE") return reply.code(409).send({ error: "Proof submission incomplete; reconciliation required", code: err.code });
    return sendError(reply, err, "Failed");
  }
}

const proofsRoutes: FastifyPluginAsync = async (fastify) => {
  await fastify.register(fastifyMultipart, { limits: { files: 1, fields: 7, parts: 8, fieldSize: 32768, fileSize: Math.min(MAX_PROOF_BYTES, parseMaxPhotoBytes()) } });

  fastify.get("/:id/proof-submission-capability", { preHandler: fastifyAuth({ permission: "shipment.update" }) }, async (request, reply) => {
    try {
      await requireProofSubmissionContext(requireOrderActor(request.user), String((request.params as any)?.id ?? "").trim());
      return reply.send({ contract: "proof-submission-v1" });
    } catch (err: any) { return sendError(reply, err, "Failed"); }
  });

  fastify.get("/:id/proofs", { preHandler: fastifyAuth({ permission: "shipment.view" }) }, async (request, reply) => {
    try {
      const user = request.user as AppUser;
      const result = await listOrderProofLinksForActor({
        user,
        orderId: String((request.params as any)?.id ?? "").trim(),
        query: (request.query ?? {}) as any,
      });
      return reply.send(result);
    } catch (err: any) {
      return sendError(reply, err, "Failed");
    }
  });

  fastify.post("/:id/proofs", { preHandler: fastifyAuth({ permission: "shipment.update" }) }, async (request, reply) =>
    handleProofSubmit(request, reply),
  );

  fastify.post("/:id/delivery-proof", { preHandler: fastifyAuth({ permission: "shipment.update" }) }, async (request, reply) =>
    handleProofSubmit(request, reply, "delivery"),
  );
};

export default proofsRoutes;
