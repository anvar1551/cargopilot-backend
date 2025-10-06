import { createWarehouse, listWarehouses } from "./warehouseRepo";

export function create(req: any, res: any) {
  try {
    const { role } = req.user;
    if (role !== "manager")
      return res
        .status(403)
        .json({ error: "Only manager can create warehouses" });

    const { name, location } = req.body;
    if (!name || !location)
      return res.status(400).json({ error: "Missing name or location" });

    const warehouse = createWarehouse(name, location);
    res.json({ success: true, warehouse });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
}

export function list(req: any, res: any) {
  try {
    const warehouses = listWarehouses();
    res.json(warehouses);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
}
