import sharp from "sharp";
import fs from "fs";
import path from "path";
import { pool } from "../config/db";
import { findProductById } from "./db.service";

const OUTPUT_DIR = path.join(__dirname, "../../uploads/mockups");

/**
 * Universal Image Loader:
 * 1. Reads local files on your server/disk (e.g. "/uploads/products/Double-wall-cup.jpg")
 * 2. Fetches public web links (http:// or https://) with content-type checking
 * 3. Sanitizes and decodes Base64 data URLs (stripping corrupted whitespace)
 */
async function fetchImageBuffer(imagePathOrUrl: string, label: string = "IMAGE"): Promise<Buffer> {
  const cleanInput = (imagePathOrUrl || "").trim();

  if (!cleanInput) {
    throw new Error(`[${label}] Image path or URL is empty!`);
  }

  // 1. Clean Base64 Handler (Removes corrupted spaces or line breaks)
  if (cleanInput.startsWith("data:")) {
    const parts = cleanInput.split(",");
    if (parts.length > 1) {
      const cleanBase64 = parts[1].replace(/[\s\r\n]+/g, ""); // Strips corrupted whitespace
      try {
        const buf = Buffer.from(cleanBase64, "base64");
        // Verify buffer has valid image header bytes
        if (buf.length < 10) throw new Error("Base64 buffer is too small to be an image");
        return buf;
      } catch (err) {
        throw new Error(`[${label}] Base64 image decoding failed: ${(err as Error).message}`);
      }
    }
  }

  // 2. Web Link (http:// or https://)
  if (cleanInput.startsWith("http://") || cleanInput.startsWith("https://")) {
    const response = await fetch(cleanInput);
    if (!response.ok) {
      throw new Error(`[${label}] Remote link returned HTTP status ${response.status}: ${cleanInput}`);
    }

    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("text/html") || contentType.includes("application/json")) {
      throw new Error(`[${label}] The URL returned a webpage/text, NOT an image file! Content-Type: ${contentType}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }

  // 3. Local File on Disk (e.g. "/uploads/products/Double-wall-cup.jpg")
  const cleanPath = cleanInput.replace(/^\//, ""); // Remove leading slash
  const localFilePath = path.join(__dirname, "../../", cleanPath);

  if (fs.existsSync(localFilePath)) {
    return fs.readFileSync(localFilePath);
  }

  // Fallback check from project root
  const rootPath = path.join(process.cwd(), cleanPath);
  if (fs.existsSync(rootPath)) {
    return fs.readFileSync(rootPath);
  }

  throw new Error(`[${label}] Local image file not found on disk: ${cleanInput}`);
}

export async function generateProductMockup(params: {
  factoryId: string;
  productId: string;
  logoUrl: string;
  leadId?: string;
}): Promise<string> {
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  // 1. Smart product lookup (Supports UUID, Exact Name, or Hyphenated Slug!)
  const product = await findProductById(params.productId, params.factoryId);
  if (!product || !product.image_url) {
    throw new Error(`Product blank image not found for product: ${params.productId}`);
  }
  const baseProductImageUrl = product.image_url;

  // 2. Load both images with clear diagnostic labels
  const productBuffer = await fetchImageBuffer(baseProductImageUrl, "PRODUCT");
  const logoBuffer = await fetchImageBuffer(params.logoUrl, "LOGO");

  // 3. Read product image dimensions
  const productMetadata = await sharp(productBuffer).metadata();
  const width = productMetadata.width || 800;
  const height = productMetadata.height || 800;

  // 4. Resize logo proportionally (35% of product width so it NEVER distorts!)
  const targetLogoWidth = Math.round(width * 0.35);
  const resizedLogo = await sharp(logoBuffer)
    .resize({ width: targetLogoWidth, fit: "inside" })
    .toBuffer();

  const logoMetadata = await sharp(resizedLogo).metadata();
  const logoWidth = logoMetadata.width || targetLogoWidth;
  const logoHeight = logoMetadata.height || targetLogoWidth;

  // 5. Smart Category Placement:
  // - Cups & Drinkware: 45% (visual eye-level sweet spot)
  // - Apparel & Hoodies: 32% (chest position)
  // - Boxes, Bags & Packaging: 50% (dead center of lid)
  let verticalRatio = 0.50;
  const category = (product.category || "").toLowerCase();

  if (category.includes("cup") || category.includes("drinkware") || category.includes("bottle")) {
    verticalRatio = 0.45;
  } else if (category.includes("apparel") || category.includes("hoodie") || category.includes("shirt")) {
    verticalRatio = 0.32;
  }

  const left = Math.round((width - logoWidth) / 2);
  const top = Math.round((height * verticalRatio) - (logoHeight / 2));

  // 6. Composite the logo cleanly onto the product
  const fileName = `mockup-${Date.now()}.png`;
  const filePath = path.join(OUTPUT_DIR, fileName);

  await sharp(productBuffer)
    // NEW:
    .composite([{ input: resizedLogo, top, left, blend: "multiply" }])
    .png({ quality: 95 })
    .toFile(filePath);

  const mockupUrl = `/uploads/mockups/${fileName}`;

  // 7. Save record permanently in PostgreSQL
  const dbClient = await pool.connect();
  try {
    await dbClient.query(
      `INSERT INTO mockups (factory_id, product_id, logo_url, generated_image_url, lead_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [params.factoryId, product.id, params.logoUrl, mockupUrl, params.leadId || null]
    );
  } finally {
    dbClient.release();
  }

  return mockupUrl;
}