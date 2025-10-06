import { getConnection } from "../../config/db";
import { v4 as uuidv4 } from "uuid";

export interface Warehouse {
  ID: string;
  NAME: string;
  LOCATION: string;
  CREATED_AT?: Date;
}

export function createWarehouse(name: string, location: string): Warehouse {
  const conn = getConnection();
  const id = uuidv4();

  const stmt = conn.prepare(`
    INSERT INTO WAREHOUSES (ID, NAME, LOCATION)
    VALUES (?, ?, ?)
  `);
  stmt.exec([id, name, location]);
  stmt.drop();

  const result = conn.exec(
    `SELECT * FROM WAREHOUSES WHERE ID = '${id}'`
  ) as Warehouse[];
  conn.disconnect();

  return result[0];
}

export function listWarehouses(): Warehouse[] {
  const conn = getConnection();
  const result = conn.exec(
    `SELECT * FROM WAREHOUSES ORDER BY CREATED_AT DESC`
  ) as Warehouse[];
  conn.disconnect();
  return result;
}
