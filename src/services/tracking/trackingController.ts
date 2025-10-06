import { getTrackingForOrder } from "./trackingRepo";

export function getOrderTracking(req: any, res: any) {
  try {
    const { orderId } = req.params;
    if (!orderId) return res.status(400).json({ error: "Missing order ID" });

    const tracking = getTrackingForOrder(orderId);
    res.json({ orderId, events: tracking });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
}
