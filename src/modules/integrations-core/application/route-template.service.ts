import { MembershipStatus, Prisma, ServiceType, TransportMode } from "@prisma/client";
import prisma from "../../../config/prismaClient";
import { authorize, hasAnyPermissionSync } from "../../identity-access";
import type { AppUser } from "../../../types/app-user";

type AuthUser = AppUser;

const db = prisma as any;

type RouteTemplateLegInput = {
  id?: string | null;
  sequence: number;
  legCode: string;
  label?: string | null;
  mode: TransportMode;
  originCountryCode?: string | null;
  destinationCountryCode?: string | null;
  metadata?: unknown;
};

type RouteTemplateInput = {
  companyId: string;
  name: string;
  code?: string | null;
  isActive?: boolean;
  priority?: number;
  serviceType?: ServiceType | null;
  transportMode?: TransportMode | null;
  originCountryCode?: string | null;
  destinationCountryCode?: string | null;
  metadata?: unknown;
  legs: RouteTemplateLegInput[];
};

type RouteTemplateFilters = {
  companyId?: string;
  isActive?: boolean;
  q?: string;
  cursor?: string;
  limit?: number;
};

function toIso(value: Date | string | null | undefined) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  return new Date(value).toISOString();
}

function normalizeOptionalCode(value: unknown) {
  const normalized = String(value || "")
    .trim()
    .replace(/[-\s]+/g, "_")
    .replace(/[^A-Za-z0-9_]/g, "")
    .toUpperCase();
  return normalized || null;
}

function normalizeLegCode(value: unknown) {
  const normalized = String(value || "")
    .trim()
    .replace(/[-\s]+/g, "_")
    .replace(/[^A-Za-z0-9_]/g, "")
    .toLowerCase();
  return normalized || null;
}

function normalizeCountryCode(value: unknown) {
  const normalized = String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z]/g, "");
  return /^[A-Z]{2}$/.test(normalized) ? normalized : null;
}

function intOrDefault(value: unknown, fallback: number) {
  if (value == null || value === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : NaN;
}

function boolOrDefault(value: unknown, fallback: boolean) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes", "on"].includes(normalized)) return true;
    if (["false", "0", "no", "off"].includes(normalized)) return false;
  }
  return fallback;
}

function canOverrideScope(user: AuthUser) {
  return hasAnyPermissionSync(user, ["policy.override"]);
}

async function listAccessibleCompanyIds(user: AuthUser): Promise<string[] | null> {
  if (canOverrideScope(user)) return null;
  const memberships = await db.companyMembership.findMany({
    where: {
      userId: user.id,
      status: MembershipStatus.active,
    },
    select: { companyId: true },
  });
  return Array.from(
    new Set(memberships.map((item: { companyId: string }) => item.companyId).filter(Boolean)),
  );
}

async function assertCompanyAccess(user: AuthUser, companyId: string, permission: string) {
  await authorize(user, permission);
  const scopedIds = await listAccessibleCompanyIds(user);
  if (scopedIds === null || scopedIds.includes(companyId)) return;
  const err = new Error("Forbidden for this company") as Error & { statusCode: number };
  err.statusCode = 403;
  throw err;
}

async function getTemplateAccessibleOrThrow(
  user: AuthUser,
  routeTemplateId: string,
  permission: string,
) {
  await authorize(user, permission);
  const scopedIds = await listAccessibleCompanyIds(user);
  const routeTemplate = await db.routeTemplate.findUnique({
    where: { id: routeTemplateId },
    include: {
      company: { select: { id: true, name: true, code: true, type: true } },
      legs: { orderBy: [{ sequence: "asc" }, { createdAt: "asc" }] },
    },
  });
  if (!routeTemplate) {
    const err = new Error("Route template not found") as Error & { statusCode: number };
    err.statusCode = 404;
    throw err;
  }
  if (scopedIds !== null && !scopedIds.includes(routeTemplate.companyId)) {
    const err = new Error("Forbidden for this route template") as Error & { statusCode: number };
    err.statusCode = 403;
    throw err;
  }
  return routeTemplate;
}

function mapLegRow(row: any) {
  return {
    id: row.id,
    routeTemplateId: row.routeTemplateId,
    sequence: Number(row.sequence),
    legCode: row.legCode,
    label: row.label ?? null,
    mode: row.mode,
    originCountryCode: row.originCountryCode ?? null,
    destinationCountryCode: row.destinationCountryCode ?? null,
    metadata: row.metadata ?? null,
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
  };
}

