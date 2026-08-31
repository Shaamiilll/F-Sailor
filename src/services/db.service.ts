import { pool } from "../config/db";
import { Factory, Product, User } from "../types";

function mapFactory(row: Record<string, unknown>): Factory {
  return {
    id: row.id as string,
    name: row.name as string,
    type: row.type as string,
    country: row.country as string,
    email: row.email as string,
    phone: row.phone as string,
    createdAt: row.created_at as Date,
  };
}

function mapUser(row: Record<string, unknown>): User {
  return {
    id: row.id as string,
    email: row.email as string,
    passwordHash: row.password_hash as string,
    role: row.role as User["role"],
    factoryId: row.factory_id as string | null,
    createdAt: row.created_at as Date,
  };
}

export function mapProduct(row: Record<string, unknown>): Product {
  return {
    id: row.id as string,
    factoryId: row.factory_id as string,
    name: row.name as string,
    category: row.category as string,
    specification: row.specification as string,
    capacity: row.capacity as string | null,
    material: row.material as string | null,
    dimensions: row.dimensions as string | null,
    gsm: row.gsm as string | null,
    wallType: row.wall_type as string | null,
    printingMethod: row.printing_method as string | null,
    moq: Number(row.moq),
    price: Number(row.price),
    currency: row.currency as string,
    leadTime: row.lead_time as string,
    description: row.description as string,
    status: row.status as Product["status"],
    size: row.size as string | null,
    createdAt: row.created_at as Date,
    updatedAt: row.updated_at as Date,
  };
}

export async function findUserByEmail(email: string): Promise<User | null> {
  const result = await pool.query("SELECT * FROM users WHERE email = $1", [
    email.toLowerCase(),
  ]);
  return result.rows[0] ? mapUser(result.rows[0]) : null;
}

export async function findUserById(id: string): Promise<User | null> {
  const result = await pool.query("SELECT * FROM users WHERE id = $1", [id]);
  return result.rows[0] ? mapUser(result.rows[0]) : null;
}

export async function findAllFactories(): Promise<Factory[]> {
  const result = await pool.query(
    "SELECT * FROM factories ORDER BY created_at DESC"
  );
  return result.rows.map(mapFactory);
}

export async function findFactoryById(id: string): Promise<Factory | null> {
  const result = await pool.query("SELECT * FROM factories WHERE id = $1", [id]);
  return result.rows[0] ? mapFactory(result.rows[0]) : null;
}

export async function createFactoryWithUser(
  factory: {
    name: string;
    type: string;
    country: string;
    email: string;
    phone: string;
  },
  passwordHash: string
): Promise<{ factory: Factory; user: User }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const factoryResult = await client.query(
      `INSERT INTO factories (name, type, country, email, phone)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [
        factory.name,
        factory.type,
        factory.country,
        factory.email.toLowerCase(),
        factory.phone,
      ]
    );

    const userResult = await client.query(
      `INSERT INTO users (email, password_hash, role, factory_id)
       VALUES ($1, $2, 'factory', $3)
       RETURNING *`,
      [factory.email.toLowerCase(), passwordHash, factoryResult.rows[0].id]
    );

    await client.query("COMMIT");

    return {
      factory: mapFactory(factoryResult.rows[0]),
      user: mapUser(userResult.rows[0]),
    };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function findProductsByFactory(factoryId: string): Promise<Product[]> {
  const result = await pool.query(
    "SELECT * FROM products WHERE factory_id = $1 ORDER BY created_at DESC",
    [factoryId]
  );
  return result.rows.map(mapProduct);
}

export async function findProductById(
  id: string,
  factoryId: string
): Promise<Product | null> {
  const result = await pool.query(
    "SELECT * FROM products WHERE id = $1 AND factory_id = $2",
    [id, factoryId]
  );
  return result.rows[0] ? mapProduct(result.rows[0]) : null;
}

export async function createProduct(
  factoryId: string,
  data: {
    name: string;
    category: string;
    specification: string;
    capacity?: string;
    material?: string;
    dimensions?: string;
    gsm?: string;
    wallType?: string;
    printingMethod?: string;
    moq: number;
    price: number;
    currency: string;
    leadTime: string;
    description: string;
    status: string;
    size?: string;
  }
): Promise<Product> {
  const result = await pool.query(
    `INSERT INTO products (
      factory_id, name, category, specification, capacity, material,
      dimensions, gsm, wall_type, printing_method, moq, price, currency,
      lead_time, description, status, size
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
    RETURNING *`,
    [
      factoryId,
      data.name,
      data.category,
      data.specification,
      data.capacity || null,
      data.material || null,
      data.dimensions || null,
      data.gsm || null,
      data.wallType || null,
      data.printingMethod || null,
      data.moq,
      data.price,
      data.currency,
      data.leadTime,
      data.description,
      data.status,
      data.size || null,
    ]
  );
  return mapProduct(result.rows[0]);
}

export async function updateProduct(
  id: string,
  factoryId: string,
  data: Partial<{
    name: string;
    category: string;
    specification: string;
    capacity: string;
    material: string;
    dimensions: string;
    gsm: string;
    wallType: string;
    printingMethod: string;
    moq: number;
    price: number;
    currency: string;
    leadTime: string;
    description: string;
    status: string;
    size: string;
  }>
): Promise<Product | null> {
  const fields: string[] = [];
  const values: unknown[] = [];
  let i = 1;

  const mapping: Record<string, string> = {
    name: "name",
    category: "category",
    specification: "specification",
    capacity: "capacity",
    material: "material",
    dimensions: "dimensions",
    gsm: "gsm",
    wallType: "wall_type",
    printingMethod: "printing_method",
    moq: "moq",
    price: "price",
    currency: "currency",
    leadTime: "lead_time",
    description: "description",
    status: "status",
    size: "size",
  };

  for (const [key, col] of Object.entries(mapping)) {
    if (key in data && data[key as keyof typeof data] !== undefined) {
      fields.push(`${col} = $${i++}`);
      values.push(data[key as keyof typeof data]);
    }
  }

  if (fields.length === 0) return findProductById(id, factoryId);

  fields.push(`updated_at = NOW()`);
  values.push(id, factoryId);

  const result = await pool.query(
    `UPDATE products SET ${fields.join(", ")}
     WHERE id = $${i++} AND factory_id = $${i}
     RETURNING *`,
    values
  );
  return result.rows[0] ? mapProduct(result.rows[0]) : null;
}

export async function deleteProduct(
  id: string,
  factoryId: string
): Promise<boolean> {
  const result = await pool.query(
    "DELETE FROM products WHERE id = $1 AND factory_id = $2",
    [id, factoryId]
  );
  return (result.rowCount ?? 0) > 0;
}

export function productToResponse(product: Product) {
  return {
    id: product.id,
    name: product.name,
    category: product.category,
    specification: product.specification,
    capacity: product.capacity ?? undefined,
    material: product.material ?? undefined,
    dimensions: product.dimensions ?? undefined,
    gsm: product.gsm ?? undefined,
    wallType: product.wallType ?? undefined,
    printingMethod: product.printingMethod ?? undefined,
    moq: product.moq,
    price: product.price,
    currency: product.currency,
    leadTime: product.leadTime,
    description: product.description,
    status: product.status,
    size: product.size ?? undefined,
  };
}
