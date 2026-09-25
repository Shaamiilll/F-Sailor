import PDFDocument from "pdfkit";
import fs from "fs";
import path from "path";

const OUTPUT_DIR = path.join(__dirname, "../../uploads/quotations");

export interface QuotationPdfLine {
  productName: string;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
  customization?: string | null;
}

export interface QuotationPdfParams {
  quotationId: string;
  factoryName: string;
  factoryLogoPath?: string | null;
  factoryEmail?: string;
  factoryPhone?: string;
  factoryCountry?: string;
  /** Single-product summary, kept for the chat/n8n callers that only have this. */
  productName: string;
  quantity: number;
  unitPrice: number;
  discountPercent: number;
  discountAmount: number;
  shippingCost: number;
  totalPrice: number;
  currency: string;
  leadName?: string | null;
  leadCompany?: string | null;
  leadEmail?: string | null;
  /** Multi-item quotations pass their real line items here. */
  items?: QuotationPdfLine[];
  subtotal?: number;
  setupFees?: number;
  quoteNumber?: string | null;
  validUntil?: string | null;
  tradeTerm?: string | null;
  validityDays?: number;
}

// Helper to fetch image from URL or read from local disk
async function getImageBuffer(imagePathOrUrl?: string | null): Promise<Buffer | null> {
  if (!imagePathOrUrl) return null;
  try {
    if (imagePathOrUrl.startsWith("http://") || imagePathOrUrl.startsWith("https://")) {
      const response = await fetch(imagePathOrUrl);
      if (!response.ok) return null;
      const arrayBuffer = await response.arrayBuffer();
      return Buffer.from(arrayBuffer);
    } else if (fs.existsSync(imagePathOrUrl)) {
      return fs.readFileSync(imagePathOrUrl);
    }
  } catch {
    return null;
  }
  return null;
}

function money(value: number, maxDecimals = 2): string {
  return Number(value).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: maxDecimals,
  });
}

