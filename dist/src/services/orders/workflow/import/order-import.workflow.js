"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.previewOrderImport = previewOrderImport;
exports.importOrdersFromCsv = importOrdersFromCsv;
exports.getOrderImportTemplateCsv = getOrderImportTemplateCsv;
const client_1 = require("@prisma/client");
const orderCreate_mapper_1 = require("../../orderCreate.mapper");
const repo_1 = require("../../repo");
const orderService_shared_1 = require("../../orderService.shared");
const order_label_workflow_1 = require("../label/order-label.workflow");
const IMPORT_TEMPLATE_COLUMNS = [
    "receiverName",
    "receiverPhone",
    "pickupAddress",
    "dropoffAddress",
    "destinationCity",
    "senderName",
    "senderPhone",
    "serviceType",
    "weightKg",
    "codEnabled",
    "codAmount",
    "currency",
    "paymentType",
    "deliveryChargePaidBy",
    "itemValue",
    "plannedPickupAt",
    "plannedDeliveryAt",
    "referenceId",
    "promoCode",
    "note",
    "fragile",
    "dangerousGoods",
    "shipmentInsurance",
];
function parseBoolean(value) {
    const normalized = String(value || "")
        .trim()
        .toLowerCase();
    return normalized === "true" || normalized === "1" || normalized === "yes";
}
function parseCsv(text) {
    const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
    if (!normalized)
        return [];
    const rows = [];
    let currentRow = [];
    let currentCell = "";
    let inQuotes = false;
    for (let i = 0; i < normalized.length; i += 1) {
        const char = normalized[i];
        const nextChar = normalized[i + 1];
        if (char === '"') {
            if (inQuotes && nextChar === '"') {
                currentCell += '"';
                i += 1;
            }
            else {
                inQuotes = !inQuotes;
            }
            continue;
        }
        if (char === "," && !inQuotes) {
            currentRow.push(currentCell.trim());
            currentCell = "";
            continue;
        }
        if (char === "\n" && !inQuotes) {
            currentRow.push(currentCell.trim());
            rows.push(currentRow);
            currentRow = [];
            currentCell = "";
            continue;
        }
        currentCell += char;
    }
    currentRow.push(currentCell.trim());
    rows.push(currentRow);
    if (rows.length < 2)
        return [];
    const headers = rows[0];
    return rows.slice(1).map((cells, index) => {
        const values = {};
        headers.forEach((header, cellIndex) => {
            values[header] = cells[cellIndex] ?? "";
        });
        return {
            rowNumber: index + 2,
            values,
        };
    });
}
function mapCsvRowToCreateOrderDto(row, customerEntityId) {
    const v = row.values;
    return {
        customerEntityId: customerEntityId ?? undefined,
        sender: {
            name: v.senderName || null,
            phone: v.senderPhone || null,
        },
        receiver: {
            name: v.receiverName || null,
            phone: v.receiverPhone || null,
        },
        addresses: {
            senderAddressId: null,
            receiverAddressId: null,
            senderAddress: null,
            receiverAddress: null,
            pickupAddress: v.pickupAddress || "",
            dropoffAddress: v.dropoffAddress || "",
            destinationCity: v.destinationCity || null,
            savePickupToAddressBook: false,
            saveDropoffToAddressBook: false,
        },
        shipment: {
            serviceType: v.serviceType || "DOOR_TO_DOOR",
            weightKg: v.weightKg || undefined,
            codEnabled: parseBoolean(v.codEnabled),
            codAmount: v.codAmount || undefined,
            currency: v.currency || "EUR",
            parcels: [{ weightKg: v.weightKg || undefined }],
            pieceTotal: 1,
            fragile: parseBoolean(v.fragile),
            dangerousGoods: parseBoolean(v.dangerousGoods),
            shipmentInsurance: parseBoolean(v.shipmentInsurance),
            itemValue: v.itemValue || undefined,
        },
        payment: {
            paymentType: v.paymentType || null,
            deliveryChargePaidBy: v.deliveryChargePaidBy || null,
            codPaidStatus: null,
            serviceCharge: undefined,
            serviceChargePaidStatus: null,
            ifRecipientNotAvailable: null,
        },
        schedule: {
            plannedPickupAt: v.plannedPickupAt || null,
            plannedDeliveryAt: v.plannedDeliveryAt || null,
            promiseDate: null,
        },
        reference: {
            referenceId: v.referenceId || null,
            shelfId: null,
            promoCode: v.promoCode || null,
            numberOfCalls: undefined,
        },
        note: v.note || null,
        amount: undefined,
    };
}
async function buildPreviewRows(args) {
    const parsedRows = parseCsv(args.csvText);
    const previewRows = await Promise.all(parsedRows.map(async (row) => {
        const dto = mapCsvRowToCreateOrderDto(row, args.customerEntityId);
        const validation = orderCreate_mapper_1.createOrderPayloadSchema.safeParse(dto);
        if (!validation.success) {
            return {
                rowNumber: row.rowNumber,
                valid: false,
                errors: validation.error.issues.map((issue) => issue.message),
                summary: {
                    receiverName: String(dto.receiver?.name || ""),
                    pickupAddress: String(dto.addresses.pickupAddress || ""),
                    dropoffAddress: String(dto.addresses.dropoffAddress || ""),
                    serviceType: String(dto.shipment.serviceType || ""),
                    codAmount: typeof dto.shipment.codAmount === "number"
                        ? dto.shipment.codAmount
                        : dto.shipment.codAmount
                            ? Number(dto.shipment.codAmount)
                            : null,
                    referenceId: dto.reference.referenceId,
                },
            };
        }
        return {
            rowNumber: row.rowNumber,
            valid: true,
            errors: [],
            summary: {
                receiverName: String(validation.data.receiver?.name || ""),
                pickupAddress: validation.data.addresses.pickupAddress,
                dropoffAddress: validation.data.addresses.dropoffAddress,
                serviceType: String(validation.data.shipment.serviceType || ""),
                codAmount: typeof validation.data.shipment.codAmount === "number"
                    ? validation.data.shipment.codAmount
                    : null,
                referenceId: validation.data.reference?.referenceId ?? null,
            },
        };
    }));
    return previewRows;
}
async function previewOrderImport(args) {
    const rows = await buildPreviewRows(args);
    const validRows = rows.filter((row) => row.valid).length;
    const invalidRows = rows.length - validRows;
    return {
        templateColumns: IMPORT_TEMPLATE_COLUMNS,
        rows,
        totalRows: rows.length,
        validRows,
        invalidRows,
    };
}
async function resolveOrderOwnerCustomerId(actor, customerEntityId) {
    if (actor.role === client_1.AppRole.manager) {
        return actor.id;
    }
    return actor.id;
}
async function importOrdersFromCsv(args) {
    const actor = (0, orderService_shared_1.requireOrderActor)(args.actor);
    const preview = await previewOrderImport({
        csvText: args.csvText,
        customerEntityId: args.customerEntityId,
    });
    const invalidRows = preview.rows.filter((row) => !row.valid);
    if (invalidRows.length > 0) {
        const first = invalidRows[0];
        const message = `Import contains invalid rows. First issue: row ${first.rowNumber} - ${first.errors[0]}`;
        const error = new Error(message);
        error.statusCode = 400;
        throw error;
    }
    const parsedRows = parseCsv(args.csvText);
    const orderCustomerId = await resolveOrderOwnerCustomerId(args.actor, args.customerEntityId);
    const createdOrders = [];
    const rawLabelMode = process.env.ORDER_LABEL_MODE;
    const labelMode = rawLabelMode === "async" || rawLabelMode === "queue" ? rawLabelMode : "sync";
    for (const row of parsedRows) {
        const dto = mapCsvRowToCreateOrderDto(row, args.customerEntityId);
        const repoPayload = (await (0, orderCreate_mapper_1.mapCreateOrderDtoToRepoPayload)(dto));
        const order = await (0, repo_1.createOrder)(orderCustomerId, repoPayload, actor);
        createdOrders.push(order);
        if (labelMode === "queue") {
            await (0, order_label_workflow_1.enqueueOrderLabelJob)(order.id);
        }
        else if (labelMode === "async") {
            void (0, order_label_workflow_1.generateAndAttachParcelLabelsForOrder)(order.id).catch((labelErr) => {
                console.error(`Label generation failed for imported order ${order.id}:`, labelErr);
            });
        }
        else {
            await (0, order_label_workflow_1.generateAndAttachParcelLabelsForOrder)(order.id);
        }
    }
    return {
        count: createdOrders.length,
        orders: createdOrders,
    };
}
function getOrderImportTemplateCsv() {
    const header = IMPORT_TEMPLATE_COLUMNS.join(",");
    const sample = [
        "Anvarbek Sharipov",
        "+4917684503681",
        "\"Luisental 29D, Horn, Bremen, Germany\"",
        "\"Am Schilfpark 3A, Bergedorf, Hamburg, Germany\"",
        "Hamburg",
        "Cargo Green",
        "+998946430090",
        "DOOR_TO_DOOR",
        "2.5",
        "false",
        "",
        "EUR",
        "CASH",
        "SENDER",
        "120",
        "",
        "",
        "REF-1001",
        "",
        "Handle with care",
        "true",
        "false",
        "false",
    ].join(",");
    return `${header}\n${sample}\n`;
}
