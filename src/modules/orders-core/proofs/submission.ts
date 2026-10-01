import { createHash, randomUUID } from "crypto";
import prisma from "../../../config/prismaClient";
import type { OrderActor } from "../shared";
import { orderError } from "../shared";

export const sha256 = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
export type ProofAcceptance = {
  submissionId: string; actor: OrderActor; orderId: string; stage: "pickup" | "delivery";
  bucket: string; receivedAt: Date; fingerprint: string; intent: unknown; photoSha256: string; signatureSha256: string;
};
export async function acceptProof(input: ProofAcceptance) {
  const { actor, submissionId, orderId, stage, fingerprint } = input;
  if (!/^[A-Za-z0-9-]{1,100}$/.test(submissionId)) throw orderError("Valid submissionId required", 400);
  const proofId = randomUUID();
  const storageManifest = { bucket: input.bucket, photoKey: `${stage}-proofs/${actor.companyId}/${orderId}/${proofId}/photo.png`, signatureKey: `${stage}-proofs/${actor.companyId}/${orderId}/${proofId}/signature.png` };
  const inserted = await prisma.$queryRaw<Array<{ proofId: string }>>`
    INSERT INTO "ProofSubmission" ("submissionId", "proofId", "tenantId", "companyId", "userId", "tenantMembershipId", "companyMembershipId", "orderId", "stage", "fingerprint", "intent", "photoSha256", "signatureSha256", "receivedAt", "storageManifest")
    VALUES (${submissionId}, ${proofId}::uuid, ${actor.tenantId}::uuid, ${actor.companyId}::uuid, ${actor.id}::uuid,
      ${actor.tenantMembershipId}::uuid, ${actor.companyMembershipId}::uuid, ${orderId}::uuid, ${stage}, ${fingerprint},
      ${JSON.stringify(input.intent)}::jsonb, ${input.photoSha256}, ${input.signatureSha256}, ${input.receivedAt}, ${JSON.stringify(storageManifest)}::jsonb)
    ON CONFLICT ("submissionId") DO NOTHING RETURNING "proofId"`;
  if (inserted.length) return { proofId, storageManifest, existing: null };
  const existing = await findProofRetry(input);
  if (!existing) throw orderError("Proof submission state conflict", 409);
  return existing;
}
export async function findProofRetry(input: Pick<ProofAcceptance, "actor" | "submissionId" | "orderId" | "stage" | "fingerprint">) {
  const { actor, submissionId, orderId, stage, fingerprint } = input;
  if (!/^[A-Za-z0-9-]{1,100}$/.test(submissionId)) throw orderError("Valid submissionId required", 400);
  const rows = await prisma.$queryRaw<any[]>`SELECT "proofId", "storageManifest", "state", "result", "fingerprint", "orderId", "stage"
    FROM "ProofSubmission" WHERE "submissionId" = ${submissionId} AND "tenantId" = ${actor.tenantId}::uuid
      AND "companyId" = ${actor.companyId}::uuid AND "userId" = ${actor.id}::uuid
      AND "tenantMembershipId" = ${actor.tenantMembershipId}::uuid AND "companyMembershipId" = ${actor.companyMembershipId}::uuid`;
  const receipt = rows[0];
  if (!receipt) return null;
  if (receipt.orderId !== orderId || receipt.stage !== stage || receipt.fingerprint !== fingerprint) {
    throw orderError("Submission ID conflicts with an existing intent", 409);
  }
  if (receipt.state !== "confirmed") throw Object.assign(orderError("Proof submission incomplete; reconciliation required", 409), { code: "PROOF_SUBMISSION_INCOMPLETE" });
  return { proofId: receipt.proofId, storageManifest: receipt.storageManifest, existing: receipt.result };
}
export async function markProofStored(submissionId: string) {
  const changed = await prisma.$executeRaw`UPDATE "ProofSubmission" SET "state" = 'stored' WHERE "submissionId" = ${submissionId} AND "state" = 'accepted'`;
  if (changed !== 1) throw orderError("Proof submission state conflict", 409);
}
export async function confirmProof(tx: any, submissionId: string, result: unknown) {
  const changed = await tx.$executeRaw`UPDATE "ProofSubmission" SET "state" = 'confirmed', "result" = ${JSON.stringify(result)}::jsonb, "confirmedAt" = CURRENT_TIMESTAMP WHERE "submissionId" = ${submissionId} AND "state" = 'stored'`;
  if (changed !== 1) throw orderError("Proof submission state conflict", 409);
}
