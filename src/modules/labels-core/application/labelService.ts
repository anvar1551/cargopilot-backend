import PDFDocument from "pdfkit";
import QRCode from "qrcode";
import fs from "fs";
import path from "path";

const bwipjs = require("bwip-js");

type SecondCodeMode = "barcode" | "qr";

type OrderLabelInput = {
  parcelCode: string;
  pickupAddress: string;
  dropoffAddress: string;
  destinationCity?: string;
  referenceId?: string | null;
  createdAt?: Date | string | null;
  codAmount?: number | string | null;
  currency?: string | null;
  pieceNo: number;
  pieceTotal: number;

  weightKg?: number;
  serviceType?: string;
  senderName?: string;
  senderPhone?: string;
  receiverName?: string;
  receiverPhone?: string;
};

function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function box(
  doc: PDFKit.PDFDocument,
  x: number,
  y: number,
  w: number,
  h: number,
  lw = 1.2,
) {
  doc.save();
  doc.lineWidth(lw).rect(x, y, w, h).stroke();
  doc.restore();
}

function vline(
  doc: PDFKit.PDFDocument,
  x: number,
  y: number,
  h: number,
  lw = 1,
) {
  doc.save();
  doc
    .lineWidth(lw)
    .moveTo(x, y)
    .lineTo(x, y + h)
    .stroke();
  doc.restore();
}

function fitText(
  doc: PDFKit.PDFDocument,
  text: string,
  x: number,
  y: number,
  width: number,
  height: number,
  options?: PDFKit.Mixins.TextOptions,
) {
  doc.text(String(text ?? ""), x, y, {
    width,
    height,
    ellipsis: true,
    lineBreak: true,
    ...options,
  });
}

function normalizeMoney(value: number | string | null | undefined): string {
  if (value == null || value === "") return "0.00";
  const asNumber = typeof value === "number" ? value : Number(value);
  return Number.isFinite(asNumber) ? asNumber.toFixed(2) : "0.00";
}

function normalizeWeight(weightKg: number | null | undefined): string {
  if (typeof weightKg !== "number" || !Number.isFinite(weightKg) || weightKg <= 0) {
    return "1 kg";
  }
  const rounded = Number.isInteger(weightKg) ? String(weightKg) : weightKg.toFixed(2);
  return `${rounded} kg`;
}

function normalizeService(serviceType?: string | null): string {
  if (!serviceType) return "DOOR TO DOOR";
  return serviceType.replace(/_/g, " ").toUpperCase();
}

