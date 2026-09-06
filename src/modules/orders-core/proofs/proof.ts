import { randomUUID } from "crypto";
import { MAX_PROOF_BYTES, processProofRaster } from "./raster-processing";
import { requireCompanyAuthority } from "../domain/company-authority";
import { DeleteObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";

import prisma from "../../../config/prismaClient";
import { s3 } from "../../../config/s3";
import { buildOrderScopeWhere } from "../../identity-access";
import { presignGetObject } from "../../../utils/s3Presign";
import { getOrderById } from "../repo";
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
    if (!key) continue;

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

export async function submitProofForActor(input: SubmitProofInput) {
  const { actor, orderId, body, file, forcedStage } = input;
  const proofTimestamp = input.receivedAt ?? new Date();
  const membership = await requireCompanyAuthority(prisma, actor, "shipment.update");
  if (!orderId) throw orderError("Missing order id", 400);

  const stage = parseProofStage(body.stage, forcedStage ?? "delivery");
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: {
      id: true,
      assignedDriverId: true,
      ownerOrgId: true,
      currentWarehouseId: true,
    },
  });
  if (!order) throw orderError("Order not found", 404);
  if (order.ownerOrgId !== membership.companyId || order.assignedDriverId !== actor.id) {
    throw orderError("You are not assigned to this order", 403);
  }

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
  const raster = await processProofRaster(file.buffer, body.signaturePaths);

  const bucket = String(process.env.AWS_S3_BUCKET ?? "").trim();
  if (!bucket) throw orderError("AWS_S3_BUCKET is not configured", 500);

  const proofId = randomUUID();
  const photoExt = ".png";
  const photoKey = `${stage}-proofs/${membership.companyId}/${order.id}/${proofId}/photo${photoExt}`;
  const signatureKey = `${stage}-proofs/${membership.companyId}/${order.id}/${proofId}/signature.png`;
  const signedBySafe = sanitizeFileName(signedBy);

  await Promise.all([
    s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: photoKey,
        Body: raster.photo,
        ContentType: "image/png",
        ContentDisposition: "attachment",
        Metadata: {
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
        Body: raster.signature,
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

  const stageLabel = stage === "pickup" ? "Pickup" : "Delivery";

  let result: {
    photoAttachment: { id: string; key: string; mimeType: string | null; size: number | null };
    signatureAttachment: { id: string; key: string; mimeType: string | null; size: number | null };
  };
  try {
    result = await prisma.$transaction(async (tx) => {
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

      return { photoAttachment, signatureAttachment };
    });
  } catch (error) {
    await Promise.allSettled([
      s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: photoKey })),
      s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: signatureKey })),
    ]);
    throw error;
  }

  return {
    success: true,
    proof: {
      orderId: order.id,
      stage,
      signedBy,
      savedAt: proofTimestamp.toISOString(),
      clientCapturedAt,
      photo: {
        id: result.photoAttachment.id,
        key: result.photoAttachment.key,
        mimeType: result.photoAttachment.mimeType,
        size: result.photoAttachment.size,
      },
      signature: {
        id: result.signatureAttachment.id,
        key: result.signatureAttachment.key,
        mimeType: result.signatureAttachment.mimeType,
        size: result.signatureAttachment.size,
      },
    },
  };
}

export async function listOrderProofLinksForActor(input: ListProofInput) {
  const { user, orderId, query } = input;
  if (!orderId) throw orderError("Missing order id", 400);

  const scopeWhere = await buildOrderScopeWhere(user);
  const order = await getOrderById(orderId, scopeWhere);
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
