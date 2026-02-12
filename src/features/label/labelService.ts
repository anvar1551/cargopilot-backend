import PDFDocument from "pdfkit";
import QRCode from "qrcode";
import fs from "fs";
import path from "path";

// Use ONE of these, depending on your setup:
// import bwipjs from "bwip-js";
const bwipjs = require("bwip-js");

type OrderLabelInput = {
  parcelCode: string; // the code to encode in barcode/QR
  pickupAddress: string;
  dropoffAddress: string;
  destinationCity?: string;
  pieceLabel?: string;
  codAmount?: string | null;
  currency?: string | null;
  // piece info for label: "Shipment: 1/3"
  pieceNo: number;
  pieceTotal: number;

  weightKg?: number;
  serviceType?: string; // "DOOR TO DOOR"
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
  lw = 1.4,
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
  lw = 1.2,
) {
  doc.save();
  doc
    .lineWidth(lw)
    .moveTo(x, y)
    .lineTo(x, y + h)
    .stroke();
  doc.restore();
}

function hline(
  doc: PDFKit.PDFDocument,
  x: number,
  y: number,
  w: number,
  lw = 1.2,
) {
  doc.save();
  doc
    .lineWidth(lw)
    .moveTo(x, y)
    .lineTo(x + w, y)
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

export async function generateLabelPDF(order: OrderLabelInput) {
  const outputDir = path.resolve("labels");
  ensureDir(outputDir);

  const safeParcelCode = order.parcelCode.replace(/[\\/]/g, "-");
  const filePath = path.join(outputDir, `${safeParcelCode}.pdf`);

  const doc = new PDFDocument({ size: "A6", margin: 18, layout: "portrait" });
  const stream = fs.createWriteStream(filePath);
  doc.pipe(stream);

  const m = doc.page.margins.left;
  const W = doc.page.width - m * 2;

  let y = m;

  // --- BARCODE (safe) ---
  let barcodePng: Buffer | null = null;
  try {
    barcodePng = await bwipjs.toBuffer({
      bcid: "code128",
      text: order.parcelCode,
      scale: 2,
      height: 10,
      includetext: false,
    });
  } catch {
    barcodePng = null;
  }

  // ========== ROW 1: Shipment + barcode ==========
  const row1H = 44;
  box(doc, m, y, W, row1H);

  doc.font("Helvetica-Bold").fontSize(12);
  fitText(
    doc,
    order.pieceLabel || `Shipment: ${order.pieceNo}/${order.pieceTotal}`,
    m + 10,
    y + 14,
    110,
    18,
  );

  if (barcodePng) {
    doc.image(barcodePng, m + 130, y + 10, { width: W - 140, height: 26 });
  }

  y += row1H + 10;

  // ========== ROW 2: COD + Service ==========
  const row2H = 86;
  box(doc, m, y, W, row2H);

  const midX = m + Math.round(W * 0.55);
  vline(doc, midX, y, row2H);

  // left COD
  doc.font("Helvetica-Bold").fontSize(10);
  fitText(doc, "COD Total", m + 10, y + 10, midX - m - 20, 14);

  doc.font("Helvetica-Bold").fontSize(26);
  fitText(doc, order.codAmount || "0.00", m + 10, y + 28, midX - m - 20, 30);

  doc.font("Helvetica").fontSize(12);
  fitText(
    doc,
    `${order.currency || "UZS"}`,
    m + 10,
    y + 62,
    midX - m - 20,
    18,
    {
      fill: "#6B7280",
    } as any,
  );

  // right service
  doc.font("Helvetica-Bold").fontSize(10);
  fitText(doc, "Service Type", midX + 10, y + 10, m + W - (midX + 20), 14);

  doc.font("Helvetica-Bold").fontSize(10);
  fitText(
    doc,
    order.serviceType || "DOOR TO DOOR",
    midX + 10,
    y + 26,
    m + W - (midX + 20),
    18,
  );

  doc.font("Helvetica-Bold").fontSize(12);
  fitText(
    doc,
    `Weight     ${order.weightKg ?? 1} kg`,
    midX + 10,
    y + 56,
    m + W - (midX + 20),
    16,
  );

  y += row2H + 10;

  // ========== ROW 3: Sender/Receiver ==========
  const row3H = 120; // Reduced from 140
  box(doc, m, y, W, row3H);

  const splitY = y + Math.floor(row3H / 2);
  hline(doc, m, splitY, W);

  const padX = 10;
  const colW = W - padX * 2;

  // Sender (TOP HALF)
  doc.font("Helvetica-Bold").fontSize(10);
  fitText(doc, "From / Sender", m + padX, y + 8, colW, 12);

  doc.font("Helvetica").fontSize(11);
  fitText(doc, `Address: ${order.pickupAddress}`, m + padX, y + 24, colW, 28);

  doc.font("Helvetica").fontSize(10);
  fitText(
    doc,
    `Phone: ${order.senderPhone ?? "—"}`,
    m + padX,
    y + 44,
    colW,
    12,
  );

  // Receiver (BOTTOM HALF)
  doc.font("Helvetica-Bold").fontSize(10);
  fitText(doc, "To / Receiver", m + padX, splitY + 8, colW, 12);

  doc.font("Helvetica-Bold").fontSize(14);
  fitText(
    doc,
    order.receiverName || "Customer",
    m + padX,
    splitY + 24,
    colW,
    18,
  );

  doc.font("Helvetica").fontSize(11);
  fitText(
    doc,
    `Address: ${order.dropoffAddress}`,
    m + padX,
    splitY + 44,
    colW,
    20,
  );

  y += row3H + 10;

  // ========== ROW 4: Destination + QR ==========
  const row4H = 110; // Reduced from 130
  box(doc, m, y, W, row4H);

  const leftW = Math.round(W * 0.58);
  vline(doc, m + leftW, y, row4H);

  doc.font("Helvetica-Bold").fontSize(10);
  fitText(doc, "Destination city", m + 10, y + 10, leftW - 20, 12);

  doc.font("Helvetica-Bold").fontSize(28); // Reduced from 32
  fitText(doc, order.destinationCity || "—", m + 10, y + 28, leftW - 20, 36);

  // right: QR
  doc.font("Helvetica-Bold").fontSize(10);
  fitText(doc, "Scan", m + leftW + 10, y + 10, W - leftW - 20, 12);

  const qrBuffer = await QRCode.toBuffer(order.parcelCode, {
    margin: 1,
    scale: 6,
  });
  doc.image(qrBuffer, m + leftW + 10, y + 26, {
    width: W - leftW - 20,
    height: 70, // Reduced from 88
  });

  doc.end();

  return new Promise<string>((resolve, reject) => {
    stream.on("finish", () => resolve(filePath));
    stream.on("error", reject);
  });
}

// import QRCode from "qrcode";
// import fs from "fs";
// import path from "path";
// import PDFDocument from "pdfkit";
// export async function generateLabelPDF(order: {
//   id: string;
//   pickupAddress: string;
//   dropoffAddress: string;
// }) {
//   const outputDir = path.resolve("labels");
//   if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir);
//   const filePath = path.join(outputDir, `${order.id}.pdf`);
//   const doc = new PDFDocument({ size: "A6", margin: 20 });
//   const stream = fs.createWriteStream(filePath);
//   doc.pipe(stream);
//   doc.fontSize(14).text("CargoPilot Shipping Label", { align: "center" });
//   doc.moveDown();
//   doc.fontSize(10).text(`Order ID: ${order.id}`);
//   doc.text(`Pickup: ${order.pickupAddress}`);
//   doc.text(`Dropoff: ${order.dropoffAddress}`);
//   doc.moveDown();
//   const qrBuffer = await QRCode.toBuffer(order.id);
//   doc.image(qrBuffer, { fit: [100, 100], align: "center" });
//   doc.end();
//   return new Promise((resolve) => {
//     stream.on("finish", () => resolve(filePath));
//   });
// }
