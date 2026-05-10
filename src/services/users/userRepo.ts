import prisma from "../../config/prismaClient";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { AppRole, CustomerType, DriverType } from "@prisma/client";
import { Prisma } from "@prisma/client";
import { createHash, randomUUID } from "crypto";

function getJwtSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET not configured");
  return secret;
}

function getRefreshTokenSecret() {
  return process.env.REFRESH_TOKEN_SECRET || getJwtSecret();
}

function getAccessTokenTtl() {
  return process.env.ACCESS_TOKEN_TTL || "12h";
}

function getRefreshTokenTtl() {
  return process.env.REFRESH_TOKEN_TTL || "30d";
}

function signToken(payload: {
  id: string;
  role: AppRole;
  email?: string | null;
  name?: string | null;
  warehouseId?: string | null;
  customerEntityId?: string | null;
}) {
  return jwt.sign(
    {
      ...payload,
      tokenType: "access",
    },
    getJwtSecret(),
    { expiresIn: getAccessTokenTtl() as jwt.SignOptions["expiresIn"] },
  );
}

type RefreshTokenPayload = {
  id: string;
  sid: string;
  tokenType: "refresh";
};

function signRefreshToken(payload: RefreshTokenPayload) {
  return jwt.sign(payload, getRefreshTokenSecret(), {
    expiresIn: getRefreshTokenTtl() as jwt.SignOptions["expiresIn"],
  });
}

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function getTokenExpiryDate(token: string) {
  const decoded = jwt.decode(token) as { exp?: number } | null;
  if (!decoded?.exp) {
    throw new Error("Unable to read token expiry");
  }
  return new Date(decoded.exp * 1000);
}

function getTokenLifetimeSec(token: string) {
  const decoded = jwt.decode(token) as { iat?: number; exp?: number } | null;
  if (!decoded?.exp || !decoded?.iat) return 0;
  const ttl = decoded.exp - decoded.iat;
  return ttl > 0 ? ttl : 0;
}

function safeUser(user: any) {
  const { password, ...rest } = user;

  return {
    ...rest,
    warehouseId: rest.warehouseId ?? rest.warehouse?.id ?? null,
    customerEntityId: rest.customerEntityId ?? rest.customerEntity?.id ?? null,
    driverType:
      rest.role === AppRole.driver
        ? (rest.driverType ?? DriverType.local)
        : null,
  };
}

async function createRefreshSession(args: {
  userId: string;
  userAgent?: string | null;
  ipAddress?: string | null;
}) {
  const sessionId = randomUUID();
  const refreshToken = signRefreshToken({
    id: args.userId,
    sid: sessionId,
    tokenType: "refresh",
  });

  await prisma.userRefreshSession.create({
    data: {
      id: sessionId,
      userId: args.userId,
      tokenHash: hashToken(refreshToken),
      expiresAt: getTokenExpiryDate(refreshToken),
      userAgent: args.userAgent ?? null,
      ipAddress: args.ipAddress ?? null,
    },
  });

  return refreshToken;
}

