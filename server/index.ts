import path from "node:path";
import { existsSync } from "node:fs";
import express from "express";
import cors from "cors";
import { createApiRouter, authMiddleware, errorHandler } from "./routes.js";
import { ensureDataRoot, listProjects } from "./lib/storage.js";
import { processProjectQueue } from "./lib/ingest.js";

const port = Number(process.env.PORT || 3000);
const app = express();

await ensureDataRoot();

app.use(cors());
app.use(express.json({ limit: "20mb" }));
app.use(express.urlencoded({ extended: true, limit: "20mb" }));
app.use("/api/v1", authMiddleware, createApiRouter());
app.use("/api", authMiddleware, createApiRouter());
app.use("/api", authMiddleware, (_req, res) => {
  res.status(404).json({ error: "API route not found" });
});

const clientDir = path.resolve("dist/client");
if (existsSync(clientDir)) {
  app.use(express.static(clientDir, {
    setHeaders(res, filePath) {
      if (filePath.endsWith("index.html")) {
        res.setHeader("cache-control", "no-store");
      }
    }
  }));
  app.get(/.*/, (_req, res) => {
    res.setHeader("cache-control", "no-store");
    res.sendFile(path.join(clientDir, "index.html"));
  });
}

app.use(errorHandler);

const projects = await listProjects();
for (const project of projects) {
  processProjectQueue(project).catch((error) => console.error("[startup] queue resume failed", error));
}

const server = app.listen(port, "0.0.0.0", () => {
  console.log(`LLM Wiki Web listening on http://0.0.0.0:${port}`);
});

server.requestTimeout = readNonNegativeInteger("LLM_WIKI_REQUEST_TIMEOUT_MS", 0);
server.timeout = readNonNegativeInteger("LLM_WIKI_SOCKET_TIMEOUT_MS", 0);

function readNonNegativeInteger(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}
