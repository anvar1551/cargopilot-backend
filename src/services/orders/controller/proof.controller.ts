import { randomUUID } from "crypto";
import path from "path";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { AppRole } from "@prisma/client";
import multer from "multer";

import prisma from "../../../config/prismaClient";
import { s3 } from "../../../config/s3";
import { presignGetObject } from "../../../utils/s3Presign";
import { getOrderById } from "../repo";
import { orderError, requireOrderActor } from "../orderService.shared";

const DEFAULT_MAX_PHOTO_BYTES = 6 * 1024 * 1024;
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

function parseMaxPhotoBytes() {
  const raw = Number(process.env.DELIVERY_PROOF_MAX_PHOTO_BYTES ?? DEFAULT_MAX_PHOTO_BYTES);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_MAX_PHOTO_BYTES;
  return Math.floor(raw);
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    files: 1,
    fileSize: parseMaxPhotoBytes(),
  },
});

function normalizeSignedBy(value: unknown) {
  return String(value ?? "").trim();
}

function parseSignaturePaths(value: unknown) {
  if (Array.isArray(value)) {
    return value
      .map((item) => String(item ?? "").trim())
      .filter(Boolean);
  }

  const raw = String(value ?? "").trim();
  if (!raw) return [] as string[];

  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [] as string[];
    return parsed
      .map((item) => String(item ?? "").trim())
      .filter(Boolean);
  } catch {
    return [] as string[];
  }
}

function parseDateOrNow(value: unknown) {
  const raw = String(value ?? "").trim();
  if (!raw) return new Date();
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return new Date();
  return parsed;
}

function parsePathPoints(pathValue: string) {
  return pathValue
    .split(";")
    .map((token) => token.trim())
    .filter(Boolean)
    .map((token) => {
      const [xs, ys] = token.split(",");
      const x = Number(xs);
      const y = Number(ys);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
      return { x, y };
    })
    .filter((point): point is { x: number; y: number } => Boolean(point));
}

function pathToSvgD(points: Array<{ x: number; y: number }>) {
  if (points.length === 0) return "";
  if (points.length === 1) {
    const p = points[0];
    return `M ${p.x.toFixed(1)} ${p.y.toFixed(1)} L ${(p.x + 0.01).toFixed(2)} ${(p.y + 0.01).toFixed(2)}`;
  }
  return points
    .map((point, index) => `${index === 0 ? "M" : "L"} ${point.x.toFixed(1)} ${point.y.toFixed(1)}`)
    .join(" ");
}

