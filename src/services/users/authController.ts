import { Request, Response } from "express";
import { AppRole, CustomerType } from "@prisma/client";
import { registerUser, loginUser } from "./userRepo";

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

    // role validation (don’t accept random strings)
    const parsedRole: AppRole =
      role && Object.values(AppRole).includes(role) ? role : AppRole.customer;

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
    return res.status(400).json({ error: err.message });
  }
};

export const login = async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body;

    const result = await loginUser(email, password);
    return res.json(result);
  } catch (err: any) {
    console.error("login error:", err?.message || err);

    // invalid login should be 401, not 500
    const msg = err?.message || "Login failed";
    const code = msg.includes("Invalid email or password") ? 401 : 400;

    return res.status(code).json({ error: msg });
  }
};
