import { Request, Response } from "express";
import { z } from "zod";
import { AppRole, CustomerType } from "@prisma/client";
import { registerUser, loginUser } from "./userRepo";
import { createUserAsManager } from "./userRepo";
import { listUsers } from "./userRepo";
import { changeUserPassword } from "./userRepo";
import { deleteUserAsManager } from "./userRepo";

function isDatabaseUnavailableError(err: any) {
  const code = String(err?.code ?? "").toUpperCase();
  const message = String(err?.message ?? "").toLowerCase();

  if (
    code === "ETIMEDOUT" ||
    code === "ECONNREFUSED" ||
    code === "EHOSTUNREACH" ||
    code === "ENETUNREACH" ||
    code === "P1001" ||
    code === "P1002"
  ) {
    return true;
  }

  return (
    message.includes("timed out") ||
    message.includes("can't reach database server") ||
    message.includes("cannot reach database server")
  );
}

export const listUsersController = async (req: Request, res: Response) => {
  try {
    const q = typeof req.query.q === "string" ? req.query.q : undefined;
    const role =
      typeof req.query.role === "string"
        ? (req.query.role as AppRole)
        : undefined;

    const page = req.query.page ? Number(req.query.page) : 1;
    const limit = req.query.limit ? Number(req.query.limit) : 20;

    const result = await listUsers({ q, role, page, limit });

    return res.json(result);
  } catch (err: any) {
    return res.status(400).json({ error: err?.message ?? "Failed" });
  }
};

export const register = async (req: Request, res: Response) => {
  try {
    const {
      name,
      email,
      password,
      role,

      // optional customer profile fields
      customerType,
      companyName,
      phone,
    } = req.body;

    // Public registration is customer-only.
    if (role && role !== AppRole.customer) {
      return res
        .status(403)
        .json({ error: "Public registration is customer-only" });
    }

    const parsedRole: AppRole = AppRole.customer;

    const parsedCustomerType: CustomerType | undefined =
      customerType && Object.values(CustomerType).includes(customerType)
        ? customerType
        : undefined;

    const result = await registerUser({
      name,
      email,
      password,
      role: parsedRole,
      customerType: parsedCustomerType,
      companyName: companyName ?? null,
      phone: phone ?? null,
    });

    return res.status(201).json(result);
  } catch (err: any) {
    console.error("register error:", err?.message || err);
    const msg = err?.message || "Registration failed";
    const code = msg.includes("JWT_SECRET not configured") ? 500 : 400;
    return res.status(code).json({ error: msg });
  }
};

export const login = async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body;

    const result = await loginUser(email, password);
    return res.json(result);
  } catch (err: any) {
    console.error("login error:", err?.message || err);

    if (isDatabaseUnavailableError(err)) {
      return res.status(503).json({
        error:
          "Database is temporarily unreachable. Please try another network or try again later.",
      });
    }

    // invalid login should be 401, not 500
    const msg = err?.message || "Login failed";
    const code = msg.includes("Invalid email or password")
      ? 401
      : msg.includes("JWT_SECRET not configured")
        ? 500
        : 400;

    return res.status(code).json({ error: msg });
  }
};

const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, "Current password is required"),
    newPassword: z.string().min(6, "New password must be at least 6 characters"),
  })
  .superRefine((value, ctx) => {
    if (value.currentPassword === value.newPassword) {
      ctx.addIssue({
        code: "custom",
        path: ["newPassword"],
        message: "New password must be different from current password",
      });
    }
  });

export const changePassword = async (req: Request, res: Response) => {
  try {
    if (!req.user?.id) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const dto = changePasswordSchema.parse(req.body);
    await changeUserPassword({
      userId: req.user.id,
      currentPassword: dto.currentPassword,
      newPassword: dto.newPassword,
    });

    return res.json({ message: "Password updated successfully" });
  } catch (err: any) {
    const message = err?.message ?? "Failed to update password";
    const status =
      message === "Unauthorized"
        ? 401
        : message === "Current password is incorrect"
          ? 400
          : err instanceof z.ZodError
            ? 400
            : 400;

    return res.status(status).json({ error: message });
  }
};

const createUserByManagerSchema = z
  .object({
    name: z.string().min(2),
    email: z.email(),
    password: z.string().min(6),
    role: z.enum(Object.values(AppRole) as [AppRole, ...AppRole[]]),
    warehouseId: z.uuid().optional().nullable(),
    customerEntityId: z.uuid().optional().nullable(),
    phone: z.string().optional().nullable(),
  })
  .superRefine((v, ctx) => {
    // ✅ warehouseId only allowed for warehouse role
    const supportsWarehouse =
      v.role === AppRole.warehouse || v.role === AppRole.driver;

    if (!supportsWarehouse && v.warehouseId) {
      ctx.addIssue({
        code: "custom",
        path: ["warehouseId"],
        message: "warehouseId is only allowed when role is WAREHOUSE or DRIVER",
      });
    }

    // ✅ require warehouseId when role=warehouse (recommended)
    if (v.role === AppRole.warehouse && !v.warehouseId) {
      ctx.addIssue({
        code: "custom",
        path: ["warehouseId"],
        message: "warehouseId is required when role is WAREHOUSE",
      });
    }

    // ✅ customerEntityId only meaningful for customers (optional strictness)
    if (v.role !== AppRole.customer && v.customerEntityId) {
      ctx.addIssue({
        code: "custom",
        path: ["customerEntityId"],
        message: "customerEntityId is only allowed when role is CUSTOMER",
      });
    }
  });

export const createByManager = async (req: Request, res: Response) => {
  try {
    const dto = createUserByManagerSchema.parse(req.body);

    const user = await createUserAsManager({
      name: dto.name,
      email: dto.email,
      password: dto.password,
      role: dto.role,
      warehouseId: dto.warehouseId ?? null,
      customerEntityId: dto.customerEntityId ?? null,
      phone: dto.phone ?? null,
    });

    return res.status(201).json({ user });
  } catch (err: any) {
    const code = err?.statusCode ?? 400;
    return res.status(code).json({ error: err?.message ?? "Bad request" });
  }
};

export const deleteByManager = async (req: Request, res: Response) => {
  try {
    if (!req.user?.id) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const userId = typeof req.params.id === "string" ? req.params.id : "";
    await deleteUserAsManager({
      targetUserId: userId,
      actorUserId: req.user.id,
    });

    return res.json({ message: "User deleted successfully" });
  } catch (err: any) {
    return res.status(400).json({
      error: err?.message ?? "Failed to delete user",
    });
  }
};
