import { acceptProof, findProofRetry, markProofStored, confirmProof, sha256 } from "./submission";
import { MAX_PROOF_BYTES, processProofRaster, proofSignaturePoints, validateProofPng } from "./raster-processing";
import { requireCustodyProofOrder } from "../domain/custody-access";
import { requireAuthorizedOrder } from "../domain/order-access";
import { PutObjectCommand } from "@aws-sdk/client-s3";

import prisma from "../../../config/prismaClient";
import { s3 } from "../../../config/s3";
import { presignGetObject } from "../../../utils/s3Presign";
import { orderError } from "../shared";
import type { OrderActor } from "../shared";
import type { AppUser } from "../../../types/app-user";

const PROOF_STAGES = new Set(["pickup", "delivery"]);

type ProofStage = "pickup" | "delivery";

type ProofAsset = {
  id: string;
  key: string;
  fileName: string | null;
  mimeType: string | null;
  size: number | null;
  createdAt: string | null;
  url: string;
};

type ProofBundle = {
  proofId: string;
  stage: ProofStage;
  savedAt: string;
  signedBy: string | null;
  photo: ProofAsset | null;
  signature: ProofAsset | null;
};

type ProofReaderUser = AppUser;


type SubmitProofInput = {
  actor: OrderActor;
  orderId: string;
  body: Record<string, unknown>;
  file?: {
    buffer: Buffer;
    originalname: string;
    mimetype: string;
    size: number;
  };
  forcedStage?: ProofStage;
  receivedAt?: Date;
};

type ListProofInput = {
  user: ProofReaderUser;
  orderId: string;
  query: { stage?: unknown; limit?: unknown };
};

function normalizeSignedBy(value: unknown) {
  return String(value ?? "").trim();
}

function sanitizeFileName(value: string) {
  const cleaned = value.replace(/[^a-zA-Z0-9._-]+/g, "_");
  return cleaned || "proof";
}

function parseProofStage(value: unknown, fallback: ProofStage = "delivery"): ProofStage {
  const raw = String(value ?? "").trim().toLowerCase();
  if (raw === "pickup" || raw === "delivery") return raw;
  return fallback;
}

function normalizeActorRoleForTracking(): null {
  return null;
}

function parseProofTrackingMeta(trackingEvents: any[] | null | undefined) {
  const byStage: Record<ProofStage, Array<{ signedBy: string | null; savedAt: string }>> = {
    pickup: [],
    delivery: [],
  };

  for (const event of trackingEvents ?? []) {
    const note = String(event?.note ?? "").trim();
    const timestampRaw = String(event?.timestamp ?? "").trim();
    const parsedDate = new Date(timestampRaw);
    const savedAt = Number.isNaN(parsedDate.getTime())
      ? new Date().toISOString()
      : parsedDate.toISOString();

    const pickupMatch = /^Pickup proof uploaded \(signed by:\s*(.+)\)$/i.exec(note);
    if (pickupMatch) {
      byStage.pickup.push({ signedBy: pickupMatch[1]?.trim() || null, savedAt });
      continue;
    }
    const deliveryMatch = /^Delivery proof uploaded \(signed by:\s*(.+)\)$/i.exec(note);
    if (deliveryMatch) {
      byStage.delivery.push({ signedBy: deliveryMatch[1]?.trim() || null, savedAt });
    }
  }

  byStage.pickup.sort((a, b) => new Date(b.savedAt).getTime() - new Date(a.savedAt).getTime());
  byStage.delivery.sort((a, b) => new Date(b.savedAt).getTime() - new Date(a.savedAt).getTime());

  return byStage;
}