function mapTemplateRow(row: any) {
  return {
    id: row.id,
    companyId: row.companyId,
    company: row.company
      ? {
          id: row.company.id,
          name: row.company.name,
          code: row.company.code ?? null,
          type: row.company.type,
        }
      : null,
    name: row.name,
    code: row.code ?? null,
    isActive: Boolean(row.isActive),
    priority: Number(row.priority ?? 0),
    serviceType: row.serviceType ?? null,
    transportMode: row.transportMode ?? null,
    originCountryCode: row.originCountryCode ?? null,
    destinationCountryCode: row.destinationCountryCode ?? null,
    metadata: row.metadata ?? null,
    legs: Array.isArray(row.legs) ? row.legs.map(mapLegRow) : undefined,
    legCount: row._count?.legs ?? (Array.isArray(row.legs) ? row.legs.length : undefined),
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
  };
}

function normalizeLegInput(leg: RouteTemplateLegInput) {
  const sequence = intOrDefault(leg.sequence, NaN);
  if (!Number.isFinite(sequence) || sequence <= 0) {
    const err = new Error("route template leg sequence must be a positive integer") as Error & {
      statusCode: number;
    };
    err.statusCode = 400;
    throw err;
  }

  const legCode = normalizeLegCode(leg.legCode);
  if (!legCode) {
    const err = new Error("route template leg code is required") as Error & {
      statusCode: number;
    };
    err.statusCode = 400;
    throw err;
  }

  return {
    id: String(leg.id || "").trim() || null,
    sequence,
    legCode,
    label: String(leg.label ?? "").trim() || null,
    mode: leg.mode,
    originCountryCode: normalizeCountryCode(leg.originCountryCode),
    destinationCountryCode: normalizeCountryCode(leg.destinationCountryCode),
    metadata: leg.metadata === undefined ? undefined : leg.metadata,
  };
}

function normalizeTemplateInput(input: RouteTemplateInput) {
  const name = String(input.name || "").trim();
  if (!name) {
    const err = new Error("name is required") as Error & { statusCode: number };
    err.statusCode = 400;
    throw err;
  }

  const companyId = String(input.companyId || "").trim();
  if (!companyId) {
    const err = new Error("companyId is required") as Error & { statusCode: number };
    err.statusCode = 400;
    throw err;
  }

  const priority = intOrDefault(input.priority, 0);
  if (!Number.isFinite(priority)) {
    const err = new Error("priority must be an integer") as Error & { statusCode: number };
    err.statusCode = 400;
    throw err;
  }

  if (!Array.isArray(input.legs) || input.legs.length === 0) {
    const err = new Error("route template requires at least one leg") as Error & {
      statusCode: number;
    };
    err.statusCode = 400;
    throw err;
  }

  const originCountryCode = normalizeCountryCode(input.originCountryCode);
  const destinationCountryCode = normalizeCountryCode(input.destinationCountryCode);
  const legs = input.legs.map(normalizeLegInput).sort((a, b) => a.sequence - b.sequence);
  const seenSequences = new Set<number>();
  const seenCodes = new Set<string>();

  for (let index = 0; index < legs.length; index += 1) {
    const leg = legs[index];
    if (seenSequences.has(leg.sequence)) {
      const err = new Error(`Duplicate route leg sequence: ${leg.sequence}`) as Error & {
        statusCode: number;
      };
      err.statusCode = 400;
      throw err;
    }
    seenSequences.add(leg.sequence);

    if (seenCodes.has(leg.legCode)) {
      const err = new Error(`Duplicate route leg code: ${leg.legCode}`) as Error & {
        statusCode: number;
      };
      err.statusCode = 400;
      throw err;
    }
    seenCodes.add(leg.legCode);

    if (leg.sequence !== index + 1) {
      const err = new Error("Route leg sequence must be continuous and start from 1") as Error & {
        statusCode: number;
      };
      err.statusCode = 400;
      throw err;
    }

    if (index === 0 && originCountryCode && leg.originCountryCode !== originCountryCode) {
      const err = new Error("First route leg origin must match route originCountryCode") as Error & {
        statusCode: number;
      };
      err.statusCode = 400;
      throw err;
    }

    if (
      index === legs.length - 1 &&
      destinationCountryCode &&
      leg.destinationCountryCode !== destinationCountryCode
    ) {
      const err = new Error("Last route leg destination must match route destinationCountryCode") as Error & {
        statusCode: number;
      };
      err.statusCode = 400;
      throw err;
    }

    if (index > 0) {
      const prev = legs[index - 1];
      if (
        prev.destinationCountryCode &&
        leg.originCountryCode &&
        prev.destinationCountryCode !== leg.originCountryCode
      ) {
        const err = new Error(
          "Route leg chain is broken: previous destination must equal next origin",
        ) as Error & { statusCode: number };
        err.statusCode = 400;
        throw err;
      }
    }
  }

  return {
    companyId,
    name,
    code: normalizeOptionalCode(input.code),
    isActive: boolOrDefault(input.isActive, true),
    priority,
    serviceType: input.serviceType ?? null,
    transportMode: input.transportMode ?? null,
    originCountryCode,
    destinationCountryCode,
    metadata: input.metadata === undefined ? undefined : input.metadata,
    legs,
  };
}

