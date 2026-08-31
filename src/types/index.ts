export type UserRole = "admin" | "factory";

export interface User {
  id: string;
  email: string;
  passwordHash: string;
  role: UserRole;
  factoryId: string | null;
  createdAt: Date;
}

export interface Factory {
  id: string;
  name: string;
  type: string;
  country: string;
  email: string;
  phone: string;
  createdAt: Date;
}

export type ProductStatus = "active" | "inactive" | "draft";

export interface Product {
  id: string;
  factoryId: string;
  name: string;
  category: string;
  specification: string;
  capacity: string | null;
  material: string | null;
  dimensions: string | null;
  gsm: string | null;
  wallType: string | null;
  printingMethod: string | null;
  moq: number;
  price: number;
  currency: string;
  leadTime: string;
  description: string;
  status: ProductStatus;
  size: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface JwtPayload {
  userId: string;
  email: string;
  role: UserRole;
  factoryId: string | null;
}

export interface CreateFactoryInput {
  name: string;
  type: string;
  country: string;
  email: string;
  phone: string;
  password: string;
}

export interface CreateProductInput {
  name: string;
  category: string;
  specification?: string;
  capacity?: string;
  material?: string;
  dimensions?: string;
  gsm?: string;
  wallType?: string;
  printingMethod?: string;
  moq: number;
  price: number;
  currency?: string;
  leadTime: string;
  description?: string;
  status?: ProductStatus;
  size?: string;
}

export interface UpdateProductInput extends Partial<CreateProductInput> {}
