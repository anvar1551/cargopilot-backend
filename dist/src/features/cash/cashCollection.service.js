"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.collectOrderCash = collectOrderCash;
exports.handoffOrderCash = handoffOrderCash;
exports.settleOrderCash = settleOrderCash;
exports.listCashQueueForActor = listCashQueueForActor;
exports.getCashQueueSummaryForActor = getCashQueueSummaryForActor;
const client_1 = require("@prisma/client");
const prismaClient_1 = __importDefault(require("../../config/prismaClient"));
const repo_1 = require("../../services/orders/repo");
const orderService_shared_1 = require("../../services/orders/orderService.shared");
async function loadOrderContext(tx, orderId) {
    const order = await tx.order.findUnique({
        where: { id: orderId },
        select: {
            id: true,
            assignedDriverId: true,
            currentWarehouseId: true,
            codAmount: true,
            codPaidStatus: true,
            serviceCharge: true,
            serviceChargePaidStatus: true,
            deliveryChargePaidBy: true,
            currency: true,
        },
    });
    if (!order) {
        throw (0, orderService_shared_1.orderError)("Order not found", 404);
    }
    return order;
}
async function findCollection(tx, orderId, kind) {
    return tx.cashCollection.findUnique({
        where: {
            orderId_kind: {
                orderId,
                kind,
            },
        },
        include: {
            currentHolderUser: {
                select: { id: true, name: true, email: true, role: true },
            },
            currentHolderWarehouse: true,
            events: {
                include: {
                    actor: {
                        select: { id: true, name: true, email: true, role: true },
                    },
                },
                orderBy: { createdAt: "asc" },
            },
        },
    });
}
function isPositiveNumber(value) {
    const amount = Number(value ?? 0);
    return Number.isFinite(amount) && amount > 0;
}
function isPendingPaidStatus(value) {
    return value !== client_1.PaidStatus.PAID;
}
function resolveExpectedAmountForKind(order, kind) {
    if (kind === client_1.CashCollectionKind.cod &&
        isPositiveNumber(order.codAmount) &&
        isPendingPaidStatus(order.codPaidStatus)) {
        return Number(order.codAmount);
    }
    if (kind === client_1.CashCollectionKind.service_charge &&
        isPositiveNumber(order.serviceCharge) &&
        isPendingPaidStatus(order.serviceChargePaidStatus) &&
        (order.deliveryChargePaidBy === client_1.PaidBy.SENDER ||
            order.deliveryChargePaidBy === client_1.PaidBy.RECIPIENT)) {
        return Number(order.serviceCharge);
    }
    return null;
}
async function ensureCollectionForCollect(tx, order, kind, actor) {
    const existing = await findCollection(tx, order.id, kind);
    if (existing)
        return existing;
    const expectedAmount = resolveExpectedAmountForKind(order, kind);
    if (!isPositiveNumber(expectedAmount)) {
        throw (0, orderService_shared_1.orderError)("Cash collection record not found for this order and no collectible amount is configured", 404);
    }
    await tx.cashCollection.create({
        data: {
            orderId: order.id,
            kind,
            status: client_1.CashCollectionStatus.expected,
            expectedAmount,
            currency: order.currency ?? null,
            events: {
                create: {
                    eventType: client_1.CashCollectionEventType.expected,
                    amount: expectedAmount,
                    note: kind === client_1.CashCollectionKind.cod
                        ? "COD expected for this order"
                        : "Service charge expected for this order",
                    actorId: actor.id,
                    actorRole: actor.role,
                    toHolderType: client_1.CashHolderType.none,
                    toHolderName: "Not collected yet",
                },
            },
        },
    });
    const created = await findCollection(tx, order.id, kind);
    if (!created) {
        throw (0, orderService_shared_1.orderError)("Failed to initialize cash collection record", 500);
    }
    return created;
}
async function loadCollection(tx, orderId, kind) {
    const collection = await findCollection(tx, orderId, kind);
    if (!collection) {
        throw (0, orderService_shared_1.orderError)("Cash collection record not found for this order", 404);
    }
    return collection;
}
function assertActorCanAccessOrder(order, actor) {
    if (actor.role === client_1.AppRole.manager)
        return;
    if (actor.role === client_1.AppRole.driver) {
        if (order.assignedDriverId === actor.id)
            return;
        throw (0, orderService_shared_1.orderError)("Only the assigned driver can update cash for this order", 403);
    }
    if (actor.role === client_1.AppRole.warehouse) {
        if (actor.warehouseId && order.currentWarehouseId === actor.warehouseId)
            return;
        throw (0, orderService_shared_1.orderError)("Warehouse user can only update cash for orders at their location", 403);
    }
    throw (0, orderService_shared_1.orderError)("Forbidden", 403);
}
function assertCollectionMutable(collection) {
    if (collection.status === client_1.CashCollectionStatus.cancelled) {
        throw (0, orderService_shared_1.orderError)("Cancelled cash collection cannot be changed", 400);
    }
    if (collection.status === client_1.CashCollectionStatus.settled) {
        throw (0, orderService_shared_1.orderError)("Settled cash collection cannot be changed", 400);
    }
}
async function resolveActorWarehouse(tx, actor) {
    if (!actor.warehouseId) {
        throw (0, orderService_shared_1.orderError)("Warehouse context is required for this action", 400);
    }
    const warehouse = await tx.warehouse.findUnique({
        where: { id: actor.warehouseId },
        select: { id: true, name: true, type: true },
    });
    if (!warehouse) {
        throw (0, orderService_shared_1.orderError)("Warehouse not found", 404);
    }
    return warehouse;
}
async function resolveDriver(tx, driverId) {
    const driver = await tx.user.findUnique({
        where: { id: driverId },
        select: { id: true, name: true, role: true },
    });
    if (!driver || driver.role !== client_1.AppRole.driver) {
        throw (0, orderService_shared_1.orderError)("Driver not found", 404);
    }
    return { id: driver.id, name: driver.name };
}
function warehouseToHolderType(type) {
    return type === client_1.WarehouseType.pickup_point
        ? client_1.CashHolderType.pickup_point
        : client_1.CashHolderType.warehouse;
}
function eventHolderName(holderType, label) {
    if (label)
        return label;
    if (!holderType || holderType === client_1.CashHolderType.none)
        return "Not collected yet";
    return holderType.replace("_", " ");
}
function resolvePaidStatusFromCollection(expectedAmount, collectedAmount) {
    const expected = Number(expectedAmount ?? 0);
    if (!Number.isFinite(expected) || expected <= 0) {
        return client_1.PaidStatus.PAID;
    }
    return collectedAmount >= expected ? client_1.PaidStatus.PAID : client_1.PaidStatus.PARTIAL;
}
async function collectOrderCash(params) {
    const { orderId, kind, actor } = params;
    await prismaClient_1.default.$transaction(async (tx) => {
        const order = await loadOrderContext(tx, orderId);
        assertActorCanAccessOrder(order, actor);
        const collection = await ensureCollectionForCollect(tx, order, kind, actor);
        assertCollectionMutable(collection);
        let holderType = client_1.CashHolderType.none;
        let holderUserId = null;
        let holderWarehouseId = null;
        let holderLabel = null;
        if (actor.role === client_1.AppRole.driver) {
            if (collection.status === client_1.CashCollectionStatus.held &&
                collection.currentHolderType !== client_1.CashHolderType.driver) {
                throw (0, orderService_shared_1.orderError)("Driver cannot collect cash already held by another location or person", 403);
            }
            if (collection.status === client_1.CashCollectionStatus.held &&
                collection.currentHolderUserId &&
                collection.currentHolderUserId !== actor.id) {
                throw (0, orderService_shared_1.orderError)("Driver can only update cash currently held by them", 403);
            }
            holderType = client_1.CashHolderType.driver;
            holderUserId = actor.id;
            holderLabel = collection.currentHolderUser?.name ?? "Driver";
        }
        else if (actor.role === client_1.AppRole.warehouse) {
            if (collection.status === client_1.CashCollectionStatus.held &&
                collection.currentHolderType === client_1.CashHolderType.driver) {
                throw (0, orderService_shared_1.orderError)("Warehouse must accept driver cash through handoff, not direct collection", 400);
            }
            if (collection.status === client_1.CashCollectionStatus.held &&
                collection.currentHolderType !== client_1.CashHolderType.warehouse &&
                collection.currentHolderType !== client_1.CashHolderType.pickup_point) {
                throw (0, orderService_shared_1.orderError)("Warehouse cannot overwrite cash already held elsewhere", 403);
            }
            const warehouse = await resolveActorWarehouse(tx, actor);
            holderType = warehouseToHolderType(warehouse.type);
            holderWarehouseId = warehouse.id;
            holderLabel = warehouse.name;
        }
        else {
            throw (0, orderService_shared_1.orderError)("Manager collection requires a specific target holder and is not enabled in this phase", 400);
        }
        const nextAmount = params.amount != null
            ? Number(params.amount)
            : collection.collectedAmount ?? collection.expectedAmount;
        if (!Number.isFinite(nextAmount) || nextAmount <= 0) {
            throw (0, orderService_shared_1.orderError)("Collected amount must be greater than zero", 400);
        }
        const nextEventType = collection.status === client_1.CashCollectionStatus.expected
            ? client_1.CashCollectionEventType.collected
            : client_1.CashCollectionEventType.handoff;
        const nextPaidStatus = resolvePaidStatusFromCollection(collection.expectedAmount, nextAmount);
        await tx.cashCollection.update({
            where: { id: collection.id },
            data: {
                status: client_1.CashCollectionStatus.held,
                collectedAmount: nextAmount,
                currentHolderType: holderType,
                currentHolderUserId: holderUserId,
                currentHolderWarehouseId: holderWarehouseId,
                currentHolderLabel: holderLabel,
                collectedAt: collection.collectedAt ?? new Date(),
                note: params.note ?? collection.note ?? null,
                events: {
                    create: {
                        eventType: nextEventType,
                        amount: nextAmount,
                        note: params.note ?? null,
                        fromHolderType: collection.currentHolderType,
                        fromHolderId: collection.currentHolderUserId ??
                            collection.currentHolderWarehouseId ??
                            null,
                        fromHolderName: eventHolderName(collection.currentHolderType, collection.currentHolderLabel),
                        toHolderType: holderType,
                        toHolderId: holderUserId ?? holderWarehouseId,
                        toHolderName: holderLabel,
                        actorId: actor.id,
                        actorRole: actor.role,
                    },
                },
            },
        });
        await tx.order.update({
            where: { id: order.id },
            data: kind === client_1.CashCollectionKind.cod
                ? { codPaidStatus: nextPaidStatus }
                : { serviceChargePaidStatus: nextPaidStatus },
        });
    });
    return (0, repo_1.getOrderById)(orderId);
}
async function handoffOrderCash(params) {
    const { orderId, kind, actor, toHolderType } = params;
    await prismaClient_1.default.$transaction(async (tx) => {
        const order = await loadOrderContext(tx, orderId);
        const collection = await loadCollection(tx, orderId, kind);
        assertActorCanAccessOrder(order, actor);
        assertCollectionMutable(collection);
        if (collection.status !== client_1.CashCollectionStatus.held) {
            throw (0, orderService_shared_1.orderError)("Only held cash can be handed off", 400);
        }
        if (actor.role === client_1.AppRole.driver) {
            if (collection.currentHolderType !== client_1.CashHolderType.driver ||
                collection.currentHolderUserId !== actor.id) {
                throw (0, orderService_shared_1.orderError)("Driver can only hand off cash currently held by them", 403);
            }
        }
        if (actor.role === client_1.AppRole.warehouse) {
            if (!actor.warehouseId ||
                collection.currentHolderWarehouseId !== actor.warehouseId) {
                throw (0, orderService_shared_1.orderError)("Warehouse can only hand off cash currently held at their location", 403);
            }
        }
        let nextHolderType = client_1.CashHolderType.none;
        let nextHolderUserId = null;
        let nextHolderWarehouseId = null;
        let nextHolderLabel = null;
        if (toHolderType === "driver") {
            if (!params.toDriverId) {
                throw (0, orderService_shared_1.orderError)("toDriverId is required when handing off to a driver", 400);
            }
            const driver = await resolveDriver(tx, params.toDriverId);
            nextHolderType = client_1.CashHolderType.driver;
            nextHolderUserId = driver.id;
            nextHolderLabel = driver.name ?? "Driver";
        }
        else {
            const warehouseId = params.toWarehouseId ??
                (actor.role === client_1.AppRole.warehouse ? actor.warehouseId ?? null : null);
            if (!warehouseId) {
                throw (0, orderService_shared_1.orderError)("toWarehouseId is required when handing off to a location", 400);
            }
            const warehouse = await tx.warehouse.findUnique({
                where: { id: warehouseId },
                select: { id: true, name: true, type: true },
            });
            if (!warehouse) {
                throw (0, orderService_shared_1.orderError)("Target warehouse not found", 404);
            }
            const actualHolderType = warehouseToHolderType(warehouse.type);
            nextHolderType = actualHolderType;
            nextHolderWarehouseId = warehouse.id;
            nextHolderLabel = warehouse.name;
        }
        await tx.cashCollection.update({
            where: { id: collection.id },
            data: {
                status: client_1.CashCollectionStatus.held,
                currentHolderType: nextHolderType,
                currentHolderUserId: nextHolderUserId,
                currentHolderWarehouseId: nextHolderWarehouseId,
                currentHolderLabel: nextHolderLabel,
                note: params.note ?? collection.note ?? null,
                events: {
                    create: {
                        eventType: client_1.CashCollectionEventType.handoff,
                        amount: collection.collectedAmount ?? collection.expectedAmount,
                        note: params.note ?? null,
                        fromHolderType: collection.currentHolderType,
                        fromHolderId: collection.currentHolderUserId ??
                            collection.currentHolderWarehouseId ??
                            null,
                        fromHolderName: eventHolderName(collection.currentHolderType, collection.currentHolderLabel),
                        toHolderType: nextHolderType,
                        toHolderId: nextHolderUserId ?? nextHolderWarehouseId,
                        toHolderName: nextHolderLabel,
                        actorId: actor.id,
                        actorRole: actor.role,
                    },
                },
            },
        });
    });
    return (0, repo_1.getOrderById)(orderId);
}
async function settleOrderCash(params) {
    const { orderId, kind, actor } = params;
    if (actor.role !== client_1.AppRole.manager) {
        throw (0, orderService_shared_1.orderError)("Only managers can settle cash to finance", 403);
    }
    await prismaClient_1.default.$transaction(async (tx) => {
        const order = await loadOrderContext(tx, orderId);
        const collection = await loadCollection(tx, orderId, kind);
        assertActorCanAccessOrder(order, actor);
        assertCollectionMutable(collection);
        if (collection.status !== client_1.CashCollectionStatus.held) {
            throw (0, orderService_shared_1.orderError)("Only held cash can be settled", 400);
        }
        await tx.cashCollection.update({
            where: { id: collection.id },
            data: {
                status: client_1.CashCollectionStatus.settled,
                currentHolderType: client_1.CashHolderType.finance,
                currentHolderUserId: null,
                currentHolderWarehouseId: null,
                currentHolderLabel: "Finance",
                settledAt: new Date(),
                note: params.note ?? collection.note ?? null,
                events: {
                    create: {
                        eventType: client_1.CashCollectionEventType.settled,
                        amount: collection.collectedAmount ?? collection.expectedAmount,
                        note: params.note ?? null,
                        fromHolderType: collection.currentHolderType,
                        fromHolderId: collection.currentHolderUserId ??
                            collection.currentHolderWarehouseId ??
                            null,
                        fromHolderName: eventHolderName(collection.currentHolderType, collection.currentHolderLabel),
                        toHolderType: client_1.CashHolderType.finance,
                        toHolderName: "Finance",
                        actorId: actor.id,
                        actorRole: actor.role,
                    },
                },
            },
        });
    });
    return (0, repo_1.getOrderById)(orderId);
}
function normalizeQueuePaging(filters) {
    const page = Math.max(1, Number(filters?.page ?? 1) || 1);
    const pageSize = Math.min(Math.max(Number(filters?.pageSize ?? 20) || 20, 5), 100);
    const offset = (page - 1) * pageSize;
    return { page, pageSize, offset };
}
function normalizeQueueStatuses(filters) {
    const incoming = Array.isArray(filters?.statuses) ? filters?.statuses : [];
    const values = incoming.filter((status) => status === client_1.CashCollectionStatus.expected ||
        status === client_1.CashCollectionStatus.held ||
        status === client_1.CashCollectionStatus.settled);
    if (values.length === 0) {
        return [client_1.CashCollectionStatus.expected, client_1.CashCollectionStatus.held];
    }
    return Array.from(new Set(values));
}
function normalizeQueueKinds(filters) {
    const incoming = Array.isArray(filters?.kinds) ? filters?.kinds : [];
    const values = incoming.filter((kind) => kind === client_1.CashCollectionKind.cod || kind === client_1.CashCollectionKind.service_charge);
    return Array.from(new Set(values));
}
function buildQueueWhere(actor, filters) {
    const statuses = normalizeQueueStatuses(filters);
    const kinds = normalizeQueueKinds(filters);
    const and = [
        { status: { in: statuses } },
    ];
    if (kinds.length > 0) {
        and.push({ kind: { in: kinds } });
    }
    if (filters?.from || filters?.to) {
        and.push({
            updatedAt: {
                ...(filters?.from ? { gte: filters.from } : {}),
                ...(filters?.to ? { lt: filters.to } : {}),
            },
        });
    }
    if (actor.role === client_1.AppRole.manager) {
        return and.length === 1 ? and[0] : { AND: and };
    }
    if (actor.role === client_1.AppRole.warehouse) {
        if (!actor.warehouseId) {
            throw (0, orderService_shared_1.orderError)("Warehouse user has no attached location", 403);
        }
        and.push({
            OR: [
                { order: { currentWarehouseId: actor.warehouseId } },
                { currentHolderWarehouseId: actor.warehouseId },
            ],
        });
        return { AND: and };
    }
    throw (0, orderService_shared_1.orderError)("Forbidden", 403);
}
function buildQueueScopeSql(actor) {
    if (actor.role === client_1.AppRole.manager) {
        return client_1.Prisma.sql `1=1`;
    }
    if (actor.role === client_1.AppRole.warehouse) {
        if (!actor.warehouseId) {
            throw (0, orderService_shared_1.orderError)("Warehouse user has no attached location", 403);
        }
        return client_1.Prisma.sql `(o."currentWarehouseId" = ${actor.warehouseId} OR cc."currentHolderWarehouseId" = ${actor.warehouseId})`;
    }
    throw (0, orderService_shared_1.orderError)("Forbidden", 403);
}
async function listCashQueueForActor(params) {
    const { actor, filters } = params;
    const where = buildQueueWhere(actor, filters);
    const { page, pageSize, offset } = normalizeQueuePaging(filters);
    const [total, rows] = await prismaClient_1.default.$transaction([
        prismaClient_1.default.cashCollection.count({ where }),
        prismaClient_1.default.cashCollection.findMany({
            where,
            orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }, { id: "desc" }],
            skip: offset,
            take: pageSize,
            include: {
                order: {
                    select: {
                        id: true,
                        orderNumber: true,
                        status: true,
                        currentWarehouseId: true,
                        pickupAddress: true,
                        dropoffAddress: true,
                        assignedDriverId: true,
                    },
                },
                currentHolderUser: {
                    select: { id: true, name: true, email: true, role: true },
                },
                currentHolderWarehouse: {
                    select: { id: true, name: true, type: true, location: true, region: true },
                },
            },
        }),
    ]);
    const pageCount = Math.max(1, Math.ceil(total / pageSize));
    const nowMs = Date.now();
    const items = rows.map((row) => {
        const amount = Number(row.collectedAmount ?? row.expectedAmount ?? 0);
        const updatedAt = row.updatedAt.toISOString();
        const ageHours = Math.max(0, Math.round((nowMs - new Date(updatedAt).getTime()) / (1000 * 60 * 60)));
        return {
            id: row.id,
            orderId: row.orderId,
            orderNumber: row.order?.orderNumber ?? null,
            orderStatus: row.order?.status ?? null,
            orderPickupAddress: row.order?.pickupAddress ?? null,
            orderDropoffAddress: row.order?.dropoffAddress ?? null,
            kind: row.kind,
            status: row.status,
            expectedAmount: Number(row.expectedAmount ?? 0),
            collectedAmount: row.collectedAmount == null ? null : Number(row.collectedAmount),
            amount,
            currency: row.currency ?? null,
            currentHolderType: row.currentHolderType,
            currentHolderLabel: row.currentHolderLabel ?? null,
            currentHolderUser: row.currentHolderUser
                ? {
                    id: row.currentHolderUser.id,
                    name: row.currentHolderUser.name,
                    email: row.currentHolderUser.email,
                    role: row.currentHolderUser.role,
                }
                : null,
            currentHolderWarehouse: row.currentHolderWarehouse
                ? {
                    id: row.currentHolderWarehouse.id,
                    name: row.currentHolderWarehouse.name,
                    type: row.currentHolderWarehouse.type,
                    location: row.currentHolderWarehouse.location,
                    region: row.currentHolderWarehouse.region,
                }
                : null,
            updatedAt,
            ageHours,
            canCollect: row.status === client_1.CashCollectionStatus.expected &&
                (actor.role === client_1.AppRole.manager || actor.role === client_1.AppRole.warehouse),
            canHandoff: row.status === client_1.CashCollectionStatus.held &&
                (actor.role === client_1.AppRole.manager || actor.role === client_1.AppRole.warehouse),
            canSettle: row.status === client_1.CashCollectionStatus.held && actor.role === client_1.AppRole.manager,
        };
    });
    return {
        items,
        meta: {
            page: Math.min(page, pageCount),
            pageSize,
            total,
            pageCount,
            hasPrev: page > 1,
            hasNext: page < pageCount,
        },
    };
}
async function getCashQueueSummaryForActor(params) {
    const { actor, filters } = params;
    const statuses = normalizeQueueStatuses(filters);
    const kinds = normalizeQueueKinds(filters);
    const scopeSql = buildQueueScopeSql(actor);
    const whereParts = [
        scopeSql,
        client_1.Prisma.sql `cc.status::text IN (${client_1.Prisma.join(statuses.map((s) => String(s)))})`,
    ];
    if (kinds.length > 0) {
        whereParts.push(client_1.Prisma.sql `cc.kind::text IN (${client_1.Prisma.join(kinds.map((k) => String(k)))})`);
    }
    if (filters?.from) {
        whereParts.push(client_1.Prisma.sql `cc."updatedAt" >= ${filters.from}`);
    }
    if (filters?.to) {
        whereParts.push(client_1.Prisma.sql `cc."updatedAt" < ${filters.to}`);
    }
    const rows = await prismaClient_1.default.$queryRaw(client_1.Prisma.sql `
      SELECT
        COUNT(*) FILTER (WHERE cc.status = 'expected')::bigint AS "expectedCount",
        COALESCE(SUM(CASE WHEN cc.status = 'expected' THEN COALESCE(cc."collectedAmount", cc."expectedAmount") ELSE 0 END), 0)::double precision AS "expectedAmount",
        COUNT(*) FILTER (WHERE cc.status = 'held')::bigint AS "heldCount",
        COALESCE(SUM(CASE WHEN cc.status = 'held' THEN COALESCE(cc."collectedAmount", cc."expectedAmount") ELSE 0 END), 0)::double precision AS "heldAmount",
        COUNT(*) FILTER (WHERE cc.status = 'settled')::bigint AS "settledCount",
        COALESCE(SUM(CASE WHEN cc.status = 'settled' THEN COALESCE(cc."collectedAmount", cc."expectedAmount") ELSE 0 END), 0)::double precision AS "settledAmount",
        COUNT(*)::bigint AS "totalCount",
        COALESCE(SUM(COALESCE(cc."collectedAmount", cc."expectedAmount")), 0)::double precision AS "totalAmount"
      FROM "CashCollection" cc
      INNER JOIN "Order" o ON o.id = cc."orderId"
      WHERE ${client_1.Prisma.join(whereParts, " AND ")}
    `);
    const summary = rows[0] ?? {
        expectedCount: BigInt(0),
        expectedAmount: 0,
        heldCount: BigInt(0),
        heldAmount: 0,
        settledCount: BigInt(0),
        settledAmount: 0,
        totalCount: BigInt(0),
        totalAmount: 0,
    };
    return {
        expectedCount: Number(summary.expectedCount ?? 0),
        expectedAmount: Number(summary.expectedAmount ?? 0),
        heldCount: Number(summary.heldCount ?? 0),
        heldAmount: Number(summary.heldAmount ?? 0),
        settledCount: Number(summary.settledCount ?? 0),
        settledAmount: Number(summary.settledAmount ?? 0),
        totalCount: Number(summary.totalCount ?? 0),
        totalAmount: Number(summary.totalAmount ?? 0),
    };
}
