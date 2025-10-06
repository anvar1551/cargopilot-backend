import { getConnection } from "../../config/db";
import { v4 as uuidv4 } from "uuid";

export interface User {
  ID: string;
  NAME: string;
  EMAIL: string;
  PASSWORD_HASH: string;
  ROLE: string;
  CREATED_AT?: Date;
}

export function createUser(
  name: string,
  email: string,
  passwordHash: string,
  role: string = "customer"
) {
  const conn = getConnection();
  const id = uuidv4();

  const sql = `INSERT INTO USERS (ID, NAME, EMAIL, PASSWORD_HASH, ROLE) VALUES (?, ?, ?, ?, ?)`;
  const stmt = conn.prepare(sql);
  stmt.exec([id, name, email, passwordHash, role]);
  stmt.drop();

  const result = conn.exec(`SELECT * FROM USERS WHERE ID = '${id}'`) as User[];
  conn.disconnect();

  return result[0];
}

export function findUserByEmail(email: string): User | null {
  const conn = getConnection();
  const result = conn.exec(`SELECT * FROM USERS WHERE EMAIL = ?`, [
    email,
  ]) as User[];
  conn.disconnect();
  return result.length > 0 ? result[0] : null;
}
