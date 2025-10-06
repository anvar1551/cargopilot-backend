import jwt from "jsonwebtoken";

export function auth(requiedRoles: string[] = []) {
  return (req: any, res: any, next: any) => {
    const header = req.headers["authorization"];
    if (!header) return res.status(401).json({ error: "No token provided" });

    const token = header.split(" ")[1];
    if (!token) return res.status(401).json({ error: "Invalid token" });

    try {
      const decoded = jwt.verify(
        token,
        process.env.JWT_SECRET || "devsecret"
      ) as any;
      req.user = decoded;

      if (requiedRoles.length && !requiedRoles.includes(decoded.role)) {
        return res.status(403).json({ error: "Forbidden" });
      }

      next();
    } catch (err) {
      return res.status(401).json({ error: "Unathorized" });
    }
  };
}
