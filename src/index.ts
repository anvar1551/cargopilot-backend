import "dotenv/config";
import express from "express";
import cors from "cors";
import compression from "compression";
import helmet from "helmet";
import morgan from "morgan";
import rateLimit from "express-rate-limit";
import { auth } from "./middleware/auth";
import { createRateLimitStore } from "./config/rateLimitStore";
import { getRedisClient } from "./config/redis";
import prisma from "./config/prismaClient";
import userRoutes from "./services/users/userRoutes";
import orderRoutes from "./services/orders/orderRoutes";
import trackingRoutes from "./services/tracking/trackingRoutes";
import warehouseRoutes from "./services/warehouse/warehouseRoutes";
import driverRoutes from "./services/driver/driverRoutes";
import invoiceRoutes from "./services/invoice/invoiceRoutes";
import webhookRoutes from "./services/stripe/webhookRoutes";
import managerRoutes from "./features/manager/managerRoutes";
import labelRoutes from "./features/label/labelRoutes";
import addressRoutes from "./services/addresses/addressRoutes";
import customerEntityRoutes from "./services/customers/customerRoutes";
import pricingRoutes from "./services/pricing/pricingRoutes";

const app = express();
app.set("trust proxy", process.env.TRUST_PROXY === "false" ? false : 1);
void getRedisClient();

// Stripe webhook must come before JSON body parsing middleware.
app.use("/api/webhooks", webhookRoutes);

const allowedOrigins = new Set(
  [
    process.env.CLIENT_URL,
    ...(process.env.CORS_ORIGINS || "")
      .split(",")
      .map((value) => value.trim()),
    ...(process.env.ADDITIONAL_ALLOWED_ORIGINS || "")
      .split(",")
      .map((value) => value.trim()),
  ].filter((value): value is string => Boolean(value)),
);

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      if (allowedOrigins.size === 0) return callback(null, true);
      if (allowedOrigins.has(origin)) return callback(null, true);
      return callback(new Error("Origin not allowed by CORS"));
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  }),
);
app.use(
  helmet({
    crossOriginResourcePolicy: false,
  }),
);
app.use(compression({ threshold: 1024 }));
app.use(express.json({ limit: process.env.JSON_BODY_LIMIT || "5mb" }));
app.use(
  morgan("dev", {
    skip: (req) => req.path === "/api/health",
  }),
);

const globalLimiter = rateLimit({
  windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS || 15 * 60 * 1000),
  max: Number(process.env.RATE_LIMIT_MAX || 1200),
  store: createRateLimitStore("global"),
  standardHeaders: true,
  legacyHeaders: false,
  passOnStoreError: true,
});

const authLimiter = rateLimit({
  windowMs: Number(process.env.AUTH_RATE_LIMIT_WINDOW_MS || 15 * 60 * 1000),
  max: Number(process.env.AUTH_RATE_LIMIT_MAX || 120),
  store: createRateLimitStore("auth"),
  standardHeaders: true,
  legacyHeaders: false,
  passOnStoreError: true,
});

app.use(globalLimiter);

app.get("/api/health", async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ status: "ok" });
  } catch (err: any) {
    res.status(500).json({ status: "error", error: err?.message });
  }
});

app.use("/api/auth", authLimiter, userRoutes);
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
app.use("/api/addresses", addressRoutes);
app.use("/api/customers", customerEntityRoutes);
app.use("/api/pricing", pricingRoutes);

app.use((err: any, _req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (err?.message === "Origin not allowed by CORS") {
    return res.status(403).json({ error: "CORS origin blocked" });
  }
  return next(err);
});

const portFromEnv = Number(process.env.PORT);
const PORT =
  Number.isFinite(portFromEnv) && portFromEnv > 0 ? portFromEnv : 4000;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});
