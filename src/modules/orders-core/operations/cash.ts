import { CashCollectionKind, CashCollectionStatus } from "@prisma/client";
import {
  emitDriverNotification,
  emitDriverOrderUpdate,
} from "../../../features/realtime/realtimeHub";
import {
  collectOrderCash,
  getCashQueueSummaryForActor,
  handoffOrderCash,
  listCashQueueForActor,
  settleOrderCash,
} from "../../../features/cash/cashCollection.service";
import { ORDER_BULK_MAX_IDS, orderError } from "../shared";
import type { OrderActor } from "../shared";

type CashBulkItem = {
  orderId: string;
  kind: CashCollectionKind;
};

type CashCollectBulkItem = CashBulkItem & {
  amount?: number | null;
  note?: string | null;
};

type CashFiltersInput = {
  statuses?: unknown;
  kinds?: unknown;
  from?: unknown;
  to?: unknown;
};

type CashQueueInput = {
  actor: OrderActor;
  query: {
    page?: unknown;
    pageSize?: unknown;
    limit?: unknown;
  } & CashFiltersInput;
};

type CashQueueSummaryInput = {
  actor: OrderActor;
  query: CashFiltersInput;
};

type CollectCashInput = {
  actor: OrderActor;
  orderId: string;
  body: { kind?: unknown; amount?: unknown; note?: unknown };
};

type HandoffCashInput = {
  actor: OrderActor;
  orderId: string;
  body: {
    kind?: unknown;
    toHolderType?: unknown;
    toDriverId?: unknown;
    toWarehouseId?: unknown;
    note?: unknown;
  };
};

type SettleCashInput = {
  actor: OrderActor;
  orderId: string;
  body: { kind?: unknown; note?: unknown };
};

type CashBulkInput = {
  actor: OrderActor;
  body: Record<string, unknown>;
};

function parseKind(value: unknown): CashCollectionKind {
  if (value === CashCollectionKind.cod) return CashCollectionKind.cod;
  if (value === CashCollectionKind.service_charge) return CashCollectionKind.service_charge;
  throw new Error("kind must be 'cod' or 'service_charge'");
}

