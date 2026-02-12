import prisma from "../../config/prismaClient";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { AppRole, CustomerType } from "@prisma/client";

const JWT_SECRET = process.env.JWT_SECRET || "supersecret";

function signToken(payload: {
  id: string;
  role: AppRole;
  warehouseId?: string | null;
  customerEntityId?: string | null;
}) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: "7d" });
}

function safeUser(user: any) {
  // never return password hash
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { password, ...rest } = user;
  return rest;
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
    warehouseId: user.warehouseId ?? null,
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
    warehouseId: user.warehouseId ?? null,
    customerEntityId: user.customerEntity?.id ?? null,
  });

  return { token, user: safeUser(user) };
};