async function issueAuthSession(args: {
  user: {
    id: string;
    role: AppRole;
    email: string;
    name: string;
    warehouse?: { id: string } | null;
    customerEntity?: { id: string } | null;
  };
  userAgent?: string | null;
  ipAddress?: string | null;
}) {
  const token = signToken({
    id: args.user.id,
    role: args.user.role,
    email: args.user.email,
    name: args.user.name,
    warehouseId: args.user.warehouse?.id ?? null,
    customerEntityId: args.user.customerEntity?.id ?? null,
  });

  const refreshToken = await createRefreshSession({
    userId: args.user.id,
    userAgent: args.userAgent ?? null,
    ipAddress: args.ipAddress ?? null,
  });

  return {
    token,
    refreshToken,
    accessTokenExpiresInSec: getTokenLifetimeSec(token),
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
  userAgent?: string | null;
  ipAddress?: string | null;
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

  const session = await issueAuthSession({
    user,
    userAgent: args.userAgent ?? null,
    ipAddress: args.ipAddress ?? null,
  });

  return { ...session, user: safeUser(user) };
};

export const loginUser = async (
  emailRaw: string,
  password: string,
  meta?: {
    userAgent?: string | null;
    ipAddress?: string | null;
  },
) => {
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

  const session = await issueAuthSession({
    user,
    userAgent: meta?.userAgent ?? null,
    ipAddress: meta?.ipAddress ?? null,
  });

  return { ...session, user: safeUser(user) };
};

export const refreshUserSession = async (args: {
  refreshToken: string;
  userAgent?: string | null;
  ipAddress?: string | null;
}) => {
  const rawToken = String(args.refreshToken ?? "").trim();
  if (!rawToken) throw new Error("Refresh token is required");

  let decoded: RefreshTokenPayload;
  try {
    decoded = jwt.verify(rawToken, getRefreshTokenSecret()) as RefreshTokenPayload;
  } catch {
    throw new Error("Invalid refresh token");
  }

  if (!decoded?.id || !decoded?.sid) {
    throw new Error("Invalid refresh token");
  }

  if (decoded.tokenType && decoded.tokenType !== "refresh") {
    throw new Error("Invalid refresh token type");
  }

  const now = new Date();
  const tokenHash = hashToken(rawToken);

  const currentSession = await prisma.userRefreshSession.findUnique({
    where: { id: decoded.sid },
    include: {
      user: {
        include: {
          warehouse: true,
          customerEntity: true,
        },
      },
    },
  });

  if (!currentSession || currentSession.userId !== decoded.id) {
    throw new Error("Invalid refresh token");
  }

  if (currentSession.revokedAt) {
    throw new Error("Refresh token revoked");
  }

  if (currentSession.expiresAt <= now) {
    throw new Error("Refresh token expired");
  }

  if (currentSession.tokenHash !== tokenHash) {
    throw new Error("Refresh token mismatch");
  }

  const nextSessionId = randomUUID();
  const nextRefreshToken = signRefreshToken({
    id: currentSession.user.id,
    sid: nextSessionId,
    tokenType: "refresh",
  });

  const nextRefreshHash = hashToken(nextRefreshToken);
  const nextRefreshExpiresAt = getTokenExpiryDate(nextRefreshToken);

  await prisma.$transaction(async (tx) => {
    await tx.userRefreshSession.update({
      where: { id: currentSession.id },
      data: {
        revokedAt: now,
        replacedBySessionId: nextSessionId,
      },
    });

    await tx.userRefreshSession.create({
      data: {
        id: nextSessionId,
        userId: currentSession.user.id,
        tokenHash: nextRefreshHash,
        expiresAt: nextRefreshExpiresAt,
        userAgent: args.userAgent ?? currentSession.userAgent ?? null,
        ipAddress: args.ipAddress ?? currentSession.ipAddress ?? null,
      },
    });

    await tx.userRefreshSession.deleteMany({
      where: {
        userId: currentSession.user.id,
        OR: [{ expiresAt: { lt: now } }, { revokedAt: { not: null } }],
      },
    });
  });

  const token = signToken({
    id: currentSession.user.id,
    role: currentSession.user.role,
    email: currentSession.user.email,
    name: currentSession.user.name,
    warehouseId: currentSession.user.warehouse?.id ?? null,
    customerEntityId: currentSession.user.customerEntity?.id ?? null,
  });

  return {
    token,
    refreshToken: nextRefreshToken,
    accessTokenExpiresInSec: getTokenLifetimeSec(token),
    user: safeUser(currentSession.user),
  };
};

export const revokeRefreshSession = async (refreshTokenRaw: string) => {
  const token = String(refreshTokenRaw ?? "").trim();
  if (!token) return;

  let decoded: RefreshTokenPayload;
  try {
    decoded = jwt.verify(token, getRefreshTokenSecret()) as RefreshTokenPayload;
  } catch {
    return;
  }

  if (!decoded?.sid) return;

  await prisma.userRefreshSession.updateMany({
    where: {
      id: decoded.sid,
      revokedAt: null,
    },
    data: {
      revokedAt: new Date(),
    },
  });
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
  driverType?: "local" | "linehaul";

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
      ...(args.role === AppRole.driver
        ? {
            driverType:
              args.driverType === "linehaul"
                ? DriverType.linehaul
                : DriverType.local,
          }
        : {}),
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
