import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import morgan from "morgan";
import { getConnection } from "./config/db";
import userRoutes from "./services/users/userRoutes";
import orderRoutes from "./services/orders/orderRoutes";
import trackingRoutes from "./services/tracking/trackingRoutes";
import warehouseRoutes from "./services/warehouse/warehouseRoutes";
import { auth } from "./middleware/auth";

dotenv.config();

const app = express();

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

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});
