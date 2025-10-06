import { getConnection } from "../../config/db";
import { v4 as uuidv4 } from "uuid";

export interface Order {
  ID: string;
  CUSTOMER_ID: string;
  PICKUP_ADDRESS: string;
  DROPOFF_ADDRESS: string;
  STATUS: string;
  ASSIGNED_DRIVER_ID?: string | null;
  CREATED_AT?: Date;
}

export function createOrder(
  customerId: string,
  pickup: string,
  dropoff: string
): Order {
  const conn = getConnection();
  const id = uuidv4();

  const sql = `
    INSERT INTO ORDERS (ID, CUSTOMER_ID, PICKUP_ADDRESS, DROPOFF_ADDRESS, STATUS)
    VALUES (?, ?, ?, ?, 'pending')
  `;
  const stmt = conn.prepare(sql);
  stmt.exec([id, customerId, pickup, dropoff]);
  stmt.drop();

  const result = conn.exec(
    `SELECT * FROM ORDERS WHERE ID = '${id}'`
  ) as Order[];
  conn.disconnect();

  return result[0];
}

// export function listOrders(): Order[] {
//   const conn = getConnection();
//   const result = conn.exec(
//     `SELECT * FROM ORDERS ORDER BY CREATED_AT DESC`
//   ) as Order[];
//   conn.disconnect();

//   return result;
// }

// Gets single order by ID
export function getOrderById(id: string): Order | null {
  const conn = getConnection();
  const stmt = conn.prepare(`SELECT * FROM ORDERS WHERE ID = ?`);
  const rows = stmt.exec([id]) as Order[];
  stmt.drop();
  conn.disconnect();
  return rows.length ? rows[0] : null;
}

// Gets list of Orders accordig to role
export function listOrdersForRole(userId: string, role: string): Order[] {
  const conn = getConnection();

  if (role === "manager" || role === "warehouse") {
    const rows = conn.exec(
      `SELECT * FROM ORDERS ORDER BY CREATED_AT DESC`
    ) as Order[];
    conn.disconnect();
    return rows;
  }

  if (role === "customer") {
    const stmt = conn.prepare(
      `SELECT * FROM ORDERS WHERE CUSTOMER_ID = ? ORDER BY CREATED_AT DESC`
    );
    const rows = stmt.exec([userId]) as Order[];
    stmt.drop();
    conn.disconnect();
    return rows;
  }

  if (role === "driver") {
    const stmt = conn.prepare(
      `SELECT * FROM ORDERS WHERE ASSIGNED_DRIVER_ID = ? ORDER BY CREATED_AT DESC`
    );
    const rows = stmt.exec([userId]) as Order[];
    stmt.drop();
    conn.disconnect();
    return rows;
  }

  conn.disconnect();
  return [];
}

//Assign orders to a driver
export function assignDriver(orderId: string, driverId: string): boolean {
  const conn = getConnection();

  const stmt = conn.prepare(
    `UPDATE ORDERS SET ASSIGNED_DRIVER_ID = ?, STATUS = 'assigned' WHERE ID = ?`
  );
  stmt.exec([driverId, orderId]);
  stmt.drop();

  conn.disconnect();

  return true;
}
