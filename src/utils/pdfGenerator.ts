import fs from "fs";
import path from "path";
import PDFDocument from "pdfkit";
import QRCode from "qrcode";

interface InvoiceData {
  invoiceId: string;
  orderId: string;
  customerEmail: string;
  amount: number;
  createdAt: Date;
}

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

export async function generateInvoicePDF(data: InvoiceData): Promise<string> {
  const outputDir = path.resolve("invoices");
  ensureDir(outputDir);

  const filePath = path.join(outputDir, `${data.invoiceId}.pdf`);

  const doc = new PDFDocument({ size: "A4", margin: 20, layout: "portrait" });
  const stream = fs.createWriteStream(filePath);
  doc.pipe(stream);

  const m = doc.page.margins.left;
  const W = doc.page.width - m * 2;

  let y = m;

  // ========== HEADER: Company + Invoice Info ==========
  const headerH = 80;
  box(doc, m, y, W, headerH);

  doc.font("Helvetica-Bold").fontSize(24);
  fitText(doc, "CargoPilot", m + 20, y + 15, 200, 30);

  doc.font("Helvetica").fontSize(10);
  fitText(doc, "Shipping & Logistics Solutions", m + 20, y + 48, 200, 14, {
    fill: "#6B7280",
  } as any);

  // Right side invoice details
  doc.font("Helvetica-Bold").fontSize(10);
  fitText(doc, "INVOICE", W - 120, y + 15, 100, 14, { align: "right" });

  doc.font("Helvetica").fontSize(9);
  fitText(doc, `Invoice #: ${data.invoiceId}`, W - 120, y + 32, 100, 12, {
    align: "right",
  });
  fitText(doc, `Order #: ${data.orderId}`, W - 120, y + 46, 100, 12, {
    align: "right",
  });
  fitText(
    doc,
    `Date: ${data.createdAt.toLocaleDateString("en-DE")}`,
    W - 120,
    y + 60,
    100,
    12,
    { align: "right" },
  );

  y += headerH + 15;

  // ========== SECTION 1: Bill To & QR ==========
  const section1H = 100;
  box(doc, m, y, W, section1H);

  const qrW = 100;
  vline(doc, W - qrW - 20, y, section1H);

  // Left: Bill To
  doc.font("Helvetica-Bold").fontSize(11);
  fitText(doc, "BILL TO", m + 15, y + 12, W - qrW - 50, 14);

  doc.font("Helvetica").fontSize(10);
  fitText(
    doc,
    `Email: ${data.customerEmail}`,
    m + 15,
    y + 32,
    W - qrW - 50,
    12,
  );
  fitText(doc, "Payment Method: Stripe", m + 15, y + 48, W - qrW - 50, 12);
  fitText(doc, "Status: PAID ✓", m + 15, y + 64, W - qrW - 50, 14, {
    fill: "#10B981",
  } as any);

  // Right: QR Code
  doc.font("Helvetica-Bold").fontSize(9);
  fitText(doc, "Track Order", W - qrW - 10, y + 12, qrW - 10, 12, {
    align: "center",
  });

  const qrBuffer = await QRCode.toBuffer(data.orderId, { margin: 1, scale: 4 });
  doc.image(qrBuffer, W - qrW - 5, y + 28, {
    width: qrW - 10,
    height: qrW - 10,
  });

  y += section1H + 15;

  // ========== SECTION 2: Amount Breakdown ==========
  const section2H = 120;
  box(doc, m, y, W, section2H);

  const col1 = m + 20;
  const col2 = m + W * 0.6;

  // Left column: Item details
  doc.font("Helvetica-Bold").fontSize(10);
  fitText(doc, "SHIPMENT DETAILS", col1, y + 12, W * 0.4, 14);

  doc.font("Helvetica").fontSize(9);
  fitText(doc, "Shipping Service", col1, y + 32, W * 0.4, 11);
  fitText(doc, "Door to Door Delivery", col1, y + 48, W * 0.4, 11);
  fitText(doc, "Order Processing", col1, y + 64, W * 0.4, 11);
  fitText(doc, "Documentation", col1, y + 80, W * 0.4, 11);

  // Right column: Pricing
  doc.font("Helvetica-Bold").fontSize(10);
  fitText(doc, "AMOUNT SUMMARY", col2, y + 12, W * 0.35, 14);

  hline(doc, col2, y + 30, W * 0.35);

  doc.font("Helvetica").fontSize(9);
  fitText(doc, "Subtotal:", col2, y + 36, W * 0.25, 11);
  fitText(
    doc,
    `€${(data.amount * 0.9).toFixed(2)}`,
    col2 + W * 0.2,
    y + 36,
    W * 0.15,
    11,
    { align: "right" },
  );

  fitText(doc, "VAT (7%):", col2, y + 52, W * 0.25, 11);
  fitText(
    doc,
    `€${(data.amount * 0.07).toFixed(2)}`,
    col2 + W * 0.2,
    y + 52,
    W * 0.15,
    11,
    { align: "right" },
  );

  hline(doc, col2, y + 68, W * 0.35);

  doc.font("Helvetica-Bold").fontSize(12);
  fitText(doc, "TOTAL:", col2, y + 75, W * 0.25, 14);
  fitText(
    doc,
    `€${data.amount.toFixed(2)}`,
    col2 + W * 0.2,
    y + 75,
    W * 0.15,
    14,
    {
      align: "right",
    },
  );

  y += section2H + 15;

  // ========== SECTION 3: Footer ==========
  const footerH = 60;
  box(doc, m, y, W, footerH);

  doc.font("Helvetica-Bold").fontSize(10);
  fitText(doc, "THANK YOU FOR YOUR BUSINESS", m + 15, y + 12, W - 30, 14, {
    align: "center",
  });

  doc.font("Helvetica").fontSize(9);
  fitText(
    doc,
    "For support, contact us at support@cargopilot.com | +49 40 1234 5678",
    m + 15,
    y + 32,
    W - 30,
    12,
    { align: "center" },
  ) as any;

  doc.end();

  return new Promise((resolve, reject) => {
    stream.on("finish", () => resolve(filePath));
    stream.on("error", reject);
  });
}