function parseBulkItems(input: unknown): CashBulkItem[] {
  if (!Array.isArray(input) || input.length === 0) {
    throw orderError("items must be a non-empty array", 400);
  }

  const normalized = input
    .map((raw) => {
      const item = raw as { orderId?: unknown; kind?: unknown };
      const orderId = typeof item?.orderId === "string" ? item.orderId.trim() : "";
      if (!orderId) throw orderError("Each item must contain a valid orderId", 400);
      return { orderId, kind: parseKind(item?.kind) };
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
    const item = raw as { orderId?: unknown; kind?: unknown; amount?: unknown; note?: unknown };
    const orderId = typeof item?.orderId === "string" ? item.orderId.trim() : "";
    if (!orderId) throw orderError("Each item must contain a valid orderId", 400);

    const amount = item?.amount == null || item?.amount === "" ? null : Number(item.amount);
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

function pushDriverCashRealtime(order: any, kind: CashCollectionKind, title: string, body: string) {
  const assignedDriverId = String(order?.assignedDriverId ?? "").trim();
  if (!assignedDriverId) return;

  const orderId = String(order?.id ?? "").trim();
  const orderNumber = String(order?.orderNumber ?? "").trim();
  const status = String(order?.status ?? "").trim();
  const updatedAt = new Date().toISOString();

  emitDriverOrderUpdate(assignedDriverId, {
    orderId,
    orderNumber: orderNumber || null,
    status,
    updatedAt,
  });

  void emitDriverNotification(assignedDriverId, {
    type: "cash",
    orderId,
    title,
    body: `${body} (${kind === CashCollectionKind.cod ? "COD" : "Service charge"})`,
    at: updatedAt,
  }).catch(() => undefined);
}

function buildCashFilters(query: CashFiltersInput) {
  return {
    statuses: parseStatuses(query.statuses),
    kinds: parseKinds(query.kinds),
    from: parseDate(query.from),
    to: parseDate(query.to),
  };
}

export async function listCashQueueForActorView(input: CashQueueInput) {
  const { actor, query } = input;
  const page = Number(query?.page);
  const pageSize = Number(query?.pageSize ?? query?.limit);
  return listCashQueueForActor({
    actor,
    filters: {
      ...buildCashFilters(query),
      page: Number.isFinite(page) ? page : undefined,
      pageSize: Number.isFinite(pageSize) ? pageSize : undefined,
    },
  });
}

export async function getCashQueueSummaryForActorView(input: CashQueueSummaryInput) {
  return getCashQueueSummaryForActor({
    actor: input.actor,
    filters: buildCashFilters(input.query),
  });
}

export async function collectCashForActor(input: CollectCashInput) {
  const { actor, orderId, body } = input;
  const kind = parseKind(body.kind);
  const order = await collectOrderCash({
    orderId,
    kind,
    amount: body.amount == null || body.amount === "" ? null : Number(body.amount),
    note: typeof body.note === "string" ? body.note : null,
    actor,
  });

  pushDriverCashRealtime(
    order,
    kind,
    `Cash collected for order ${order?.orderNumber ?? order?.id}`,
    "Cash custody has been updated.",
  );

  return { success: true, message: "Cash collection updated", order };
}

export async function handoffCashForActor(input: HandoffCashInput) {
  const { actor, orderId, body } = input;
  const toHolderType =
    body.toHolderType === "driver" ||
    body.toHolderType === "warehouse" ||
    body.toHolderType === "pickup_point"
      ? body.toHolderType
      : null;
  if (!toHolderType) {
    throw orderError("toHolderType must be 'driver', 'warehouse', or 'pickup_point'", 400);
  }

  const kind = parseKind(body.kind);
  const order = await handoffOrderCash({
    orderId,
    kind,
    toHolderType,
    toDriverId: typeof body.toDriverId === "string" ? body.toDriverId : null,
    toWarehouseId: typeof body.toWarehouseId === "string" ? body.toWarehouseId : null,
    note: typeof body.note === "string" ? body.note : null,
    actor,
  });

  pushDriverCashRealtime(
    order,
    kind,
    `Cash handoff for order ${order?.orderNumber ?? order?.id}`,
    "Cash holder has been changed.",
  );

  return { success: true, message: "Cash handoff recorded", order };
}

export async function settleCashForActor(input: SettleCashInput) {
  const { actor, orderId, body } = input;
  const kind = parseKind(body.kind);
  const order = await settleOrderCash({
    orderId,
    kind,
    note: typeof body.note === "string" ? body.note : null,
    actor,
  });

  pushDriverCashRealtime(
    order,
    kind,
    `Cash settled for order ${order?.orderNumber ?? order?.id}`,
    "Cash was settled to finance.",
  );

  return { success: true, message: "Cash settled to finance", order };
}

export async function collectCashBulkForActor(input: CashBulkInput) {
  const { actor, body } = input;
  const items = parseCollectBulkItems(body.items);
  const defaultNote = typeof body.note === "string" ? body.note : null;

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
  for (const order of orders) {
    const matched = items.find((item) => item.orderId === order?.id);
    if (!matched) continue;
    pushDriverCashRealtime(
      order,
      matched.kind,
      `Cash collected for order ${order?.orderNumber ?? order?.id}`,
      "Cash custody has been updated.",
    );
  }

  return {
    statusCode: failed.length ? 207 : 200,
    payload: {
      success: failed.length === 0,
      count: orders.length,
      failedCount: failed.length,
      orders,
      failed,
    },
  };
}

export async function handoffCashBulkForActor(input: CashBulkInput) {
  const { actor, body } = input;
  const toHolderType =
    body.toHolderType === "driver" ||
    body.toHolderType === "warehouse" ||
    body.toHolderType === "pickup_point"
      ? body.toHolderType
      : null;
  if (!toHolderType) {
    throw orderError("toHolderType must be 'driver', 'warehouse', or 'pickup_point'", 400);
  }

  const items = parseBulkItems(body.items);
  const note = typeof body.note === "string" ? body.note : null;
  const toDriverId = typeof body.toDriverId === "string" ? body.toDriverId : null;
  const toWarehouseId = typeof body.toWarehouseId === "string" ? body.toWarehouseId : null;

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
  for (const order of orders) {
    const matched = items.find((item) => item.orderId === order?.id);
    if (!matched) continue;
    pushDriverCashRealtime(
      order,
      matched.kind,
      `Cash handoff for order ${order?.orderNumber ?? order?.id}`,
      "Cash holder has been changed.",
    );
  }

  return {
    statusCode: failed.length ? 207 : 200,
    payload: {
      success: failed.length === 0,
      count: orders.length,
      failedCount: failed.length,
      orders,
      failed,
    },
  };
}

export async function settleCashBulkForActor(input: CashBulkInput) {
  const { actor, body } = input;
  const items = parseBulkItems(body.items);
  const note = typeof body.note === "string" ? body.note : null;

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
  for (const order of orders) {
    const matched = items.find((item) => item.orderId === order?.id);
    if (!matched) continue;
    pushDriverCashRealtime(
      order,
      matched.kind,
      `Cash settled for order ${order?.orderNumber ?? order?.id}`,
      "Cash was settled to finance.",
    );
  }

  return {
    statusCode: failed.length ? 207 : 200,
    payload: {
      success: failed.length === 0,
      count: orders.length,
      failedCount: failed.length,
      orders,
      failed,
    },
  };
}
