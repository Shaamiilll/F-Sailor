import dotenv from "dotenv";

dotenv.config();

export const env = {
  port: parseInt(process.env.PORT || "4000", 10),
  databaseUrl: process.env.DATABASE_URL || "",
  jwtSecret: process.env.JWT_SECRET || "dev-secret",
  frontendUrl: process.env.FRONTEND_URL || "http://localhost:3000",
  adminEmail: "admin@gmail.com",
  adminPassword: "123",
};

if (!env.databaseUrl) {
  throw new Error("DATABASE_URL is required");
}