function normalizeDate(value: Date | string | null | undefined): string {
  if (!value) return "-";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "-";

  return date.toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

function resolveSecondCodeMode(): SecondCodeMode {
  const mode = String(
    process.env.ORDER_LABEL_SECOND_CODE_MODE ?? process.env.ORDER_LABEL_SCAN_MODE ?? "barcode",
  )
    .trim()
    .toLowerCase();

  return mode === "qr" ? "qr" : "barcode";
}

async function buildBarcode(code: string, height = 10): Promise<Buffer | null> {
  try {
    return await bwipjs.toBuffer({
      bcid: "code128",
      text: code,
      scale: 2,
      height,
      includetext: false,
    });
  } catch {
    return null;
  }
}

export async function generateLabelPDF(order: OrderLabelInput) {
  const outputDir = path.resolve("labels");
  ensureDir(outputDir);

  const safeParcelCode = order.parcelCode.replace(/[\\/]/g, "-");
  const filePath = path.join(outputDir, `${safeParcelCode}.pdf`);

  const doc = new PDFDocument({ size: "A6", margin: 12, layout: "portrait" });
  const stream = fs.createWriteStream(filePath);
  doc.pipe(stream);

  const m = doc.page.margins.left;
  const W = doc.page.width - m * 2;
  const secondCodeMode = resolveSecondCodeMode();

  let y = m;

  const mainBarcode = await buildBarcode(order.parcelCode, 10);
  const secondBarcode =
    secondCodeMode === "barcode" ? await buildBarcode(order.parcelCode, 10) : null;
  const secondQr =
    secondCodeMode === "qr"
      ? await QRCode.toBuffer(order.parcelCode, {
          margin: 1,
          scale: 6,
        })
      : null;

  const codAmount = normalizeMoney(order.codAmount);
  const currency = (order.currency || "UZS").toUpperCase();
  const service = normalizeService(order.serviceType);
  const weight = normalizeWeight(order.weightKg);
  const createdAt = normalizeDate(order.createdAt);
  const senderName = order.senderName || "SENDER";
  const receiverName = order.receiverName || "RECEIVER";

  // Row 1: Shipment + main barcode.
  const row1H = 50;
  box(doc, m, y, W, row1H);

  doc.font("Helvetica-Bold").fontSize(12);
  fitText(
    doc,
    `Shipment: ${order.pieceNo}/${order.pieceTotal}`,
    m + 10,
    y + 16,
    140,
    16,
  );

  if (mainBarcode) {
    const codeW = Math.min(165, W - 170);
    doc.image(mainBarcode, m + W - codeW - 10, y + 7, {
      width: codeW,
      height: 22,
    });
    doc.font("Helvetica").fontSize(8.5);
    fitText(doc, order.parcelCode, m + W - codeW - 10, y + 30, codeW, 12, {
      align: "center",
    });
  } else {
    doc.font("Helvetica").fontSize(9);
    fitText(doc, order.parcelCode, m + W - 170, y + 17, 160, 16, {
      align: "right",
    });
  }

  y += row1H;

  // Row 2: COD + service summary.
  const row2H = 62;
  box(doc, m, y, W, row2H);
  const row2SplitX = m + Math.round(W * 0.57);
  vline(doc, row2SplitX, y, row2H);

  doc.font("Helvetica-Bold").fontSize(10);
  fitText(doc, "COD total", m + 10, y + 8, row2SplitX - m - 20, 12);
  doc.font("Helvetica-Bold").fontSize(30);
  fitText(doc, codAmount, m + 10, y + 20, row2SplitX - m - 20, 28);
  doc.font("Helvetica").fontSize(12);
  fitText(doc, currency, m + 10, y + 50, row2SplitX - m - 20, 12);

  doc.font("Helvetica-Bold").fontSize(10);
  fitText(doc, "Service type", row2SplitX + 10, y + 10, m + W - row2SplitX - 20, 12);
  doc.font("Helvetica-Bold").fontSize(11);
  fitText(doc, service, row2SplitX + 10, y + 24, m + W - row2SplitX - 20, 14);
  doc.font("Helvetica-Bold").fontSize(10.5);
  fitText(doc, `Weight: ${weight}`, row2SplitX + 10, y + 44, m + W - row2SplitX - 20, 12);

  y += row2H;

  // Row 3: sender + creation date.
  const row3H = 34;
  box(doc, m, y, W, row3H);
  const row3SplitX = m + Math.round(W * 0.56);
  vline(doc, row3SplitX, y, row3H);

  doc.font("Helvetica-Bold").fontSize(10);
  fitText(doc, "From / Sender:", m + 10, y + 7, row3SplitX - m - 20, 12);
  fitText(doc, senderName, m + 10, y + 19, row3SplitX - m - 20, 12);
  fitText(doc, "Created:", row3SplitX + 10, y + 7, m + W - row3SplitX - 20, 12);
  doc.font("Helvetica").fontSize(10.5);
  fitText(doc, createdAt, row3SplitX + 10, y + 19, m + W - row3SplitX - 20, 12);

  y += row3H;

  // Row 4: sender details.
  const row4H = 64;
  box(doc, m, y, W, row4H);
  doc.font("Helvetica-Bold").fontSize(9.8);
  fitText(doc, `From / Sender  ${senderName}`, m + 8, y + 8, W - 16, 12);
  doc.font("Helvetica").fontSize(10);
  fitText(doc, `Address: ${order.pickupAddress}`, m + 8, y + 23, W - 16, 24);
  fitText(doc, `Phone: ${order.senderPhone ?? "-"}`, m + 8, y + 47, W - 16, 12);

  y += row4H;

  // Row 5: receiver details.
  const row5H = 64;
  box(doc, m, y, W, row5H);
  doc.font("Helvetica-Bold").fontSize(9.8);
  fitText(doc, `To / Receiver  ${receiverName}`, m + 8, y + 8, W - 16, 12);
  doc.font("Helvetica").fontSize(10);
  fitText(doc, `Address: ${order.dropoffAddress}`, m + 8, y + 23, W - 16, 24);
  fitText(doc, `Phone: ${order.receiverPhone ?? "-"}`, m + 8, y + 47, W - 16, 12);

  y += row5H;

  // Row 6: destination + reference.
  const row6H = 56;
  box(doc, m, y, W, row6H);
  const row6SplitX = m + Math.round(W * 0.55);
  vline(doc, row6SplitX, y, row6H);

  doc.font("Helvetica-Bold").fontSize(10);
  fitText(doc, "Destination city:", m + 10, y + 8, row6SplitX - m - 20, 12);
  doc.font("Helvetica-Bold").fontSize(21);
  fitText(doc, order.destinationCity || "-", m + 10, y + 22, row6SplitX - m - 20, 28);

  doc.font("Helvetica-Bold").fontSize(10);
  fitText(doc, "Reference number:", row6SplitX + 10, y + 8, m + W - row6SplitX - 20, 12);
  doc.font("Helvetica").fontSize(11);
  fitText(doc, order.referenceId || "-", row6SplitX + 10, y + 24, m + W - row6SplitX - 20, 24);

  y += row6H;

  // Row 7: footer branding + second code (barcode default, qr optional).
  const row7H = 40;
  box(doc, m, y, W, row7H);
  const row7SplitX = m + Math.round(W * 0.53);
  vline(doc, row7SplitX, y, row7H);

  doc.font("Helvetica-Bold").fontSize(14);
  fitText(doc, "CARGOPILOT", m + 10, y + 12, row7SplitX - m - 20, 18);

  const rightW = m + W - row7SplitX;
  if (secondCodeMode === "qr" && secondQr) {
    const qrSize = Math.min(30, row7H - 8);
    doc.image(secondQr, row7SplitX + rightW - qrSize - 8, y + 4, {
      width: qrSize,
      height: qrSize,
    });
    doc.font("Helvetica").fontSize(7.5);
    fitText(doc, order.parcelCode, row7SplitX + 6, y + 12, rightW - qrSize - 16, 16, {
      align: "left",
    });
  } else if (secondBarcode) {
    doc.image(secondBarcode, row7SplitX + 8, y + 5, {
      width: rightW - 16,
      height: 18,
    });
    doc.font("Helvetica").fontSize(8);
    fitText(doc, order.parcelCode, row7SplitX + 8, y + 24, rightW - 16, 12, {
      align: "center",
    });
  } else {
    doc.font("Helvetica").fontSize(9);
    fitText(doc, order.parcelCode, row7SplitX + 8, y + 14, rightW - 16, 14, {
      align: "center",
    });
  }

  doc.end();

  return new Promise<string>((resolve, reject) => {
    stream.on("finish", () => resolve(filePath));
    stream.on("error", reject);
  });
}
