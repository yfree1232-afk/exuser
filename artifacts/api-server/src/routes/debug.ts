import { Router } from "express";
import axios from "axios";

const debugRouter = Router();

const APPX_HEADERS = (appKey: string, token?: string) => ({
  "User-Agent": "Dart/2.19 (dart:io)",
  "Accept": "application/json",
  "Accept-Encoding": "gzip",
  "appVersion": "1.4.39.1",
  "appKey": appKey,
  "Content-Type": "application/json",
  ...(token ? { "Authorization": `Bearer ${token}`, "token": token } : {}),
});

// GET /api/debug/appx?endpoint=list&appKey=selectionway&batchId=xxx&token=xxx
debugRouter.get("/debug/appx", async (req, res) => {
  const batchId = String(req.query["batchId"] || "698481c9fdd21a8a2d18ac5b");
  const appKey = String(req.query["appKey"] || "selectionway");
  const endpoint = String(req.query["endpoint"] || "topics");
  const token = req.query["token"] ? String(req.query["token"]) : undefined;

  const headers = APPX_HEADERS(appKey, token);
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

  res.json({ appKey, batchId, token: token ? "***provided***" : "none", results });
});

// POST /api/debug/appx-otp/send  body: { mobile, appKey }
debugRouter.post("/debug/appx-otp/send", async (req, res) => {
  const { mobile = "", appKey = "selectionway" } = req.body as Record<string, string>;
  const cleanMobile = mobile.replace(/\D/g, "").replace(/^91/, "").slice(-10);
  const headers = APPX_HEADERS(appKey);
  const results: Record<string, unknown> = {};

  const endpoints = [
    { url: "https://api.appx.ac/v1/user/requestotp", body: { mob: cleanMobile, appKey } },
    { url: "https://api.appx.ac/v1/user/requestotp", body: { mob: `+91${cleanMobile}`, appKey } },
    { url: "https://api.appx.ac/v1/auth/sendOtp", body: { mobile: cleanMobile, appKey, countryCode: "+91" } },
  ];

  for (const ep of endpoints) {
    try {
      const r = await axios.post(ep.url, ep.body, { headers, timeout: 10000 });
      results[ep.url] = { status: r.status, data: r.data };
    } catch (err: unknown) {
      const e = err as { response?: { status: number; data: unknown }; message: string };
      results[ep.url] = { error: e.message, status: e.response?.status, data: e.response?.data };
    }
  }

  res.json({ mobile: cleanMobile, appKey, results });
});

// POST /api/debug/appx-otp/verify  body: { mobile, otp, appKey }
debugRouter.post("/debug/appx-otp/verify", async (req, res) => {
  const { mobile = "", otp = "", appKey = "selectionway" } = req.body as Record<string, string>;
  const cleanMobile = mobile.replace(/\D/g, "").replace(/^91/, "").slice(-10);
  const headers = APPX_HEADERS(appKey);
  const results: Record<string, unknown> = {};

  const endpoints = [
    { url: "https://api.appx.ac/v1/user/login", body: { mob: cleanMobile, otp, appKey } },
    { url: "https://api.appx.ac/v1/user/login", body: { mob: `+91${cleanMobile}`, otp, appKey } },
    { url: "https://api.appx.ac/v1/auth/verifyOtp", body: { mobile: cleanMobile, otp, appKey, countryCode: "+91" } },
  ];

  for (const ep of endpoints) {
    try {
      const r = await axios.post(ep.url, ep.body, { headers, timeout: 10000 });
      results[ep.url] = { status: r.status, data: r.data };
    } catch (err: unknown) {
      const e = err as { response?: { status: number; data: unknown }; message: string };
      results[ep.url] = { error: e.message, status: e.response?.status, data: e.response?.data };
    }
  }

  res.json({ mobile: cleanMobile, otp, appKey, results });
});

export default debugRouter;
