import "dotenv/config";
import express from "express";
import cors from "cors";
import morgan from "morgan";
import { getConnection } from "./config/db";
import userRoutes from "./services/users/userRoutes";
import orderRoutes from "./services/orders/orderRoutes";
import trackingRoutes from "./services/tracking/trackingRoutes";
import warehouseRoutes from "./services/warehouse/warehouseRoutes";
import driverRoutes from "./services/driver/driverRoutes";
import invoiceRoutes from "./services/invoice/invoiceRoutes";
import analyticsRoutes from "./services/analytics/analyticsRoutes";
import webhookRoutes from "./services/stripe/webhookRoutes";
import { auth } from "./middleware/auth";
import managerRoutes from "./features/manager/managerRoutes";
import labelRoutes from "./features/label/labelRoutes";

const app = express();

// ⚠️ Stripe webhook must come BEFORE JSON parsing middleware
app.use("/api/webhooks", webhookRoutes);

app.use(cors());
app.use(express.json());
app.use(morgan("dev"));

app.get("/api/health", (req, res) => {
  try {
    const conn = getConnection();
    const ressult = conn.exec("SELECT CURRENT_USER, CURRENT_SCHEMA FROM DUMMY");
    conn.disconnect();
    res.json({ status: "ok", db: ressult });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.use("/api/auth", userRoutes);
app.get("/api/protected", auth(["manager", "customer"]), (req, res) => {
  res.json({ msg: "You are allowed here", user: req.user });
});
app.use("/api/orders", orderRoutes);
app.use("/api/tracking", trackingRoutes);
app.use("/api/warehouses", warehouseRoutes);
app.use("/api/drivers", driverRoutes);
app.use("/api/invoices", invoiceRoutes);
app.use("/api/manager", managerRoutes);
app.use("/api/labels", labelRoutes);

const PORT = process.env.PORT || 4000;
app.listen(4000, "0.0.0.0", () =>
  console.log(`🚀 Server running on port ${PORT}`),
);
