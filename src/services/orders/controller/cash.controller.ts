import { CashCollectionKind, CashCollectionStatus } from "@prisma/client";

import {
  collectOrderCash,
  getCashQueueSummaryForActor,
  handoffOrderCash,
  listCashQueueForActor,
  settleOrderCash,
} from "../../../features/cash/cashCollection.service";
import {
  ORDER_BULK_MAX_IDS,
  orderError,
  requireOrderActor,
} from "../orderService.shared";

type CashBulkItem = {
  orderId: string;
  kind: CashCollectionKind;
};

type CashCollectBulkItem = CashBulkItem & {
  amount?: number | null;
  note?: string | null;
};

function parseKind(value: unknown): CashCollectionKind {
  if (value === CashCollectionKind.cod) return CashCollectionKind.cod;
  if (value === CashCollectionKind.service_charge) {
    return CashCollectionKind.service_charge;
  }
  throw new Error("kind must be 'cod' or 'service_charge'");
}

function parseBulkItems(input: unknown): CashBulkItem[] {
  if (!Array.isArray(input) || input.length === 0) {
    throw orderError("items must be a non-empty array", 400);
  }

  const normalized = input
    .map((raw) => {
      const item = raw as { orderId?: unknown; kind?: unknown };
      const orderId =
        typeof item?.orderId === "string" ? item.orderId.trim() : "";
      if (!orderId) {
        throw orderError("Each item must contain a valid orderId", 400);
      }
      return {
        orderId,
        kind: parseKind(item?.kind),
      };
    })
    .reduce<CashBulkItem[]>((acc, item) => {
      if (!acc.some((row) => row.orderId === item.orderId && row.kind === item.kind)) {
        acc.push(item);
      }
      return acc;
    }, []);

  if (normalized.length > ORDER_BULK_MAX_IDS) {
    throw orderError(
      `Too many cash items: ${normalized.length}. Maximum is ${ORDER_BULK_MAX_IDS}.`,
      400,
    );
  }

  return normalized;
}

function parseCollectBulkItems(input: unknown): CashCollectBulkItem[] {
  if (!Array.isArray(input) || input.length === 0) {
    throw orderError("items must be a non-empty array", 400);
  }

  const normalized = input.map((raw) => {
    const item = raw as {
      orderId?: unknown;
      kind?: unknown;
      amount?: unknown;
      note?: unknown;
    };

    const orderId = typeof item?.orderId === "string" ? item.orderId.trim() : "";
    if (!orderId) {
      throw orderError("Each item must contain a valid orderId", 400);
    }

    const amount =
      item?.amount == null || item?.amount === ""
        ? null
        : Number(item.amount);
    if (amount != null && (!Number.isFinite(amount) || amount <= 0)) {
      throw orderError("Collected amount must be a positive number", 400);
    }

    return {
      orderId,
      kind: parseKind(item?.kind),
      amount,
      note: typeof item?.note === "string" ? item.note : null,
    };
  });

  if (normalized.length > ORDER_BULK_MAX_IDS) {
    throw orderError(
      `Too many cash items: ${normalized.length}. Maximum is ${ORDER_BULK_MAX_IDS}.`,
      400,
    );
  }

  return normalized;
}

function asQueryStringArray(input: unknown): string[] {
  if (Array.isArray(input)) {
    return input
      .flatMap((item) => String(item ?? "").split(","))
      .map((value) => value.trim())
      .filter(Boolean);
  }
  if (typeof input === "string") {
    return input
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
  }
  return [];
}

function parseStatuses(input: unknown): CashCollectionStatus[] {
  const values = asQueryStringArray(input);
  const statuses = values.filter(
    (value): value is CashCollectionStatus =>
      value === CashCollectionStatus.expected ||
      value === CashCollectionStatus.held ||
      value === CashCollectionStatus.settled,
  );
  return Array.from(new Set(statuses));
}

function parseKinds(input: unknown): CashCollectionKind[] {
  const values = asQueryStringArray(input);
  const kinds = values.filter(
    (value): value is CashCollectionKind =>
      value === CashCollectionKind.cod || value === CashCollectionKind.service_charge,
  );
  return Array.from(new Set(kinds));
}

function parseDate(input: unknown): Date | undefined {
  if (typeof input !== "string" || !input.trim()) return undefined;
  const parsed = new Date(input);
  if (Number.isNaN(parsed.getTime())) return undefined;
  return parsed;
}

