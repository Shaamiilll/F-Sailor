import express from "express";
import cors from "cors";
import { env } from "./config/env";
import authRoutes from "./routes/auth.routes";
import adminRoutes from "./routes/admin.routes";
import productRoutes from "./routes/product.routes";
import chatRoutes from "./routes/chat.routes";
import quoteDashboardRoutes from "./routes/quote-dashboard.routes";

const app = express();

// NEW: Universal CORS + 25MB Photo Upload Support!
app.use(
  cors({
    origin: true, // Allows Vercel, localhost:3000, and local preview tests without CORS blocks!
    credentials: true,
  })
);

// Allow photos up to 25MB (Prevents "Payload Too Large" errors!)
app.use(express.json({ limit: "25mb" }));
app.use(express.urlencoded({ limit: "25mb", extended: true }));
app.use("/api/chat", chatRoutes);
app.use("/uploads", express.static("uploads"));

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.use("/api/auth", authRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/products", productRoutes);
app.use("/api/quotations", quoteDashboardRoutes);
app.use((_req, res) => {
  res.status(404).json({ error: "Not found" });
});

app.use(
  (
    err: Error,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction
  ) => {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
);

app.listen(env.port, () => {
  console.log(`Server running on http://localhost:${env.port}`);
});
