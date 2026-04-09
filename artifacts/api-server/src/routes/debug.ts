import { Router } from "express";
import axios from "axios";

const debugRouter = Router();

debugRouter.get("/debug/appx", async (req, res) => {
  const batchId = String(req.query["batchId"] || "698481c9fdd21a8a2d18ac5b");
  const appKey = String(req.query["appKey"] || "selectionway");
  const endpoint = String(req.query["endpoint"] || "topics");

  const headers = {
    "User-Agent": "Dart/2.19 (dart:io)",
    "Accept": "application/json",
    "Accept-Encoding": "gzip",
    "appVersion": "1.4.39.1",
    "appKey": appKey,
    "Content-Type": "application/json",
  };

  const results: Record<string, unknown> = {};

  const urls = endpoint === "list" ? [
    `https://api.appx.ac/v1/batch?page=0&limit=100&status=1`,
    `https://api.appx.ac/v1/batch/allBatchesWithoutEnrollment?page=0&limit=100`,
    `https://api.appx.ac/v2/batch?page=0&limit=100`,
  ] : [
    `https://api.appx.ac/v1/batch/${batchId}`,
    `https://api.appx.ac/v1/batch/${batchId}/topics?page=1&limit=50`,
    `https://api.appx.ac/v1/batch/${batchId}/videos?page=1&limit=50`,
    `https://api.appx.ac/v1/batch/${batchId}/chapters`,
  ];

  for (const url of urls) {
    try {
      const r = await axios.get(url, { headers, timeout: 10000 });
      results[url] = { status: r.status, data: r.data };
    } catch (err: unknown) {
      const e = err as { response?: { status: number; data: unknown }; message: string };
      results[url] = {
        error: e.message,
        status: e.response?.status,
        data: e.response?.data,
      };
    }
  }

  res.json({ appKey, batchId, results });
});

export default debugRouter;
