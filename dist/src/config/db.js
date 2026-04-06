"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getConnection = getConnection;
const hana_client_1 = __importDefault(require("@sap/hana-client"));
function getConnection() {
    const conn = hana_client_1.default.createConnection();
    conn.connect({
        serverNode: `${process.env.HANA_HOST}:${process.env.HANA_PORT}`,
        uid: process.env.HANA_USER,
        pwd: process.env.HANA_PASSWORD,
        schema: process.env.HANA_SCHEMA,
    });
    return conn;
}
