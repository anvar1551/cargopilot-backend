"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.listDrivers = void 0;
const driverRepo_1 = require("./driverRepo");
const listDrivers = async (req, res) => {
    try {
        const drivers = await (0, driverRepo_1.listAllDrivers)();
        res.json(drivers);
    }
    catch (error) {
        console.error(error);
        res.status(500).json({ error: "Failed to fetch drivers" });
    }
};
exports.listDrivers = listDrivers;