function uniqueOrders(orders: any[]) {
  const seen = new Set<string>();
  const rows: any[] = [];
  for (const order of orders) {
    const key = typeof order?.id === "string" ? order.id : "";
    if (!key || seen.has(key)) continue;
    seen.add(key);
    rows.push(order);
  }
  return rows;
}

/** Lists cash queue items scoped for current actor (manager or warehouse). */
export async function listCashQueue(req: any, res: any) {
  try {
    const actor = requireOrderActor(req.user);

    const page = Number(req.query?.page);
    const pageSize = Number(req.query?.pageSize ?? req.query?.limit);

    const data = await listCashQueueForActor({
      actor,
      filters: {
        page: Number.isFinite(page) ? page : undefined,
        pageSize: Number.isFinite(pageSize) ? pageSize : undefined,
        statuses: parseStatuses(req.query?.statuses),
        kinds: parseKinds(req.query?.kinds),
        from: parseDate(req.query?.from),
        to: parseDate(req.query?.to),
      },
    });

    return res.json(data);
  } catch (err: any) {
    return res
      .status(err?.statusCode ?? 400)
      .json({ error: err?.message ?? "Failed to load cash queue" });
  }
}

/** Returns cash queue totals scoped for current actor (manager or warehouse). */
export async function getCashQueueSummary(req: any, res: any) {
  try {
    const actor = requireOrderActor(req.user);
    const summary = await getCashQueueSummaryForActor({
      actor,
      filters: {
        statuses: parseStatuses(req.query?.statuses),
        kinds: parseKinds(req.query?.kinds),
        from: parseDate(req.query?.from),
        to: parseDate(req.query?.to),
      },
    });
    return res.json(summary);
  } catch (err: any) {
    return res
      .status(err?.statusCode ?? 400)
      .json({ error: err?.message ?? "Failed to load cash queue summary" });
  }
}

/** Marks a cash item as collected into active custody for an order. */
export async function collectCash(req: any, res: any) {
  try {
    const actor = requireOrderActor(req.user);
    const order = await collectOrderCash({
      orderId: req.params.id,
      kind: parseKind(req.body?.kind),
      amount:
        req.body?.amount == null || req.body?.amount === ""
          ? null
          : Number(req.body.amount),
      note: typeof req.body?.note === "string" ? req.body.note : null,
      actor,
    });

    return res.json({
      success: true,
      message: "Cash collection updated",
      order,
    });
  } catch (err: any) {
    return res
      .status(err?.statusCode ?? 400)
      .json({ error: err?.message ?? "Failed to collect cash" });
  }
}

/** Transfers held cash between operational holders while preserving history. */
export async function handoffCash(req: any, res: any) {
  try {
    const actor = requireOrderActor(req.user);
    const toHolderType =
      req.body?.toHolderType === "driver" ||
      req.body?.toHolderType === "warehouse" ||
      req.body?.toHolderType === "pickup_point"
        ? req.body.toHolderType
        : null;

    if (!toHolderType) {
      return res.status(400).json({
        error: "toHolderType must be 'driver', 'warehouse', or 'pickup_point'",
      });
    }

    const order = await handoffOrderCash({
      orderId: req.params.id,
      kind: parseKind(req.body?.kind),
      toHolderType,
      toDriverId:
        typeof req.body?.toDriverId === "string" ? req.body.toDriverId : null,
      toWarehouseId:
        typeof req.body?.toWarehouseId === "string"
          ? req.body.toWarehouseId
          : null,
      note: typeof req.body?.note === "string" ? req.body.note : null,
      actor,
    });

    return res.json({
      success: true,
      message: "Cash handoff recorded",
      order,
    });
  } catch (err: any) {
    return res
      .status(err?.statusCode ?? 400)
      .json({ error: err?.message ?? "Failed to hand off cash" });
  }
}

/** Settles held cash into finance custody. */
export async function settleCash(req: any, res: any) {
  try {
    const actor = requireOrderActor(req.user);
    const order = await settleOrderCash({
      orderId: req.params.id,
      kind: parseKind(req.body?.kind),
      note: typeof req.body?.note === "string" ? req.body.note : null,
      actor,
    });

    return res.json({
      success: true,
      message: "Cash settled to finance",
      order,
    });
  } catch (err: any) {
    return res
      .status(err?.statusCode ?? 400)
      .json({ error: err?.message ?? "Failed to settle cash" });
  }
}

