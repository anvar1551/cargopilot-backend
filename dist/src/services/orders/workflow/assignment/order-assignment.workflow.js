"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.assignOrdersToDriver = assignOrdersToDriver;
exports.dispatchOrdersByCycle = dispatchOrdersByCycle;
const prismaClient_1 = __importDefault(require("../../../../config/prismaClient"));
const client_1 = require("@prisma/client");
const orderService_shared_1 = require("../../orderService.shared");
const order_status_workflow_1 = require("../status/order-status.workflow");
// ---------- 5) Assign driver workflow ----------
const ORDER_BULK_SUMMARY_SELECT = {
    id: true,
    orderNumber: true,
    status: true,
    assignedDriverId: true,
    currentWarehouseId: true,
    updatedAt: true,
};
async function loadOrdersForResponse(orderIds, includeFull) {
    if (includeFull) {
        return prismaClient_1.default.order.findMany({
            where: { id: { in: orderIds } },
            include: {
                customer: true,
                assignedDriver: true,
                currentWarehouse: true,
                parcels: true,
                trackingEvents: {
                    include: { actor: true, warehouse: true, parcel: true },
                    orderBy: { timestamp: "asc" },
                },
                invoice: true,
            },
            orderBy: { createdAt: "desc" },
        });
    }
    return prismaClient_1.default.order.findMany({
        where: { id: { in: orderIds } },
        select: ORDER_BULK_SUMMARY_SELECT,
        orderBy: { createdAt: "desc" },
    });
}
function normalizeCycle(cycle) {
    if (cycle === "pickup" || cycle === "delivery" || cycle === "linehaul") {
        return cycle;
    }
    return "pickup";
}
function assertDispatchRole(actor) {
    if (!actor)
        return;
    if (actor.role !== client_1.AppRole.manager && actor.role !== client_1.AppRole.warehouse) {
        throw (0, orderService_shared_1.orderError)("Only manager or warehouse can assign/dispatch drivers", 403);
    }
}
/** Assigns one or many orders to a driver in a selected dispatch cycle. */
async function assignOrdersToDriver(args) {
    const { orderIds, driverId, actor, includeFull } = args;
    const cycle = normalizeCycle(args.cycle);
    assertDispatchRole(actor);
    if (!Array.isArray(orderIds) || orderIds.length === 0)
        throw (0, orderService_shared_1.orderError)("orderIds must be a non-empty array", 400);
    const driver = await prismaClient_1.default.user.findUnique({
        where: { id: driverId },
        select: { id: true, role: true },
    });
    if (!driver || driver.role !== client_1.AppRole.driver)
        throw (0, orderService_shared_1.orderError)("Driver not found or invalid role", 400);
    const orders = await prismaClient_1.default.order.findMany({
        where: { id: { in: orderIds } },
        select: { id: true, status: true, currentWarehouseId: true },
    });
    if (orders.length !== orderIds.length)
        throw (0, orderService_shared_1.orderError)("Some orders were not found", 400);
    if (actor?.role === client_1.AppRole.warehouse) {
        if (!actor.warehouseId) {
            throw (0, orderService_shared_1.orderError)("Warehouse user has no warehouse assigned", 403);
        }
        const wrong = orders.filter((o) => o.currentWarehouseId && o.currentWarehouseId !== actor.warehouseId);
        if (wrong.length) {
            throw (0, orderService_shared_1.orderError)(`Orders not in your warehouse: ${wrong.map((x) => x.id).join(", ")}`, 403);
        }
    }
    const assignableStatuses = order_status_workflow_1.ASSIGNABLE_BY_CYCLE[cycle];
    const blocked = orders.filter((o) => !assignableStatuses.includes(o.status));
    if (blocked.length) {
        throw (0, orderService_shared_1.orderError)(`Cannot assign driver in these states: ${blocked
            .map((x) => `${x.id}(${x.status})`)
            .join(", ")}`, 400);
    }
    await prismaClient_1.default.$transaction([
        prismaClient_1.default.order.updateMany({
            where: { id: { in: orderIds } },
            data: cycle === "pickup"
                ? { assignedDriverId: driverId, status: client_1.OrderStatus.assigned }
                : { assignedDriverId: driverId },
        }),
        prismaClient_1.default.tracking.createMany({
            data: orderIds.map((orderId) => ({
                orderId,
                action: client_1.TrackingAction.DRIVER_ASSIGNED,
                status: cycle === "pickup" ? client_1.OrderStatus.assigned : null,
                reasonCode: null,
                note: `Assigned to driver ${driverId} for ${cycle} cycle`,
                region: null,
                warehouseId: actor?.warehouseId ?? null,
                actorId: actor?.id ?? null,
                actorRole: actor?.role ?? null,
                parcelId: null,
            })),
        }),
    ]);
    return loadOrdersForResponse(orderIds, includeFull);
}
/** Performs dispatch for selected orders and writes tracking + status updates. */
async function dispatchOrdersByCycle(args) {
    const { orderIds, actor, warehouseId: providedWarehouseId, note, region, includeFull, } = args;
    const cycle = normalizeCycle(args.cycle);
    assertDispatchRole(actor);
    if (!Array.isArray(orderIds) || orderIds.length === 0)
        throw (0, orderService_shared_1.orderError)("orderIds must be a non-empty array", 400);
    const orders = await prismaClient_1.default.order.findMany({
        where: { id: { in: orderIds } },
        select: {
            id: true,
            status: true,
            assignedDriverId: true,
            currentWarehouseId: true,
        },
    });
    if (orders.length !== orderIds.length)
        throw (0, orderService_shared_1.orderError)("Some orders were not found", 400);
    const final = orders.filter((o) => order_status_workflow_1.FINAL_STATUSES.includes(o.status));
    if (final.length) {
        throw (0, orderService_shared_1.orderError)(`Cannot dispatch final orders: ${final
            .map((x) => `${x.id}(${x.status})`)
            .join(", ")}`, 400);
    }
    const noDriver = orders.filter((o) => !o.assignedDriverId);
    if (noDriver.length) {
        throw (0, orderService_shared_1.orderError)(`Driver is not assigned for: ${noDriver.map((x) => x.id).join(", ")}`, 400);
    }
    if (actor?.role === client_1.AppRole.warehouse) {
        if (!actor.warehouseId) {
            throw (0, orderService_shared_1.orderError)("Warehouse user has no warehouse assigned", 403);
        }
        const wrong = orders.filter((o) => o.currentWarehouseId && o.currentWarehouseId !== actor.warehouseId);
        if (wrong.length) {
            throw (0, orderService_shared_1.orderError)(`Orders not in your warehouse: ${wrong.map((x) => x.id).join(", ")}`, 403);
        }
    }
    const dispatchableStatuses = order_status_workflow_1.DISPATCHABLE_BY_CYCLE[cycle];
    const blocked = orders.filter((o) => !dispatchableStatuses.includes(o.status));
    if (blocked.length) {
        throw (0, orderService_shared_1.orderError)(`Cannot dispatch in these states: ${blocked
            .map((x) => `${x.id}(${x.status})`)
            .join(", ")}`, 400);
    }
    const nextStatus = cycle === "pickup"
        ? client_1.OrderStatus.pickup_in_progress
        : cycle === "delivery"
            ? client_1.OrderStatus.out_for_delivery
            : client_1.OrderStatus.in_transit;
    const action = cycle === "pickup"
        ? client_1.TrackingAction.PICKUP_STARTED
        : cycle === "delivery"
            ? client_1.TrackingAction.DELIVERY_STARTED
            : client_1.TrackingAction.DISPATCHED;
    const invalidTransitions = [];
    for (const o of orders) {
        if (o.status === nextStatus)
            continue;
        try {
            (0, order_status_workflow_1.assertTransition)(o.status, nextStatus);
        }
        catch {
            invalidTransitions.push(`${o.id}(${o.status} -> ${nextStatus})`);
        }
    }
    if (invalidTransitions.length) {
        throw (0, orderService_shared_1.orderError)(`Dispatch blocked: ${invalidTransitions.join(", ")}`, 400);
    }
    const effectiveWarehouseId = actor?.role === client_1.AppRole.warehouse
        ? actor.warehouseId ?? null
        : providedWarehouseId ?? null;
    await prismaClient_1.default.$transaction([
        prismaClient_1.default.order.updateMany({
            where: { id: { in: orderIds } },
            data: {
                status: nextStatus,
                ...(effectiveWarehouseId ? { currentWarehouseId: effectiveWarehouseId } : {}),
            },
        }),
        prismaClient_1.default.tracking.createMany({
            data: orderIds.map((orderId) => ({
                orderId,
                action,
                status: nextStatus,
                reasonCode: null,
                note: note ?? `Dispatched for ${cycle} cycle`,
                region: region ?? null,
                warehouseId: effectiveWarehouseId,
                actorId: actor?.id ?? null,
                actorRole: actor?.role ?? null,
                parcelId: null,
            })),
        }),
    ]);
    return loadOrdersForResponse(orderIds, includeFull);
}
