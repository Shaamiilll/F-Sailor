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
  paddle: {
    apiKey: process.env.PADDLE_API_KEY || "",
    /** Secret for the notification destination that posts to our webhook. */
    webhookSecret: process.env.PADDLE_WEBHOOK_SECRET || "",
    /** "sandbox" (default) or "production". These are separate Paddle accounts. */
    environment: process.env.PADDLE_ENVIRONMENT || "sandbox",
    /**
     * The currency plan prices are created in. Paddle converts for the buyer,
     * so this is the base, not a restriction on who can pay.
     */
    currency: process.env.PADDLE_CURRENCY || "USD",
  },
};

if (!env.databaseUrl) {
  throw new Error("DATABASE_URL is required");
}
