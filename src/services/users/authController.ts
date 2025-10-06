import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { createUser, findUserByEmail } from "./userRepo";

export async function register(req: any, res: any) {
  try {
    const { name, email, password, role } = req.body;

    const existing = findUserByEmail(email);
    if (existing) {
      return res.status(400).json("Email already exists");
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const user = createUser(name, email, passwordHash, role);

    const token = jwt.sign(
      { id: user.ID, email: user.EMAIL, role: user.ROLE },
      process.env.JWT_SECRET || "devsecret",
      { expiresIn: "7d" }
    );

    res.json({ token, user });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
}

export async function login(req: any, res: any) {
  try {
    const { email, password } = req.body;

    const user = findUserByEmail(email);
    if (!user) {
      return res.status(400).json({ error: "Invalid credentials" });
    }

    const valid = await bcrypt.compare(password, user.PASSWORD_HASH);
    if (!valid) {
      return res.status(400).json({ error: "Invalid credentials" });
    }

    const token = jwt.sign(
      { id: user.ID, email: user.EMAIL, role: user.ROLE },
      process.env.JWT_SECRET || "devsecret",
      { expiresIn: "7d" }
    );

    res.json({ token, user });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
}
