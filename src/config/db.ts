import hana from "@sap/hana-client";

export function getConnection() {
  const conn = hana.createConnection();
  conn.connect({
    serverNode: `${process.env.HANA_HOST}:${process.env.HANA_PORT}`,
    uid: process.env.HANA_USER,
    pwd: process.env.HANA_PASSWORD,
    schema: process.env.HANA_SCHEMA,
  });
  return conn;
}