/** Collects multiple cash items into active custody with partial success output. */
export async function collectCashBulk(req: any, res: any) {
  try {
    const actor = requireOrderActor(req.user);
    const items = parseCollectBulkItems(req.body?.items);
    const defaultNote =
      typeof req.body?.note === "string" ? req.body.note : null;

    const updatedOrders: any[] = [];
    const failed: Array<{ orderId: string; kind: CashCollectionKind; error: string }> = [];

    for (const item of items) {
      try {
        const order = await collectOrderCash({
          orderId: item.orderId,
          kind: item.kind,
          amount: item.amount ?? null,
          note: item.note ?? defaultNote,
          actor,
        });
        if (order) updatedOrders.push(order);
      } catch (err: any) {
        failed.push({
          orderId: item.orderId,
          kind: item.kind,
          error: err?.message ?? "Failed to collect cash",
        });
      }
    }

    const orders = uniqueOrders(updatedOrders);
    const status = failed.length ? 207 : 200;
    return res.status(status).json({
      success: failed.length === 0,
      count: orders.length,
      failedCount: failed.length,
      orders,
      failed,
    });
  } catch (err: any) {
    return res
      .status(err?.statusCode ?? 400)
      .json({ error: err?.message ?? "Failed to collect cash in bulk" });
  }
}

/** Records holder handoff for multiple cash items with partial success output. */
export async function handoffCashBulk(req: any, res: any) {
  try {
    const actor = requireOrderActor(req.user);
    const toHolderType =
      req.body?.toHolderType === "driver" ||
      req.body?.toHolderType === "warehouse" ||
      req.body?.toHolderType === "pickup_point"
        ? req.body.toHolderType
        : null;

    if (!toHolderType) {
      return res.status(400).json({
        error: "toHolderType must be 'driver', 'warehouse', or 'pickup_point'",
      });
    }

    const items = parseBulkItems(req.body?.items);
    const note = typeof req.body?.note === "string" ? req.body.note : null;
    const toDriverId =
      typeof req.body?.toDriverId === "string" ? req.body.toDriverId : null;
    const toWarehouseId =
      typeof req.body?.toWarehouseId === "string" ? req.body.toWarehouseId : null;

    const updatedOrders: any[] = [];
    const failed: Array<{ orderId: string; kind: CashCollectionKind; error: string }> = [];

    for (const item of items) {
      try {
        const order = await handoffOrderCash({
          orderId: item.orderId,
          kind: item.kind,
          toHolderType,
          toDriverId,
          toWarehouseId,
          note,
          actor,
        });
        if (order) updatedOrders.push(order);
      } catch (err: any) {
        failed.push({
          orderId: item.orderId,
          kind: item.kind,
          error: err?.message ?? "Failed to hand off cash",
        });
      }
    }

    const orders = uniqueOrders(updatedOrders);
    const status = failed.length ? 207 : 200;
    return res.status(status).json({
      success: failed.length === 0,
      count: orders.length,
      failedCount: failed.length,
      orders,
      failed,
    });
  } catch (err: any) {
    return res
      .status(err?.statusCode ?? 400)
      .json({ error: err?.message ?? "Failed to hand off cash in bulk" });
  }
}

/** Settles multiple held cash items to finance with partial success output. */
export async function settleCashBulk(req: any, res: any) {
  try {
    const actor = requireOrderActor(req.user);
    const items = parseBulkItems(req.body?.items);
    const note = typeof req.body?.note === "string" ? req.body.note : null;

    const updatedOrders: any[] = [];
    const failed: Array<{ orderId: string; kind: CashCollectionKind; error: string }> = [];

    for (const item of items) {
      try {
        const order = await settleOrderCash({
          orderId: item.orderId,
          kind: item.kind,
          note,
          actor,
        });
        if (order) updatedOrders.push(order);
      } catch (err: any) {
        failed.push({
          orderId: item.orderId,
          kind: item.kind,
          error: err?.message ?? "Failed to settle cash",
        });
      }
    }

    const orders = uniqueOrders(updatedOrders);
    const status = failed.length ? 207 : 200;
    return res.status(status).json({
      success: failed.length === 0,
      count: orders.length,
      failedCount: failed.length,
      orders,
      failed,
    });
  } catch (err: any) {
    return res
      .status(err?.statusCode ?? 400)
      .json({ error: err?.message ?? "Failed to settle cash in bulk" });
  }
}
