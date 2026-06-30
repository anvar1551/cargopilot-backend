import { FastifyPluginAsync } from "fastify";
import fastifyMultipart from "@fastify/multipart";
import { fastifyAuth } from "../../../identity-access/transport/fastify-auth";
import { listOrderProofLinksForActor, requireOrderActor, submitProofForActor } from "../..";
import { emitMutationInvalidation, fieldValue, parseMaxPhotoBytes, sendError } from "../shared";
import type { AppUser } from "../../../../types/app-user";

async function handleProofSubmit(request: any, reply: any, forcedStage?: "delivery") {
  const file = await request.file();
  if (!file) return reply.code(400).send({ error: "photo is required" });
  const buffer = await file.toBuffer();
  const stage = fieldValue((file.fields as any)?.stage);
  const signedBy = fieldValue((file.fields as any)?.signedBy);
  const signatureSvg = fieldValue((file.fields as any)?.signatureSvg);
  const savedAt = fieldValue((file.fields as any)?.savedAt);
  const signaturePaths = fieldValue((file.fields as any)?.signaturePaths);
  const actor = requireOrderActor(request.user);
  try {
    const result = await submitProofForActor({
      actor,
      orderId: String(request.params?.id ?? "").trim(),
      body: { stage, signedBy, signatureSvg, savedAt, signaturePaths },
      file: { buffer, originalname: file.filename, mimetype: file.mimetype, size: buffer.length },
      forcedStage,
    });
    await emitMutationInvalidation("order_mutation");
    return reply.send(result);
  } catch (err: any) {
    return sendError(reply, err, "Failed");
  }
}

const proofsRoutes: FastifyPluginAsync = async (fastify) => {
  await fastify.register(fastifyMultipart, { limits: { files: 1, fileSize: parseMaxPhotoBytes() } });

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