function buildSignatureSvg(paths: string[]) {
  const strokes = paths
    .map((strokePath) => parsePathPoints(strokePath))
    .filter((points) => points.length > 0);

  let maxX = 320;
  let maxY = 160;
  for (const stroke of strokes) {
    for (const point of stroke) {
      maxX = Math.max(maxX, point.x);
      maxY = Math.max(maxY, point.y);
    }
  }

  const width = Math.ceil(maxX + 8);
  const height = Math.ceil(maxY + 8);
  const body = strokes
    .map(
      (stroke) =>
        `<path d="${pathToSvgD(stroke)}" fill="none" stroke="#2E6BFF" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" />`,
    )
    .join("");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${body}</svg>`;
}

function inferPhotoExtension(fileName: string, mimeType: string) {
  const fromName = path.extname(fileName || "").trim().toLowerCase();
  if (fromName) return fromName;
  if (mimeType.includes("png")) return ".png";
  if (mimeType.includes("webp")) return ".webp";
  return ".jpg";
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

async function canWarehouseAccessOrder(args: {
  warehouseId: string;
  order: {
    currentWarehouseId?: string | null;
    assignedDriverId?: string | null;
  };
}) {
  const { warehouseId, order } = args;
  if (order.currentWarehouseId === warehouseId) return true;
  if (!order.assignedDriverId) return false;

  const assignedDriver = await prisma.user.findFirst({
    where: {
      id: order.assignedDriverId,
      role: AppRole.driver,
      OR: [{ warehouseId }, { warehouseAccesses: { some: { warehouseId } } }],
    },
    select: { id: true },
  });

  return Boolean(assignedDriver);
}

async function assertCanReadOrder(req: any, order: any) {
  const {
    id: userId,
    role,
    customerEntityId,
    warehouseId,
  } = req.user as {
    id: string;
    role: AppRole;
    customerEntityId?: string | null;
    warehouseId?: string | null;
  };

  if (role === AppRole.manager) return;

  if (role === AppRole.warehouse) {
    if (!warehouseId) throw orderError("Forbidden", 403);
    const allowed = await canWarehouseAccessOrder({
      warehouseId,
      order: {
        currentWarehouseId: order.currentWarehouseId,
        assignedDriverId: order.assignedDriverId,
      },
    });
    if (!allowed) throw orderError("Forbidden", 403);
    return;
  }

  if (
    role === AppRole.customer &&
    ((customerEntityId && order.customerEntityId === customerEntityId) ||
      order.customerId === userId)
  ) {
    return;
  }

  if (role === AppRole.driver && order.assignedDriverId === userId) {
    return;
  }

  throw orderError("Forbidden", 403);
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

    const match = /^(pickup|delivery)-proofs\/([^/]+)\/([^/]+)\/(.+)$/i.exec(key);
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
          size: Number.isFinite(Number(attachment.size))
            ? Number(attachment.size)
            : null,
          createdAt: attachment.createdAt
            ? new Date(attachment.createdAt).toISOString()
            : null,
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

export function uploadDeliveryProofFiles(req: any, res: any, next: any) {
  upload.single("photo")(req, res, (err: any) => {
    if (!err) return next();

    if (err instanceof multer.MulterError) {
      if (err.code === "LIMIT_FILE_SIZE") {
        const mb = Math.round((parseMaxPhotoBytes() / (1024 * 1024)) * 10) / 10;
        return res.status(400).json({ error: `Photo is too large. Max ${mb}MB.` });
      }
      return res.status(400).json({ error: err.message || "Invalid multipart payload" });
    }

    return res.status(400).json({ error: err?.message || "Failed to parse upload payload" });
  });
}

async function submitProof(req: any, res: any, forcedStage?: ProofStage) {
  const actor = requireOrderActor(req.user);
  if (actor.role !== AppRole.driver) {
    throw orderError("Only driver can upload proof", 403);
  }

  const stage = parseProofStage(req.body?.stage, forcedStage ?? "delivery");
  const orderId = String(req.params?.id ?? "").trim();
  if (!orderId) throw orderError("Missing order id", 400);

  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: {
      id: true,
      assignedDriverId: true,
      currentWarehouseId: true,
    },
  });
  if (!order) throw orderError("Order not found", 404);
  if (order.assignedDriverId !== actor.id) {
    throw orderError("You are not assigned to this order", 403);
  }

  const signedBy = normalizeSignedBy(req.body?.signedBy);
  if (!signedBy) throw orderError("signedBy is required", 400);

  const signaturePaths = parseSignaturePaths(req.body?.signaturePaths);
  if (signaturePaths.length === 0) {
    throw orderError("signaturePaths is required", 400);
  }

  const photo = req.file as
    | {
        buffer: Buffer;
        originalname: string;
        mimetype: string;
        size: number;
      }
    | undefined;
  if (!photo?.buffer || photo.size <= 0) {
    throw orderError("photo is required", 400);
  }

  const providedSignatureSvg = String(req.body?.signatureSvg ?? "").trim();
  const signatureSvg =
    providedSignatureSvg.startsWith("<svg")
      ? providedSignatureSvg
      : buildSignatureSvg(signaturePaths);

  const bucket = String(process.env.AWS_S3_BUCKET ?? "").trim();
  if (!bucket) {
    throw orderError("AWS_S3_BUCKET is not configured", 500);
  }

  const proofId = randomUUID();
  const photoExt = inferPhotoExtension(photo.originalname, photo.mimetype);
  const photoKey = `${stage}-proofs/${order.id}/${proofId}/photo${photoExt}`;
  const signatureKey = `${stage}-proofs/${order.id}/${proofId}/signature.svg`;
  const signedBySafe = sanitizeFileName(signedBy);

  await Promise.all([
    s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: photoKey,
        Body: photo.buffer,
        ContentType: photo.mimetype || "image/jpeg",
        Metadata: {
          orderid: order.id,
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
        Body: Buffer.from(signatureSvg, "utf8"),
        ContentType: "image/svg+xml",
        Metadata: {
          orderid: order.id,
          driverid: actor.id,
          signedby: signedBySafe,
          type: `${stage}-proof-signature`,
        },
      }),
    ),
  ]);

  const proofTimestamp = parseDateOrNow(req.body?.savedAt);
  const stageLabel = stage === "pickup" ? "Pickup" : "Delivery";

  const result = await prisma.$transaction(async (tx) => {
    const photoAttachment = await tx.orderAttachment.create({
      data: {
        orderId: order.id,
        key: photoKey,
        fileName: photo.originalname || `${stage}-proof-photo${photoExt}`,
        mimeType: photo.mimetype || "image/jpeg",
        size: photo.size ?? null,
      },
    });

    const signatureAttachment = await tx.orderAttachment.create({
      data: {
        orderId: order.id,
        key: signatureKey,
        fileName: `${stage}-signature-${proofId}.svg`,
        mimeType: "image/svg+xml",
        size: Buffer.byteLength(signatureSvg, "utf8"),
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
        actorRole: actor.role,
        parcelId: null,
        timestamp: proofTimestamp,
      },
    });

    return { photoAttachment, signatureAttachment };
  });

  return res.json({
    success: true,
    proof: {
      orderId: order.id,
      stage,
      signedBy,
      savedAt: proofTimestamp.toISOString(),
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
  });
}

/** Backward-compatible endpoint for delivery proof uploads. */
export async function submitDeliveryProof(req: any, res: any) {
  try {
    return await submitProof(req, res, "delivery");
  } catch (err: any) {
    const code = err.statusCode ?? 400;
    return res.status(code).json({ error: err.message ?? "Failed" });
  }
}

/** Generic endpoint for pickup/delivery proof uploads. */
export async function submitOrderProof(req: any, res: any) {
  try {
    return await submitProof(req, res);
  } catch (err: any) {
    const code = err.statusCode ?? 400;
    return res.status(code).json({ error: err.message ?? "Failed" });
  }
}

/** Lazily resolves signed URLs for order proof artifacts grouped by stage. */
export async function getOrderProofLinks(req: any, res: any) {
  try {
    const orderId = String(req.params?.id ?? "").trim();
    if (!orderId) throw orderError("Missing order id", 400);

    const order = await getOrderById(orderId);
    if (!order) return res.status(404).json({ error: "Not found" });

    await assertCanReadOrder(req, order);

    const stageRaw = String(req.query?.stage ?? "").trim().toLowerCase();
    const stageFilter =
      stageRaw === "pickup" || stageRaw === "delivery"
        ? (stageRaw as ProofStage)
        : undefined;
    const limitRaw = Number(req.query?.limit ?? 10);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0
      ? Math.min(Math.floor(limitRaw), 50)
      : 10;

    const bundles = await buildProofBundlesForOrder({
      orderId: order.id,
      attachments: order.attachments,
      trackingEvents: order.trackingEvents,
      stageFilter,
      limit,
    });

    const byStage: Record<ProofStage, ProofBundle[]> = {
      pickup: bundles.filter((bundle) => bundle.stage === "pickup"),
      delivery: bundles.filter((bundle) => bundle.stage === "delivery"),
    };

    return res.json({
      success: true,
      orderId: order.id,
      proofs: bundles,
      byStage,
    });
  } catch (err: any) {
    const code = err.statusCode ?? 400;
    return res.status(code).json({ error: err.message ?? "Failed" });
  }
}