async function buildProofBundlesForOrder(args: {
  orderId: string;
  companyId: string | null;
  attachments: any[] | null | undefined;
  trackingEvents: any[] | null | undefined;
  stageFilter?: ProofStage;
  limit?: number;
}) {
  const trackingMeta = parseProofTrackingMeta(args.trackingEvents);
  const grouped = new Map<string, Omit<ProofBundle, "photo" | "signature"> & {
    photo: any | null;
    signature: any | null;
  }>();

  for (const attachment of args.attachments ?? []) {
    const key = String(attachment?.key ?? "").trim();
    if (!key || attachment.orderId !== args.orderId) continue;

    const owned = /^(pickup|delivery)-proofs\/([^/]+)\/([^/]+)\/([^/]+)\/([^/]+)$/i.exec(key);
    if (owned && owned[2] !== args.companyId) continue;
    const match = owned ? [owned[0], owned[1], owned[3], owned[4], owned[5]] : /^(pickup|delivery)-proofs\/([^/]+)\/([^/]+)\/([^/]+)$/i.exec(key);
    if (!match) continue;

    const stage = match[1].toLowerCase() as ProofStage;
    const keyOrderId = String(match[2] ?? "").trim();
    const proofId = String(match[3] ?? "").trim();
    const fileTail = String(match[4] ?? "").trim().toLowerCase();

    if (!PROOF_STAGES.has(stage)) continue;
    if (keyOrderId && keyOrderId !== args.orderId) continue;
    if (args.stageFilter && stage !== args.stageFilter) continue;

    const groupKey = `${stage}:${proofId}`;
    const createdAtIso = attachment?.createdAt
      ? new Date(attachment.createdAt).toISOString()
      : new Date().toISOString();

    const stageMeta = trackingMeta[stage][0];
    const existing = grouped.get(groupKey) ?? {
      proofId,
      stage,
      signedBy: stageMeta?.signedBy ?? null,
      savedAt: stageMeta?.savedAt ?? createdAtIso,
      photo: null,
      signature: null,
    };

    const isSignature =
      fileTail.includes("signature") ||
      String(attachment?.mimeType ?? "").toLowerCase().includes("svg");

    if (isSignature) existing.signature = attachment;
    else existing.photo = attachment;

    const attachmentDate = new Date(createdAtIso).getTime();
    const groupDate = new Date(existing.savedAt).getTime();
    if (attachmentDate > groupDate) {
      existing.savedAt = createdAtIso;
    }

    grouped.set(groupKey, existing);
  }

  const sorted = Array.from(grouped.values()).sort(
    (a, b) => new Date(b.savedAt).getTime() - new Date(a.savedAt).getTime(),
  );
  const sliced =
    typeof args.limit === "number" && args.limit > 0 ? sorted.slice(0, args.limit) : sorted;

  const bundles = await Promise.all(
    sliced.map(async (bundle) => {
      const toAsset = async (attachment: any | null): Promise<ProofAsset | null> => {
        if (!attachment?.key) return null;
        const url = await presignGetObject(String(attachment.key), 60 * 5);
        return {
          id: String(attachment.id),
          key: String(attachment.key),
          fileName: attachment.fileName ? String(attachment.fileName) : null,
          mimeType: attachment.mimeType ? String(attachment.mimeType) : null,
          size: Number.isFinite(Number(attachment.size)) ? Number(attachment.size) : null,
          createdAt: attachment.createdAt ? new Date(attachment.createdAt).toISOString() : null,
          url,
        };
      };

      return {
        proofId: bundle.proofId,
        stage: bundle.stage,
        savedAt: bundle.savedAt,
        signedBy: bundle.signedBy,
        photo: await toAsset(bundle.photo),
        signature: await toAsset(bundle.signature),
      } satisfies ProofBundle;
    }),
  );

  return bundles;
}

export async function requireProofSubmissionContext(actor: OrderActor, orderId: string) {
  let order;
  try { order = await requireAuthorizedOrder(actor, orderId, "shipment.update"); }
  catch (error) {
    if (![403, 404].includes((error as {statusCode?:number}).statusCode ?? 0)) throw error;
    order = await requireCustodyProofOrder(actor, orderId);
  }
  if (!order.ownerOrgId || order.ownerOrgId !== actor.companyId || order.assignedDriverId !== actor.id) {
    throw orderError("You are not assigned to this order", 403);
  }
  return { ...order, ownerOrgId: order.ownerOrgId };
}

