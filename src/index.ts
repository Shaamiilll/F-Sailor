import express from "express";
import cors from "cors";
import { env } from "./config/env";
import authRoutes from "./routes/auth.routes";
import adminRoutes from "./routes/admin.routes";
import productRoutes from "./routes/product.routes";
import chatRoutes from "./routes/chat.routes";

const app = express();

app.use(
  cors({
    origin: env.frontendUrl,
    credentials: true,
  })
);
app.use(express.json());
app.use("/api/chat", chatRoutes);
app.use("/uploads", express.static("uploads"));

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.use("/api/auth", authRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/products", productRoutes);

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