export async function listRouteTemplatesForActor(args: {
  user: AuthUser;
  filters?: RouteTemplateFilters;
}) {
  await authorize(args.user, "integration.routing.read");
  const scopedIds = await listAccessibleCompanyIds(args.user);
  const filters = args.filters ?? {};
  if (filters.companyId && scopedIds !== null && !scopedIds.includes(filters.companyId)) {
    const err = new Error("Forbidden for this company") as Error & { statusCode: number };
    err.statusCode = 403;
    throw err;
  }
  if (scopedIds !== null && scopedIds.length === 0) return [];

  const q = filters.q?.trim();
  const limit = Math.min(Math.max(Number(filters.limit ?? 0), 1), 100);
  const usePagination = Boolean(filters.limit);
  const where = {
    ...(filters.companyId
      ? { companyId: filters.companyId }
      : scopedIds === null
        ? {}
        : { companyId: { in: scopedIds } }),
    ...(typeof filters.isActive === "boolean" ? { isActive: filters.isActive } : {}),
    ...(q
      ? {
          OR: [
            { name: { contains: q, mode: "insensitive" } },
            { code: { contains: q, mode: "insensitive" } },
            { originCountryCode: { contains: q, mode: "insensitive" } },
            { destinationCountryCode: { contains: q, mode: "insensitive" } },
          ],
        }
      : {}),
  };

  const rows = await db.routeTemplate.findMany({
    where,
    include: {
      company: { select: { id: true, name: true, code: true, type: true } },
      legs: { orderBy: [{ sequence: "asc" }, { createdAt: "asc" }] }, 
      _count: { select: { legs: true } },
    },
    orderBy: [{ companyId: "asc" }, { priority: "desc" }, { createdAt: "asc" }],
    ...(usePagination
      ? {
          take: limit + 1,
          ...(filters.cursor ? { cursor: { id: filters.cursor }, skip: 1 } : {}),
        }
      : {}),
  });

  if (!usePagination) return rows.map(mapTemplateRow);

  const pageRows = rows.slice(0, limit);
  const hasNextPage = rows.length > limit;
  const total = await db.routeTemplate.count({ where });
  return {
    data: pageRows.map(mapTemplateRow),
    total,
    pageInfo: {
      limit,
      hasNextPage,
      nextCursor: hasNextPage ? pageRows[pageRows.length - 1]?.id ?? null : null,
    },
  };
}

export async function getRouteTemplateForActor(args: {
  user: AuthUser;
  routeTemplateId: string;
}) {
  const row = await getTemplateAccessibleOrThrow(
    args.user,
    args.routeTemplateId,
    "integration.routing.read",
  );
  return mapTemplateRow(row);
}

export async function createRouteTemplateForActor(args: {
  user: AuthUser;
  input: RouteTemplateInput;
}) {
  await assertCompanyAccess(args.user, args.input.companyId, "integration.routing.manage");
  const normalized = normalizeTemplateInput(args.input);

  const row = await db.routeTemplate.create({
    data: {
      companyId: normalized.companyId,
      name: normalized.name,
      code: normalized.code,
      isActive: normalized.isActive,
      priority: normalized.priority,
      serviceType: normalized.serviceType,
      transportMode: normalized.transportMode,
      originCountryCode: normalized.originCountryCode,
      destinationCountryCode: normalized.destinationCountryCode,
      metadata:
        normalized.metadata === undefined
          ? undefined
          : (normalized.metadata as Prisma.InputJsonValue),
      createdByUserId: args.user.id,
      updatedByUserId: args.user.id,
      legs: {
        create: normalized.legs.map((leg) => ({
          sequence: leg.sequence,
          legCode: leg.legCode,
          label: leg.label,
          mode: leg.mode,
          originCountryCode: leg.originCountryCode,
          destinationCountryCode: leg.destinationCountryCode,
          metadata:
            leg.metadata === undefined ? undefined : (leg.metadata as Prisma.InputJsonValue),
        })),
      },
    },
    include: {
      company: { select: { id: true, name: true, code: true, type: true } },
      legs: { orderBy: [{ sequence: "asc" }, { createdAt: "asc" }] },
    },
  });
  return mapTemplateRow(row);
}

