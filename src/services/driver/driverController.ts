import { Request, Response } from "express";
import { assignDriverToOrder, listAllDrivers } from "./driverRepo";

export const assignDriver = async (req: Request, res: Response) => {
  try {
    const { orderId, driverId } = req.body;

    if (!orderId || !driverId)
      return res
        .status(400)
        .json({ error: "OrderId and DriverId are required" });

    const order = await assignDriverToOrder(orderId, driverId);
    res.status(200).json({ message: "driver assigned successfully", order });
  } catch (error) {
    res.status(500).json({ error: "Failed to assign driver" });
  }
};

export const listDrivers = async (req: Request, res: Response) => {
  try {
    const drivers = await listAllDrivers();
    res.json(drivers);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to fetch drivers" });
  }
};
