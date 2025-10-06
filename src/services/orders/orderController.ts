import { getConnection } from "../../config/db";
import { addTracking } from "../tracking/trackingRepo";
import {
  assignDriver,
  createOrder,
  getOrderById,
  listOrdersForRole,
} from "./orderRepo";

export function create(req: any, res: any) {
  try {
    const { pickupAddress, dropoffAddress } = req.body;

    if (!req.user) return res.status(401).json({ error: "Unauthorized" });

    const order = createOrder(req.user.id, pickupAddress, dropoffAddress);
    res.json(order);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
}

export function list(req: any, res: any) {
  try {
    const { id, role } = req.user;
    const orders = listOrdersForRole(id, role);
    res.json(orders);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
}

export function getOne(req: any, res: any) {
  try {
    const order = getOrderById(req.params.id);
    if (!order) return res.status(404).json({ error: "Not found" });

    const { id: userId, role } = req.user;

    if (role === "manager" || role === "warehouse") return res.json(order);
    if (role === "customer" && order.CUSTOMER_ID === userId)
      return res.json(order);
    if (role === "driver" && order.ASSIGNED_DRIVER_ID === userId)
      return res.json(order);

    return res.status(403).json({ error: "Forbidden" });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
}

export function assign(req: any, res: any) {
  try {
    const { role } = req.user;
    if (role !== "manager")
      return res.status(403).json({ error: "Only manager can assign drivers" });

    const { driverId } = req.body;
    if (!driverId) return res.status(400).json({ error: "Missing driverId" });

    const orderId = req.params.id;
    const order = getOrderById(orderId);
    if (!order) return res.status(404).json({ error: "Order not found" });

    assignDriver(orderId, driverId);

    res.json({ success: true, message: "Driver assigned successfully" });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
}

export function updateStatus(req: any, res: any) {
  try {
    const { id: userId, role } = req.user;
    const orderId = req.params.id;
    const { status, region, warehouseId, description } = req.body;

    const order = getOrderById(orderId);
    if (!order) return res.status(404).json({ error: "Order not found" });

    // Only driver or warehouse can change status
    if (role !== "driver" && role !== "warehouse")
      return res.status(403).json({ error: "Not allowed" });

    const conn = getConnection();
    const stmt = conn.prepare(`UPDATE ORDERS SET STATUS = ? WHERE ID = ?`);
    stmt.exec([status, orderId]);
    stmt.drop();
    conn.disconnect();

    // log tracking event
    const tracking = addTracking(
      orderId,
      status,
      region,
      warehouseId,
      description
    );

    res.json({ success: true, tracking });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
}