export async function submitProofForActor(input: SubmitProofInput) {
  const { actor, orderId, body, file, forcedStage } = input;
  const proofTimestamp = input.receivedAt ?? new Date();
  if (!orderId) throw orderError("Missing order id", 400);
  const stage = parseProofStage(body.stage, forcedStage ?? "delivery");
  const order = await requireProofSubmissionContext(actor, orderId);
  const membership = { companyId: order.ownerOrgId };

  const signedBy = normalizeSignedBy(body.signedBy);
  if (!signedBy || signedBy.length > 120 || /[\x00-\x1f\x7f]/.test(signedBy)) throw orderError("signedBy is required and must be bounded text", 400);
  if (body.signatureSvg != null && body.signatureSvg !== "") throw orderError("SVG proof content is not accepted", 415);
  if (!file?.buffer?.length) throw orderError("photo is required", 400);
  if (file.buffer.length > MAX_PROOF_BYTES) throw orderError("Proof image exceeds byte limits", 413);
  if (!['image/png', 'application/octet-stream'].includes(file.mimetype.toLowerCase()) || /\.svgz?$/i.test(file.originalname)) throw orderError("Only PNG proof images are supported", 415);
  const captureValue = body.clientCapturedAt ?? body.savedAt;
  let clientCapturedAt: string | null = null;
  if (captureValue != null && captureValue !== "") {
    if (typeof captureValue !== "string" || captureValue.length > 40 || !/^\d{4}-\d{2}-\d{2}T/.test(captureValue) || Number.isNaN(Date.parse(captureValue))) throw orderError("Invalid client capture timestamp", 400);
    clientCapturedAt = new Date(captureValue).toISOString();
  }
  if (body.clientCapturedAt && body.savedAt && body.clientCapturedAt !== body.savedAt) throw orderError("Conflicting client capture timestamps", 400);
  validateProofPng(file.buffer);
  const submissionId = typeof body.submissionId === "string" ? body.submissionId : "";
  const intent = { stage, signedBy, clientCapturedAt, photoSha256: sha256(file.buffer), strokes: proofSignaturePoints(body.signaturePaths) };
  const fingerprint = sha256(JSON.stringify(intent));
  const retry = await findProofRetry({ submissionId, actor, orderId: order.id, stage, fingerprint });
  if (retry) {
    Object.defineProperty(retry.existing, "proofReplay", { value: true, enumerable: false });
    return retry.existing;
  }
  const bucket = String(process.env.AWS_S3_BUCKET ?? "").trim();
  if (!bucket) throw orderError("AWS_S3_BUCKET is not configured", 500);
  const raster = await processProofRaster(file.buffer, body.signaturePaths);
  const acceptance = await acceptProof({ submissionId, actor, orderId: order.id, stage,
    bucket, receivedAt: proofTimestamp, fingerprint, intent,
    photoSha256: sha256(raster.photo), signatureSha256: sha256(raster.signature) });
  if (acceptance.existing) {
    Object.defineProperty(acceptance.existing, "proofReplay", { value: true, enumerable: false });
    return acceptance.existing;
  }
  const proofId = acceptance.proofId;
  const photoExt = ".png";
  const photoKey: string = acceptance.storageManifest.photoKey;
  const signatureKey: string = acceptance.storageManifest.signatureKey;
  const signedBySafe = sanitizeFileName(signedBy);

  await Promise.all([
    s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: photoKey,
        IfNoneMatch: "*",
        Body: raster.photo,
        ChecksumSHA256: Buffer.from(sha256(raster.photo), "hex").toString("base64"),
        ContentType: "image/png",
        ContentDisposition: "attachment",
        Metadata: {
          submissionid: submissionId,
          orderid: order.id,
          companyid: membership.companyId,
          receivedat: proofTimestamp.toISOString(),
          ...(clientCapturedAt ? { clientcapturedat: clientCapturedAt } : {}),
          driverid: actor.id,
          signedby: signedBySafe,
          type: `${stage}-proof-photo`,
        },
      }),
    ),
    s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: signatureKey,
        IfNoneMatch: "*",
        Body: raster.signature,
        ChecksumSHA256: Buffer.from(sha256(raster.signature), "hex").toString("base64"),
        ContentType: "image/png",
        ContentDisposition: "attachment",
        Metadata: {
          orderid: order.id,
          companyid: membership.companyId,
          receivedat: proofTimestamp.toISOString(),
          ...(clientCapturedAt ? { clientcapturedat: clientCapturedAt } : {}),
          driverid: actor.id,
          signedby: signedBySafe,
          type: `${stage}-proof-signature`,
        },
      }),
    ),
  ]);

  await markProofStored(submissionId);
  const stageLabel = stage === "pickup" ? "Pickup" : "Delivery";

  // Storage is not transactional with PostgreSQL. Failures retain an incomplete receipt
  // and deterministic owned objects for reconciliation; never delete after uncertain commit.
  await requireProofSubmissionContext(actor, orderId);
  return prisma.$transaction(async (tx) => {
      const photoAttachment = await tx.orderAttachment.create({
        data: {
          orderId: order.id,
          key: photoKey,
          fileName: `${stage}-proof-photo${photoExt}`,
          mimeType: "image/png",
          size: raster.photo.length,
        },
      });

      const signatureAttachment = await tx.orderAttachment.create({
        data: {
          orderId: order.id,
          key: signatureKey,
          fileName: `${stage}-signature-${proofId}.png`,
          mimeType: "image/png",
          size: raster.signature.length,
        },
      });

      await tx.tracking.create({
        data: {
          orderId: order.id,
          status: null,
          reasonCode: null,
          note: `${stageLabel} proof uploaded (signed by: ${signedBy})`,
          region: null,
          warehouseId: order.currentWarehouseId ?? null,
          actorId: actor.id,
          actorRole: normalizeActorRoleForTracking(),
          parcelId: null,
          timestamp: proofTimestamp,
        },
      });

      const response = {
    success: true,
    proof: {
      submissionId,
      orderId: order.id,
      stage,
      signedBy,
      savedAt: proofTimestamp.toISOString(),
      clientCapturedAt,
      photo: {
        id: photoAttachment.id,
        key: photoAttachment.key,
        mimeType: photoAttachment.mimeType,
        size: photoAttachment.size,
      },
      signature: {
        id: signatureAttachment.id,
        key: signatureAttachment.key,
        mimeType: signatureAttachment.mimeType,
        size: signatureAttachment.size,
      },
    },
  };
      await confirmProof(tx, submissionId, response);
      return response;
  });
}