export async function updateRouteTemplateForActor(args: {
  user: AuthUser;
  routeTemplateId: string;
  input: Partial<RouteTemplateInput>;
}) {
  const existing = await getTemplateAccessibleOrThrow(
    args.user,
    args.routeTemplateId,
    "integration.routing.manage",
  );
  const merged = {
    companyId: existing.companyId,
    name: args.input.name ?? existing.name,
    code: args.input.code === undefined ? existing.code : args.input.code,
    isActive: args.input.isActive ?? existing.isActive,
    priority: args.input.priority ?? existing.priority,
    serviceType:
      args.input.serviceType === undefined ? existing.serviceType : args.input.serviceType,
    transportMode:
      args.input.transportMode === undefined
        ? existing.transportMode
        : args.input.transportMode,
    originCountryCode:
      args.input.originCountryCode === undefined
        ? existing.originCountryCode
        : args.input.originCountryCode,
    destinationCountryCode:
      args.input.destinationCountryCode === undefined
        ? existing.destinationCountryCode
        : args.input.destinationCountryCode,
    metadata: args.input.metadata === undefined ? existing.metadata : args.input.metadata,
    legs:
      args.input.legs === undefined
        ? existing.legs.map((leg: any) => ({
            id: leg.id,
            sequence: leg.sequence,
            legCode: leg.legCode,
            label: leg.label,
            mode: leg.mode,
            originCountryCode: leg.originCountryCode,
            destinationCountryCode: leg.destinationCountryCode,
            metadata: leg.metadata,
          }))
        : args.input.legs,
  } satisfies RouteTemplateInput;

  const normalized = normalizeTemplateInput(merged);
  const row = await db.$transaction(async (tx: any) => {
    if (args.input.legs !== undefined) {
      const existingLegs = await tx.routeTemplateLeg.findMany({
        where: { routeTemplateId: existing.id },
        select: { id: true },
      });
      const existingLegIds = new Set(existingLegs.map((leg: { id: string }) => leg.id));
      const incomingLegIds = normalized.legs
        .map((leg) => leg.id)
        .filter((id): id is string => Boolean(id));
      const unknownLegId = incomingLegIds.find((id) => !existingLegIds.has(id));
      if (unknownLegId) {
        const err = new Error("route template leg id does not belong to this route template") as Error & {
          statusCode: number;
        };
        err.statusCode = 400;
        throw err;
      }

      await Promise.all(
        incomingLegIds.map((id, index) =>
          tx.routeTemplateLeg.update({
            where: { id },
            data: {
              sequence: -(index + 1),
              legCode: `__tmp_${id}`,
            },
          }),
        ),
      );

      await tx.routeTemplateLeg.deleteMany({
        where: {
          routeTemplateId: existing.id,
          ...(incomingLegIds.length > 0 ? { id: { notIn: incomingLegIds } } : {}),
        },
      });
    }

    const updated = await tx.routeTemplate.update({
      where: { id: existing.id },
      data: {
        name: normalized.name,
        code: normalized.code,
        isActive: normalized.isActive,
        priority: normalized.priority,
        serviceType: normalized.serviceType,
        transportMode: normalized.transportMode,
        originCountryCode: normalized.originCountryCode,
        destinationCountryCode: normalized.destinationCountryCode,
        metadata:
          normalized.metadata === undefined
            ? undefined
            : (normalized.metadata as Prisma.InputJsonValue),
        updatedByUserId: args.user.id,
      },
      include: {
        company: { select: { id: true, name: true, code: true, type: true } },
        legs: { orderBy: [{ sequence: "asc" }, { createdAt: "asc" }] },
      },
    });

    if (args.input.legs !== undefined) {
      for (const leg of normalized.legs) {
        const data = {
          sequence: leg.sequence,
          legCode: leg.legCode,
          label: leg.label,
          mode: leg.mode,
          originCountryCode: leg.originCountryCode,
          destinationCountryCode: leg.destinationCountryCode,
          metadata:
            leg.metadata === undefined ? undefined : (leg.metadata as Prisma.InputJsonValue),
        };
        if (leg.id) {
          await tx.routeTemplateLeg.update({
            where: { id: leg.id },
            data,
          });
        } else {
          await tx.routeTemplateLeg.create({
            data: {
              routeTemplateId: existing.id,
              ...data,
            },
          });
        }
      }
    }

    return tx.routeTemplate.findUnique({
      where: { id: updated.id },
      include: {
        company: { select: { id: true, name: true, code: true, type: true } },
        legs: { orderBy: [{ sequence: "asc" }, { createdAt: "asc" }] },
      },
    });
  });

  return mapTemplateRow(row);
}

export async function deleteRouteTemplateForActor(args: {
  user: AuthUser;
  routeTemplateId: string;
}) {
  const existing = await getTemplateAccessibleOrThrow(
    args.user,
    args.routeTemplateId,
    "integration.routing.manage",
  );
  await db.routeTemplate.delete({ where: { id: existing.id } });
  return { deleted: true, id: existing.id };
}
