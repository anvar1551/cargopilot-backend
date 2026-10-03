import { assertCreationInputAuthority, authorityError } from "../domain/creation-authority";
import { DEFAULT_SERVICE_TYPE, normalizeServiceTypeInput } from "../domain/order.constants";

import {
  CreateOrderRepoPayload,
  createOrderPayloadSchema,
  mapCreateOrderDtoToRepoPayload,
} from "../domain/orderCreate.mapper";
import { createOrder, getOrderCreationRetry, acceptOrderImportIntent } from "../repo/order-write.repo";
import { buildCreationRequest } from "../domain/creation-request";
import { requireOrderActor } from "../shared";
import { prepareAuthorizedOrderCreation } from "../write/create-order";
import { seedInitialServiceChargePricing } from "../../orders-legs";
import type { AppUser } from "../../../types/app-user";
import {
  enqueueOrderLabelJob,
  generateAndAttachParcelLabelsForOrder,
  isOrderLabelAutoFallbackEnabled,
  resolveOrderLabelMode,
  scheduleOrderLabelAutoFallback,
} from "../label";

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
  "originCity",
  "originCountryCode",
  "destinationCountryCode",
  "transportMode",
  "customerEntityId",
  "senderAddressId",
  "receiverAddressId",
] as const;

type PreviewArgs = {
  actor: AppUser;
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
  if (Buffer.byteLength(text)>1024*1024) throw Object.assign(new Error("CSV byte limit exceeded"),{statusCode:413});
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

  if (rows.length>101) throw Object.assign(new Error("CSV row limit exceeded"),{statusCode:413});
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
  if (customerEntityId && v.customerEntityId && customerEntityId.toLowerCase() !== v.customerEntityId.toLowerCase()) throw authorityError("Import customer selection conflicts with row reference",403);

  return {
    customerEntityId: customerEntityId ?? (v.customerEntityId || undefined),
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
      senderAddressId: v.senderAddressId || null,
      receiverAddressId: v.receiverAddressId || null,
      senderAddress:
        v.originCity || v.originCountryCode
          ? { city: v.originCity || null, country: v.originCountryCode || null }
          : null,
      receiverAddress:
        v.destinationCity || v.destinationCountryCode
          ? { city: v.destinationCity || null, country: v.destinationCountryCode || null }
          : null,
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
      currency: v.currency || "UZS",
      parcels: [{ weightKg: v.weightKg || undefined }],
      pieceTotal: v.pieceTotal || 1,
      fragile: parseBoolean(v.fragile),
      dangerousGoods: parseBoolean(v.dangerousGoods),
      shipmentInsurance: parseBoolean(v.shipmentInsurance),
      itemValue: v.itemValue || undefined,
      transportMode: v.transportMode || "ROAD",
    },
    payment: {
      paymentType: v.paymentType || null,
      deliveryChargePaidBy: v.deliveryChargePaidBy || null,
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
  };
}

async function buildPreviewRows(args: PreviewArgs) {
  assertCreationInputAuthority({ customerEntityId: args.customerEntityId });
  const parsedRows = parseCsv(args.csvText);
  for (const row of parsedRows) assertCreationInputAuthority(row.values);

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

      try {
        const mapped = await mapCreateOrderDtoToRepoPayload(validation.data);
        await prepareAuthorizedOrderCreation(args.actor, mapped);
      } catch (error) {
        const statusCode = (error as { statusCode?: number })?.statusCode;
        if (statusCode === 401 || statusCode === 403 || statusCode === 503) throw error;
        return {
          rowNumber: row.rowNumber,
          valid: false,
          errors: ["Order import preparation failed"],
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

export async function importOrdersFromCsv(args: {
  actor: AppUser;
  csvText: string;
  customerEntityId?: string | null;
  operationId: unknown;
}) {
  const actor = requireOrderActor(args.actor);
  assertCreationInputAuthority({ customerEntityId: args.customerEntityId });
  const parsedRows = parseCsv(args.csvText);
  const mappedRows: CreateOrderRepoPayload[]=[];
  for(const row of parsedRows) {
    assertCreationInputAuthority(row.values);
    const validation=createOrderPayloadSchema.safeParse(mapCsvRowToCreateOrderDto(row,args.customerEntityId));
    if(!validation.success) throw authorityError(`Invalid import row ${row.rowNumber}`);
    mappedRows.push(await mapCreateOrderDtoToRepoPayload(validation.data));
  }
  const request=buildCreationRequest(actor,args.operationId,"import",mappedRows);
  // Validate/price only missing rows before accepting a new batch. Prior receipts
  // are freshly authorized and never reprice their committed order.
  const preparedRows=[];
  for(let ordinal=0;ordinal<mappedRows.length;ordinal++) {
    const prior=await getOrderCreationRetry(actor,request,ordinal);
    preparedRows.push(prior ? null : await prepareAuthorizedOrderCreation(args.actor,{...mappedRows[ordinal]}));
  }
  await acceptOrderImportIntent(actor,request);
  const createdOrders = [];
  const labelMode = resolveOrderLabelMode(process.env.ORDER_LABEL_MODE, "sync");
  const autoLabelFallback = isOrderLabelAutoFallbackEnabled();

  let replayedRows=0;
  for (let ordinal=0;ordinal<parsedRows.length;ordinal++) {
    const prior=await getOrderCreationRetry(actor,request,ordinal);
    if(prior) {createdOrders.push(prior);replayedRows++;continue;}
    const prepared=preparedRows[ordinal] ?? await prepareAuthorizedOrderCreation(args.actor,{...mappedRows[ordinal]});
    const created=await createOrder(actor.id,prepared.payload,prepared.actor,request,ordinal);
    const order=created.order;
    createdOrders.push(order);
    if(created.replayed) {replayedRows++;continue;}

    try {
      await seedInitialServiceChargePricing(order.id, prepared.pricingSeed, prepared.actor);
    } catch {
      console.error("ORDER_IMPORT_PRICING_SEED_FAILED", { orderId: order.id });
    }

    if (labelMode === "queue") {
      try {
        await enqueueOrderLabelJob(order.id, actor);
      } catch (queueErr) {
        if (!autoLabelFallback) throw queueErr;
        console.error(
          "ORDER_IMPORT_LABEL_ENQUEUE_INLINE_FALLBACK",
          { orderId: order.id },
        );
        await generateAndAttachParcelLabelsForOrder(order.id, actor);
        continue;
      }

      if (autoLabelFallback) {
        await scheduleOrderLabelAutoFallback(order.id, actor);
      }
    } else if (labelMode === "async") {
      void generateAndAttachParcelLabelsForOrder(order.id, actor).catch(() => {
        console.error("ORDER_IMPORT_LABEL_GENERATION_FAILED", { orderId: order.id });
      });
    } else {
      await generateAndAttachParcelLabelsForOrder(order.id, actor);
    }
  }

  return {
    count: createdOrders.length,
    orders: createdOrders,
    replayedRows,
    downstreamRecoveryRequired: replayedRows>0,
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
    "UZS",
    "CASH",
    "SENDER",
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
    "Bremen",
    "DE",
    "DE",
    "ROAD",
  ].join(",");

  return `${header}\n${sample}\n`;
}
