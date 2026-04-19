import { AppRole } from "@prisma/client";
import { DEFAULT_SERVICE_TYPE, normalizeServiceTypeInput } from "../../order.constants";

import {
  CreateOrderRepoPayload,
  createOrderPayloadSchema,
  mapCreateOrderDtoToRepoPayload,
} from "../../orderCreate.mapper";
import { createOrder } from "../../repo";
import { requireOrderActor } from "../../orderService.shared";
import {
  enqueueOrderLabelJob,
  generateAndAttachParcelLabelsForOrder,
} from "../label/order-label.workflow";

const IMPORT_TEMPLATE_COLUMNS = [
  "receiverName",
  "receiverPhone",
  "receiverPhone2",
  "receiverPhone3",
  "pickupAddress",
  "dropoffAddress",
  "destinationCity",
  "senderName",
  "senderPhone",
  "senderPhone2",
  "senderPhone3",
  "serviceType",
  "weightKg",
  "pieceTotal",
  "codEnabled",
  "codAmount",
  "currency",
  "paymentType",
  "deliveryChargePaidBy",
  "serviceCharge",
  "serviceChargePaidStatus",
  "codPaidStatus",
  "ifRecipientNotAvailable",
  "itemValue",
  "plannedPickupAt",
  "plannedDeliveryAt",
  "promiseDate",
  "referenceId",
  "promoCode",
  "numberOfCalls",
  "note",
  "fragile",
  "dangerousGoods",
  "shipmentInsurance",
] as const;

type ImportActor = {
  id: string;
  role: AppRole;
  email?: string;
  customerEntityId?: string | null;
  warehouseId?: string | null;
};

type PreviewArgs = {
  csvText: string;
  customerEntityId?: string | null;
};

type ParsedCsvRow = {
  rowNumber: number;
  values: Record<string, string>;
};

export type OrderImportPreviewRow = {
  rowNumber: number;
  valid: boolean;
  errors: string[];
  summary: {
    receiverName: string;
    pickupAddress: string;
    dropoffAddress: string;
    serviceType: string;
    codAmount: number | null;
    referenceId: string | null;
  };
};

export type OrderImportPreview = {
  templateColumns: readonly string[];
  rows: OrderImportPreviewRow[];
  totalRows: number;
  validRows: number;
  invalidRows: number;
};

function parseBoolean(value?: string) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  return normalized === "true" || normalized === "1" || normalized === "yes";
}

