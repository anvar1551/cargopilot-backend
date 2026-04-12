import prisma from "../../config/prismaClient";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { AppRole, CustomerType } from "@prisma/client";
import { Prisma } from "@prisma/client";

function getJwtSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET not configured");
  return secret;
}

function signToken(payload: {
  id: string;
  role: AppRole;
  warehouseId?: string | null;
  customerEntityId?: string | null;
}) {
  return jwt.sign(payload, getJwtSecret(), { expiresIn: "7d" });
}

function safeUser(user: any) {
  const { password, ...rest } = user;

  return {
    ...rest,
    warehouseId: rest.warehouseId ?? rest.warehouse?.id ?? null,
    customerEntityId: rest.customerEntityId ?? rest.customerEntity?.id ?? null,
  };
}

export const registerUser = async (args: {
  name: string;
  email: string;
  password: string;
  role?: AppRole; // default customer
  // only for customer profile (optional now, but future proof)
  customerType?: CustomerType; // PERSON | COMPANY
  companyName?: string | null;
  phone?: string | null;
}) => {
  const name = args.name?.trim();
  const email = args.email?.trim().toLowerCase();
  const password = args.password;

  if (!name) throw new Error("Name is required");
  if (!email) throw new Error("Email is required");
  if (!password || password.length < 6)
    throw new Error("Password must be at least 6 characters");

  const role = args.role ?? AppRole.customer;

  // prevent duplicate
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) throw new Error("Email already registered");

  const hashedPassword = await bcrypt.hash(password, 10);

  // Create user (+ customer profile if role=customer)
  const user = await prisma.user.create({
    data: {
      name,
      email,
      password: hashedPassword,
      role,

      ...(role === AppRole.customer
        ? {
            customerEntity: {
              create: {
                type: args.customerType ?? CustomerType.PERSON,
                name:
                  (args.customerType ?? CustomerType.PERSON) ===
                  CustomerType.COMPANY
                    ? args.companyName?.trim() || name
                    : name,
                email,
                phone: args.phone ?? null,
              },
            },
          }
        : {}),
    },
    include: {
      warehouse: true,
      customerEntity: true,
    },
  });

  const token = signToken({
    id: user.id,
    role: user.role,
    warehouseId: user.warehouse?.id ?? null,
    customerEntityId: user.customerEntity?.id ?? null,
  });

  return { token, user: safeUser(user) };
};

export const loginUser = async (emailRaw: string, password: string) => {
  const email = emailRaw?.trim().toLowerCase();

  if (!email) throw new Error("Email is required");
  if (!password) throw new Error("Password is required");

  const user = await prisma.user.findUnique({
    where: { email },
    include: {
      warehouse: true,
      customerEntity: true,
    },
  });

  if (!user) throw new Error("Invalid email or password");

  const validPassword = await bcrypt.compare(password, user.password);
  if (!validPassword) throw new Error("Invalid email or password");

  const token = signToken({
    id: user.id,
    role: user.role,
    warehouseId: user.warehouse?.id ?? null,
    customerEntityId: user.customerEntity?.id ?? null,
  });

  return { token, user: safeUser(user) };
};

export const changeUserPassword = async (args: {
  userId: string;
  currentPassword: string;
  newPassword: string;
}) => {
  const userId = args.userId?.trim();
  const currentPassword = args.currentPassword;
  const newPassword = args.newPassword;

  if (!userId) throw new Error("User id is required");
  if (!currentPassword) throw new Error("Current password is required");
  if (!newPassword || newPassword.length < 6) {
    throw new Error("New password must be at least 6 characters");
  }
  if (currentPassword === newPassword) {
    throw new Error("New password must be different from current password");
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, password: true },
  });

  if (!user) throw new Error("User not found");

  const validPassword = await bcrypt.compare(currentPassword, user.password);
  if (!validPassword) throw new Error("Current password is incorrect");

  const hashedPassword = await bcrypt.hash(newPassword, 10);

  await prisma.user.update({
    where: { id: userId },
    data: { password: hashedPassword },
  });

  return { success: true };
};

