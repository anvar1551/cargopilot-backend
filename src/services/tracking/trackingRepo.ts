import { getConnection } from "../../config/db";
import { v4 as uuidv4 } from "uuid";

export interface TrackingEvent {
  ID: string;
  ORDER_ID: string;
  STATUS: string;
  REGION?: string;
  WAREHOUSE_ID?: string;
  TIMESTAMP?: Date;
  DESCRIPTION?: string;
}

export function addTracking(
  orderId: string,
  status: string,
  region?: string,
  warehouseId?: string,
  description?: string
): TrackingEvent {
  const conn = getConnection();
  const id = uuidv4();

  const stmt = conn.prepare(`
    INSERT INTO TRACKING (ID, ORDER_ID, STATUS, REGION, WAREHOUSE_ID, DESCRIPTION)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  stmt.exec([
    id,
    orderId,
    status,
    region || null,
    warehouseId || null,
    description || null,
  ]);
  stmt.drop();

  const result = conn.exec(
    `SELECT * FROM TRACKING WHERE ID = '${id}'`
  ) as TrackingEvent[];
  conn.disconnect();

  return result[0];
}

export function getTrackingForOrder(orderId: string): TrackingEvent[] {
  const conn = getConnection();

  const stmt = conn.prepare(`
    SELECT 
      T.ID,
      T.ORDER_ID,
      T.STATUS,
      T.REGION,
      T.WAREHOUSE_ID,
      W.NAME AS WAREHOUSE_NAME,
      T.TIMESTAMP,
      T.DESCRIPTION
    FROM TRACKING AS T
    LEFT JOIN WAREHOUSES AS W ON T.WAREHOUSE_ID = W.ID
    WHERE T.ORDER_ID = ?
    ORDER BY T.TIMESTAMP ASC
  `);

  const rows = stmt.exec([orderId]) as TrackingEvent[];
  stmt.drop();
  conn.disconnect();

  return rows;
}