function parseCsv(text: string): ParsedCsvRow[] {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
  if (!normalized) return [];

  const rows: string[][] = [];
  let currentRow: string[] = [];
  let currentCell = "";
  let inQuotes = false;

  for (let i = 0; i < normalized.length; i += 1) {
    const char = normalized[i];
    const nextChar = normalized[i + 1];

    if (char === '"') {
      if (inQuotes && nextChar === '"') {
        currentCell += '"';
        i += 1;
      } else {
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

  if (rows.length < 2) return [];

  const headers = rows[0];
  return rows.slice(1).map((cells, index) => {
    const values: Record<string, string> = {};
    headers.forEach((header, cellIndex) => {
      values[header] = cells[cellIndex] ?? "";
    });

    return {
      rowNumber: index + 2,
      values,
    };
  });
}

function mapCsvRowToCreateOrderDto(
  row: ParsedCsvRow,
  customerEntityId?: string | null,
) {
  const v = row.values;

  return {
    customerEntityId: customerEntityId ?? undefined,
    sender: {
      name: v.senderName || null,
      phone: v.senderPhone || null,
      phone2: v.senderPhone2 || null,
      phone3: v.senderPhone3 || null,
    },
    receiver: {
      name: v.receiverName || null,
      phone: v.receiverPhone || null,
      phone2: v.receiverPhone2 || null,
      phone3: v.receiverPhone3 || null,
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
      serviceType: normalizeServiceTypeInput(v.serviceType || DEFAULT_SERVICE_TYPE),
      weightKg: v.weightKg || undefined,
      codEnabled: parseBoolean(v.codEnabled),
      codAmount: v.codAmount || undefined,
      currency: v.currency || "EUR",
      parcels: [{ weightKg: v.weightKg || undefined }],
      pieceTotal: v.pieceTotal || 1,
      fragile: parseBoolean(v.fragile),
      dangerousGoods: parseBoolean(v.dangerousGoods),
      shipmentInsurance: parseBoolean(v.shipmentInsurance),
      itemValue: v.itemValue || undefined,
    },
    payment: {
      paymentType: v.paymentType || null,
      deliveryChargePaidBy: v.deliveryChargePaidBy || null,
      codPaidStatus: v.codPaidStatus || null,
      serviceCharge: v.serviceCharge || undefined,
      serviceChargePaidStatus: v.serviceChargePaidStatus || null,
      ifRecipientNotAvailable: v.ifRecipientNotAvailable || null,
    },
    schedule: {
      plannedPickupAt: v.plannedPickupAt || null,
      plannedDeliveryAt: v.plannedDeliveryAt || null,
      promiseDate: v.promiseDate || null,
    },
    reference: {
      referenceId: v.referenceId || null,
      shelfId: null,
      promoCode: v.promoCode || null,
      numberOfCalls: v.numberOfCalls || undefined,
    },
    note: v.note || null,
    amount: undefined,
  };
}

async function buildPreviewRows(args: PreviewArgs) {
  const parsedRows = parseCsv(args.csvText);

  const previewRows = await Promise.all(
    parsedRows.map(async (row): Promise<OrderImportPreviewRow> => {
      const dto = mapCsvRowToCreateOrderDto(row, args.customerEntityId);
      const validation = createOrderPayloadSchema.safeParse(dto);

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
            codAmount:
              typeof dto.shipment.codAmount === "number"
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
          codAmount:
            typeof validation.data.shipment.codAmount === "number"
              ? validation.data.shipment.codAmount
              : null,
          referenceId: validation.data.reference?.referenceId ?? null,
        },
      };
    }),
  );

  return previewRows;
}

export async function previewOrderImport(
  args: PreviewArgs,
): Promise<OrderImportPreview> {
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

async function resolveOrderOwnerCustomerId(
  actor: ImportActor,
  customerEntityId?: string | null,
) {
  if (actor.role === AppRole.manager) {
    return actor.id;
  }

  return actor.id;
}

export async function importOrdersFromCsv(args: {
  actor: ImportActor;
  csvText: string;
  customerEntityId?: string | null;
}) {
  const actor = requireOrderActor(args.actor);
  const preview = await previewOrderImport({
    csvText: args.csvText,
    customerEntityId: args.customerEntityId,
  });

  const invalidRows = preview.rows.filter((row) => !row.valid);
  if (invalidRows.length > 0) {
    const first = invalidRows[0];
    const message = `Import contains invalid rows. First issue: row ${first.rowNumber} - ${first.errors[0]}`;
    const error = new Error(message) as Error & { statusCode: number };
    error.statusCode = 400;
    throw error;
  }

  const parsedRows = parseCsv(args.csvText);
  const orderCustomerId = await resolveOrderOwnerCustomerId(
    args.actor,
    args.customerEntityId,
  );

  const createdOrders = [];
  const rawLabelMode = process.env.ORDER_LABEL_MODE;
  const labelMode =
    rawLabelMode === "async" || rawLabelMode === "queue" ? rawLabelMode : "sync";

  for (const row of parsedRows) {
    const dto = mapCsvRowToCreateOrderDto(row, args.customerEntityId);
    const repoPayload = (await mapCreateOrderDtoToRepoPayload(
      dto,
    )) as CreateOrderRepoPayload;
    const order = await createOrder(orderCustomerId, repoPayload, actor);
    createdOrders.push(order);

    if (labelMode === "queue") {
      await enqueueOrderLabelJob(order.id);
    } else if (labelMode === "async") {
      void generateAndAttachParcelLabelsForOrder(order.id).catch((labelErr) => {
        console.error(`Label generation failed for imported order ${order.id}:`, labelErr);
      });
    } else {
      await generateAndAttachParcelLabelsForOrder(order.id);
    }
  }

  return {
    count: createdOrders.length,
    orders: createdOrders,
  };
}

export function getOrderImportTemplateCsv() {
  const header = IMPORT_TEMPLATE_COLUMNS.join(",");
  const sample = [
    "Alex Morgan",
    "+491700000101",
    "+491700000102",
    "",
    "\"14 Harbor Street, District 5, Bremen, Germany\"",
    "\"220 River Avenue, North Block, Hamburg, Germany\"",
    "Hamburg",
    "North Hub Sender",
    "+491700000201",
    "+491700000202",
    "",
    DEFAULT_SERVICE_TYPE,
    "2.5",
    "1",
    "false",
    "",
    "EUR",
    "CASH",
    "SENDER",
    "28000",
    "NOT_PAID",
    "NOT_PAID",
    "CALL_SENDER",
    "120",
    "",
    "",
    "",
    "REF-1001",
    "",
    "0",
    "Handle with care",
    "true",
    "false",
    "false",
  ].join(",");

  return `${header}\n${sample}\n`;
}