export const createUserAsManager = async (args: {
  name: string;
  email: string;
  password: string;
  role: AppRole;

  // optional links
  warehouseId?: string | null;

  // for CUSTOMER only
  customerEntityId?: string | null; // link to existing (usually COMPANY)
  phone?: string | null; // optional for auto PERSON entity
}) => {
  const name = args.name?.trim();
  const email = args.email?.trim().toLowerCase();
  const password = args.password;

  if (!name) throw new Error("Name is required");
  if (!email) throw new Error("Email is required");
  if (!password || password.length < 6)
    throw new Error("Password must be at least 6 characters");
  if (!args.role) throw new Error("Role is required");

  // prevent duplicate
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) throw new Error("Email already registered");

  const hashedPassword = await bcrypt.hash(password, 10);

  return prisma.$transaction(async (tx) => {
    // ✅ only customers may have customerEntity
    const isCustomer = args.role === AppRole.customer;

    let customerEntityConnectId: string | null = isCustomer
      ? (args.customerEntityId ?? null)
      : null;

    // ✅ validate provided customerEntityId (if any)
    if (isCustomer && customerEntityConnectId) {
      const entity = await tx.customerEntity.findUnique({
        where: { id: customerEntityConnectId },
        select: { id: true, type: true },
      });

      if (!entity) {
        const e: any = new Error("customerEntityId not found");
        e.statusCode = 400;
        throw e;
      }

      // Optional strict rule (recommended): only link customers to COMPANY entities
      // If you want to allow linking to PERSON too, delete this block.
      if (entity.type !== CustomerType.COMPANY) {
        const e: any = new Error(
          "Only COMPANY customer entities can be linked",
        );
        e.statusCode = 400;
        throw e;
      }
    }

    // ✅ auto-create PERSON entity when customerEntityId missing
    if (isCustomer && !customerEntityConnectId) {
      const createdEntity = await tx.customerEntity.create({
        data: {
          type: CustomerType.PERSON,
          name,
          email,
          phone: args.phone ?? null,
        },
        select: { id: true },
      });

      customerEntityConnectId = createdEntity.id;
    }

    // ✅ validate warehouseId only when role=warehouse (optional but clean)
    if (
      (args.role === AppRole.warehouse || args.role === AppRole.driver) &&
      args.warehouseId
    ) {
      const wh = await tx.warehouse.findUnique({
        where: { id: args.warehouseId },
        select: { id: true },
      });
      if (!wh) {
        const e: any = new Error("warehouseId not found");
        e.statusCode = 400;
        throw e;
      }
    }

    const createData: any = {
      name,
      email,
      password: hashedPassword,
      role: args.role,
    };

    // ✅ attach warehouse ONLY when role=warehouse and warehouseId provided
    if (
      (args.role === AppRole.warehouse || args.role === AppRole.driver) &&
      args.warehouseId
    ) {
      createData.warehouse = { connect: { id: args.warehouseId } };
    }

    if (isCustomer && customerEntityConnectId) {
      createData.customerEntity = { connect: { id: customerEntityConnectId } };
    }

    const user = await tx.user.create({
      data: createData,
      include: {
        warehouse: true,
        customerEntity: true,
      },
    });

    return safeUser(user);
  });
};

export type ListUsersParams = {
  q?: string;
  role?: AppRole;
  page?: number;
  limit?: number;
};

export const listUsers = async (params?: ListUsersParams) => {
  const q = params?.q?.trim();
  const role = params?.role;
  const page = params?.page ?? 1;
  const limit = Math.min(params?.limit ?? 20, 100);
  const skip = (page - 1) * limit;

  const where: Prisma.UserWhereInput = {};

  if (role) {
    where.role = role;
  }

  if (q) {
    where.OR = [
      { name: { contains: q, mode: "insensitive" } },
      { email: { contains: q, mode: "insensitive" } },
    ];
  }

  const [rows, total] = await prisma.$transaction([
    prisma.user.findMany({
      where,
      include: {
        warehouse: true,
        customerEntity: true,
      },
      orderBy: { createdAt: "desc" },
      skip,
      take: limit,
    }),
    prisma.user.count({ where }),
  ]);

  return {
    data: rows.map((u) => {
      const { password, ...rest } = u;
      return rest;
    }),
    total,
    page,
    limit,
    pageCount: Math.ceil(total / limit),
  };
};

export const deleteUserAsManager = async (args: {
  targetUserId: string;
  actorUserId: string;
}) => {
  const targetUserId = args.targetUserId?.trim();
  const actorUserId = args.actorUserId?.trim();

  if (!targetUserId) throw new Error("User id is required");
  if (!actorUserId) throw new Error("Actor id is required");
  if (targetUserId === actorUserId) {
    throw new Error("You cannot delete your own account");
  }

  const user = await prisma.user.findUnique({
    where: { id: targetUserId },
    select: { id: true, email: true, role: true },
  });

  if (!user) throw new Error("User not found");

  const [customerOrders, driverOrders, invoices, trackingEvents] =
    await prisma.$transaction([
      prisma.order.count({ where: { customerId: targetUserId } }),
      prisma.order.count({ where: { assignedDriverId: targetUserId } }),
      prisma.invoice.count({ where: { customerId: targetUserId } }),
      prisma.tracking.count({ where: { actorId: targetUserId } }),
    ]);

  const references = customerOrders + driverOrders + invoices + trackingEvents;
  if (references > 0) {
    throw new Error(
      "User cannot be deleted because linked operational records already exist",
    );
  }

  await prisma.user.delete({
    where: { id: targetUserId },
  });

  return { success: true };
};