function formatDate(date: Date): string {
  return date.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export async function generateQuotationPdf(params: QuotationPdfParams): Promise<string> {
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  // Multi-item quotations pass real lines. The chat/n8n gateway only knows about
  // one product, so synthesise a single line from the flat params instead.
  const lines: QuotationPdfLine[] =
    params.items && params.items.length > 0
      ? params.items
      : [
          {
            productName: params.productName,
            quantity: params.quantity,
            unitPrice: params.unitPrice,
            lineTotal: params.unitPrice * params.quantity,
          },
        ];

  const subtotal = params.subtotal ?? lines.reduce((sum, l) => sum + l.lineTotal, 0);
  const setupFees = params.setupFees ?? 0;
  const freight = params.shippingCost;
  const validityDays = params.validityDays ?? 30;

  const fileName = `quotation-${params.quotationId}.pdf`;
  const filePath = path.join(OUTPUT_DIR, fileName);

  const doc = new PDFDocument({ margin: 40, size: "A4" });
  const stream = fs.createWriteStream(filePath);
  doc.pipe(stream);

  const primaryColor = "#0F172A"; // Slate 900
  const secondaryColor = "#475569"; // Slate 600
  const lightBg = "#F1F5F9"; // Slate 100
  const accentColor = "#2563EB"; // Royal Blue accent

  // 1. HEADER SECTION (Logo + Factory Name & Details)
  let headerTop = 40;
  const logoBuffer = await getImageBuffer(params.factoryLogoPath);

  if (logoBuffer) {
    try {
      doc.image(logoBuffer, 40, headerTop, { width: 80, height: 50, fit: [80, 50] });
    } catch {
      // Graceful fallback if image format is unsupported
    }
  }

  // Factory Title & Info
  doc
    .fillColor(primaryColor)
    .font("Helvetica-Bold")
    .fontSize(16)
    .text(params.factoryName, 135, headerTop)
    .font("Helvetica")
    .fontSize(9)
    .fillColor(secondaryColor)
    .text(params.factoryEmail || "sales@factory.com", 135, headerTop + 22)
    .text(params.factoryCountry ? `Country: ${params.factoryCountry}` : "", 135, headerTop + 34);

  // QUOTATION Badge on the right
  doc
    .fillColor(primaryColor)
    .font("Helvetica-Bold")
    .fontSize(20)
    .text("PRICE QUOTE", 350, headerTop, { align: "right" })
    .fontSize(9)
    .font("Helvetica")
    .fillColor(secondaryColor)
    .text(
      `Quote #: ${params.quoteNumber || params.quotationId.substring(0, 8).toUpperCase()}`,
      350,
      headerTop + 24,
      { align: "right" }
    )
    .text(`Date: ${formatDate(new Date())}`, 350, headerTop + 36, { align: "right" })
    .text(
      params.validUntil
        ? `Valid Until: ${formatDate(new Date(params.validUntil))}`
        : `Valid For: ${validityDays} Days`,
      350,
      headerTop + 48,
      { align: "right" }
    );

  // Divider Line
  doc.strokeColor("#E2E8F0").lineWidth(1).moveTo(40, 105).lineTo(555, 105).stroke();

  // 2. "PREPARED FOR" SECTION
  doc.rect(40, 120, 515, 55).fill(lightBg);

  doc
    .fillColor(secondaryColor)
    .font("Helvetica-Bold")
    .fontSize(8)
    .text("PREPARED FOR:", 55, 130)
    .fillColor(primaryColor)
    .font("Helvetica-Bold")
    .fontSize(11)
    .text(params.leadName || "Valued Client", 55, 142)
    .font("Helvetica")
    .fontSize(9)
    .fillColor(secondaryColor)
    .text(params.leadCompany ? `Company: ${params.leadCompany}` : (params.leadEmail || ""), 55, 156);

  // 3. PRODUCT TABLE
  const tableTop = 195;
  // Table Header Bar
  doc.rect(40, tableTop, 515, 25).fill(primaryColor);

  doc
    .fillColor("#FFFFFF")
    .font("Helvetica-Bold")
    .fontSize(9)
    .text("ITEM / DESCRIPTION", 55, tableTop + 8)
    .text("QTY", 320, tableTop + 8, { width: 50, align: "center" })
    .text("UNIT PRICE", 380, tableTop + 8, { width: 80, align: "right" })
    .text("AMOUNT", 470, tableTop + 8, { width: 75, align: "right" });

  // Table Rows -- one per quotation line item
  let rowTop = tableTop + 32;

  for (const line of lines) {
    doc
      .fillColor(primaryColor)
      .font("Helvetica-Bold")
      .fontSize(10)
      .text(line.productName, 55, rowTop, { width: 255 })
      .font("Helvetica")
      .fontSize(9)
      .fillColor(secondaryColor)
      .text(
        line.customization || "Custom production as per specifications",
        55,
        rowTop + 14,
        { width: 255 }
      )
      .text(line.quantity.toLocaleString("en-US"), 320, rowTop + 5, {
        width: 50,
        align: "center",
      })
      .text(`${params.currency} ${money(line.unitPrice, 4)}`, 380, rowTop + 5, {
        width: 80,
        align: "right",
      })
      .font("Helvetica-Bold")
      .fillColor(primaryColor)
      .text(`${params.currency} ${money(line.lineTotal)}`, 470, rowTop + 5, {
        width: 75,
        align: "right",
      });

    doc
      .strokeColor("#E2E8F0")
      .lineWidth(1)
      .moveTo(40, rowTop + 32)
      .lineTo(555, rowTop + 32)
      .stroke();

    rowTop += 42;
  }

  // 4. SUMMARY / TOTALS SECTION
  let totalsY = rowTop + 15;

  const drawSummaryLine = (label: string, value: string, isBold: boolean = false) => {
    doc
      .font(isBold ? "Helvetica-Bold" : "Helvetica")
      .fontSize(9)
      .fillColor(isBold ? primaryColor : secondaryColor)
      .text(label, 330, totalsY)
      .text(value, 450, totalsY, { width: 95, align: "right" });
    totalsY += 18;
  };

  drawSummaryLine("Subtotal", `${params.currency} ${money(subtotal)}`);

  if (params.discountPercent > 0) {
    drawSummaryLine(
      `Volume Discount (${params.discountPercent}%)`,
      `-${params.currency} ${money(params.discountAmount)}`
    );
  }

  if (setupFees > 0) {
    drawSummaryLine("Tooling & Plate Setup", `${params.currency} ${money(setupFees)}`);
  }

  if (freight > 0) {
    drawSummaryLine(
      params.tradeTerm ? `Freight (${params.tradeTerm})` : "Estimated Shipping",
      `${params.currency} ${money(freight)}`
    );
  } else if (params.tradeTerm) {
    drawSummaryLine(`Freight (${params.tradeTerm})`, "Not included");
  }

  // Grand Total Highlight Box
  totalsY += 5;
  doc.rect(320, totalsY, 235, 32).fill(accentColor);
  doc
    .fillColor("#FFFFFF")
    .font("Helvetica-Bold")
    .fontSize(11)
    .text("GRAND TOTAL", 335, totalsY + 10)
    .fontSize(12)
    .text(`${params.currency} ${money(params.totalPrice)}`, 430, totalsY + 10, {
      width: 115,
      align: "right",
    });

  // 5. FOOTER & TERMS
  const footerY = 740;
  doc.strokeColor("#E2E8F0").lineWidth(1).moveTo(40, footerY).lineTo(555, footerY).stroke();

  doc
    .fillColor(secondaryColor)
    .font("Helvetica")
    .fontSize(8)
    .text("Terms & Conditions:", 40, footerY + 10)
    .text(
      `• Quotation is valid for ${validityDays} calendar days from the date of issue.`,
      40,
      footerY + 22
    )
    .text("• Production initiates upon formal confirmation and deposit approval.", 40, footerY + 32)
    .font("Helvetica-Bold")
    .text(`Thank you for choosing ${params.factoryName}!`, 40, footerY + 46, { align: "center" });

  doc.end();

  await new Promise<void>((resolve) => stream.on("finish", () => resolve()));
  return `/uploads/quotations/${fileName}`;
}

// 6. Sleek HTML Email template generator for n8n
export function generateQuotationEmailHtml(params: QuotationPdfParams, pdfDownloadUrl: string): string {
  return `
  <!DOCTYPE html>
  <html>
  <head>
    <meta charset="utf-8">
    <style>
      body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f8fafc; margin: 0; padding: 20px; }
      .container { max-width: 600px; margin: 0 auto; background: #ffffff; border-radius: 8px; border: 1px solid #e2e8f0; overflow: hidden; }
      .header { background: #0f172a; color: #ffffff; padding: 24px; text-align: center; }
      .header h1 { margin: 0; font-size: 22px; font-weight: 600; }
      .content { padding: 24px; color: #334155; line-height: 1.6; }
      .card { background: #f1f5f9; border-radius: 6px; padding: 16px; margin: 20px 0; }
      .row { display: flex; justify-content: space-between; margin-bottom: 8px; font-size: 14px; }
      .total-row { display: flex; justify-content: space-between; margin-top: 12px; padding-top: 12px; border-top: 2px solid #cbd5e1; font-weight: bold; font-size: 16px; color: #0f172a; }
      .btn { display: block; text-align: center; background: #2563eb; color: #ffffff !important; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-weight: 600; margin: 24px 0; }
      .footer { text-align: center; font-size: 12px; color: #94a3b8; padding: 16px; }
    </style>
  </head>
  <body>
    <div class="container">
      <div class="header">
        <h1>${params.factoryName}</h1>
      </div>
      <div class="content">
        <p>Dear <strong>${params.leadName || "Customer"}</strong>,</p>
        <p>Thank you for inquiring about custom production. We have prepared an official quote based on your request:</p>
        
        <div class="card">
          <div class="row"><span><strong>Product:</strong></span><span>${params.productName}</span></div>
          <div class="row"><span><strong>Quantity:</strong></span><span>${params.quantity} units</span></div>
          <div class="row"><span><strong>Unit Price:</strong></span><span>${params.currency} ${params.unitPrice.toFixed(2)}</span></div>
          ${params.discountPercent > 0 ? `<div class="row" style="color: #16a34a;"><span><strong>Discount (${params.discountPercent}%):</strong></span><span>-${params.currency} ${params.discountAmount.toFixed(2)}</span></div>` : ''}
          <div class="row"><span><strong>Shipping:</strong></span><span>${params.currency} ${params.shippingCost.toFixed(2)}</span></div>
          <div class="total-row"><span>Grand Total:</span><span>${params.currency} ${params.totalPrice.toFixed(2)}</span></div>
        </div>

        <a href="${pdfDownloadUrl}" class="btn">Download Official PDF Quotation</a>

        <p>This quotation is valid for 30 days. Feel free to reply directly to this email if you have any questions.</p>
      </div>
      <div class="footer">
        © ${new Date().getFullYear()} ${params.factoryName}. All rights reserved.
      </div>
    </div>
  </body>
  </html>
  `;
}