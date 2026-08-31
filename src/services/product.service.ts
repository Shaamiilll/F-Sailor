import {
  findProductsByFactory,
  findProductById,
  createProduct,
  updateProduct,
  deleteProduct,
  productToResponse,
} from "./db.service";
import { CreateProductInput, UpdateProductInput } from "../types";

function buildSpecification(data: CreateProductInput): string {
  if (data.specification) return data.specification;
  const parts = [data.capacity, data.wallType].filter(Boolean);
  return parts.length > 0 ? parts.join(" / ") : data.name;
}

export async function listProducts(factoryId: string) {
  const products = await findProductsByFactory(factoryId);
  return products.map(productToResponse);
}

export async function getProduct(factoryId: string, productId: string) {
  const product = await findProductById(productId, factoryId);
  if (!product) throw new Error("Product not found");
  return productToResponse(product);
}

export async function addProduct(factoryId: string, input: CreateProductInput) {
  const product = await createProduct(factoryId, {
    name: input.name,
    category: input.category,
    specification: buildSpecification(input),
    capacity: input.capacity,
    material: input.material,
    dimensions: input.dimensions,
    gsm: input.gsm,
    wallType: input.wallType,
    printingMethod: input.printingMethod,
    moq: input.moq,
    price: input.price,
    currency: input.currency || "USD",
    leadTime: input.leadTime,
    description: input.description || "",
    status: input.status || "active",
    size: input.size || input.capacity,
  });
  return productToResponse(product);
}

export async function editProduct(
  factoryId: string,
  productId: string,
  input: UpdateProductInput
) {
  const existing = await findProductById(productId, factoryId);
  if (!existing) throw new Error("Product not found");

  const product = await updateProduct(productId, factoryId, input);
  if (!product) throw new Error("Product not found");
  return productToResponse(product);
}

export async function removeProduct(factoryId: string, productId: string) {
  const deleted = await deleteProduct(productId, factoryId);
  if (!deleted) throw new Error("Product not found");
  return { success: true };
}
