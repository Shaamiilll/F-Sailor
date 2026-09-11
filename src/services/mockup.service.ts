import { GoogleGenAI } from "@google/genai";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { pool } from "../config/db";
import { findProductById } from "./db.service";
import { Mockup } from "../types";
import { env } from "../config/env";

/**
 * Uses Google's Gemini image model ("Nano Banana") to realistically place
 * a customer's logo onto a product photo — it blends the two images
 * together with lighting/angle/curvature taken into account, rather than
 * just pasting a flat sticker on top.
 *
 * Needs GEMINI_API_KEY set in .env (see setup guide).
 */

const OUTPUT_DIR = path.join(__dirname, "../../uploads/mockups");

const ai = new GoogleGenAI({ apiKey: env.geminiApiKey });

async function loadImageAsBase64(
  source: string
): Promise<{ data: string; mimeType: string }> {
  let buffer: Buffer;
  let mimeType = "image/png";

  if (source.startsWith("http")) {
    const response = await fetch(source); // Node 18+ has fetch built in
    buffer = Buffer.from(await response.arrayBuffer());
    const contentType = response.headers.get("content-type");
    if (contentType) mimeType = contentType;
  } else {
    buffer = fs.readFileSync(source);
    if (source.toLowerCase().endsWith(".jpg") || source.toLowerCase().endsWith(".jpeg")) {
      mimeType = "image/jpeg";
    }
  }

  return { data: buffer.toString("base64"), mimeType };
}

export async function createMockup(
  factoryId: string,
  params: { productId: string; leadId?: string; logoUrl: string }
): Promise<Mockup> {
  const product = await findProductById(params.productId, factoryId);
  if (!product) throw new Error("Product not found");

  const productImageUrl = (product as any).imageUrl;
  if (!productImageUrl) {
    throw new Error("This product has no base image uploaded yet");
  }

  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const productImagePath = path.join(
    __dirname,
    "../../",
    productImageUrl.replace(/^\//, "")
  );

  const [productImage, logoImage] = await Promise.all([
    loadImageAsBase64(productImagePath),
    loadImageAsBase64(params.logoUrl),
  ]);

  const response = await ai.models.generateContent({
    model: "gemini-2.5-flash-image",
    contents: [
      {
        role: "user",
        parts: [
          { inlineData: { data: productImage.data, mimeType: productImage.mimeType } },
          { inlineData: { data: logoImage.data, mimeType: logoImage.mimeType } },
          {
            text:
              "The first image is a product photo. The second image is a customer's logo. " +
              "Place the logo realistically onto the visible surface of the product, matching " +
              "the product's lighting, angle, and any curvature, as if it were printed or " +
              "stamped there. Keep the rest of the product photo unchanged.",
          },
        ],
      },
    ],
  });

  const parts = response.candidates?.[0]?.content?.parts || [];
  const imagePart = parts.find((p: any) => p.inlineData) as any;

  if (!imagePart) {
    throw new Error(
      "The AI model didn't return an image. Try a clearer product photo or logo."
    );
  }

  const mockupId = crypto.randomUUID();
  const fileName = `mockup-${mockupId}.png`;
  const filePath = path.join(OUTPUT_DIR, fileName);
  fs.writeFileSync(filePath, Buffer.from(imagePart.inlineData.data, "base64"));

  const generatedImageUrl = `/uploads/mockups/${fileName}`;

  const result = await pool.query(
    `INSERT INTO mockups (factory_id, lead_id, product_id, logo_url, generated_image_url)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [factoryId, params.leadId || null, params.productId, params.logoUrl, generatedImageUrl]
  );

  const row = result.rows[0];
  return {
    id: row.id,
    factoryId: row.factory_id,
    leadId: row.lead_id,
    productId: row.product_id,
    logoUrl: row.logo_url,
    generatedImageUrl: row.generated_image_url,
    createdAt: row.created_at,
  };
}
