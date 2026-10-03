import dotenv from "dotenv";

dotenv.config();

export const env = {
  port: parseInt(process.env.PORT || "4000", 10),
  databaseUrl: process.env.DATABASE_URL || "",
  jwtSecret: process.env.JWT_SECRET || "dev-secret",
  frontendUrl: process.env.FRONTEND_URL || "http://localhost:3000",
  adminEmail: "admin@gmail.com",
  adminPassword: "123",
  /** Apex domain factories get a subdomain under, e.g. "acme.kayanflow.com". */
  rootDomain: process.env.ROOT_DOMAIN || "localhost:3000",
  stripe: {
    secretKey: process.env.STRIPE_SECRET_KEY || "",
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET || "",
  },
};

if (!env.databaseUrl) {
  throw new Error("DATABASE_URL is required");
}