export async function listOrderProofLinksForActor(input: ListProofInput) {
  const { user, orderId, query } = input;
  if (!orderId) throw orderError("Missing order id", 400);

  const authorized = await requireAuthorizedOrder(user, orderId, "shipment.view");
  const order = await prisma.order.findFirst({
    where: { id: authorized.id, tenantId: authorized.tenantId },
    select: { id: true, ownerOrgId: true, attachments: {
      select: { id: true, orderId: true, key: true, fileName: true, mimeType: true, size: true, createdAt: true },
    }, trackingEvents: { select: { note: true, timestamp: true } } },
  });
  if (!order) {
    const err = new Error("Not found") as Error & { statusCode: number };
    err.statusCode = 404;
    throw err;
  }

  const stageRaw = String(query.stage ?? "").trim().toLowerCase();
  const stageFilter =
    stageRaw === "pickup" || stageRaw === "delivery"
      ? (stageRaw as ProofStage)
      : undefined;
  const limitRaw = Number(query.limit ?? 10);
  const limit =
    Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(Math.floor(limitRaw), 50) : 10;

  const bundles = await buildProofBundlesForOrder({
    orderId: order.id,
    companyId: order.ownerOrgId ?? null,
    attachments: order.attachments,
    trackingEvents: order.trackingEvents,
    stageFilter,
    limit,
  });

  const byStage: Record<ProofStage, ProofBundle[]> = {
    pickup: bundles.filter((bundle) => bundle.stage === "pickup"),
    delivery: bundles.filter((bundle) => bundle.stage === "delivery"),
  };

  return {
    success: true,
    orderId: order.id,
    proofs: bundles,
    byStage,
  };
}
