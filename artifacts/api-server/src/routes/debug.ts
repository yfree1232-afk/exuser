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

// GET /api/debug/hranker?courseId=1231&step=register|courses|series|content
// Tests Selection Way HRanker API — run this from Heroku to diagnose
debugRouter.get("/debug/hranker", async (req, res) => {
  const courseId = String(req.query["courseId"] || "1231");
  const step = String(req.query["step"] || "all");
  const userId = String(req.query["userId"] || "1");
  const token = String(req.query["token"] || "");

  const results: Record<string, unknown> = {};

  const candidateBases = [
    "https://selectionway.hranker.com/admin/api",
    "https://www.selectionway.hranker.com/admin/api",
    "https://selectionway.in/admin/api",
    "https://www.selectionway.in/admin/api",
    "https://api.selectionway.in/admin/api",
    "https://backend.selectionway.in/admin/api",
    "https://selectionway.hranker.com/api",
    "https://www.hranker.com/admin/api",
  ];

  const baseHeaders = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    "Accept": "application/json, text/plain, */*",
    "Content-Type": "application/json",
    "Origin": "https://selectionway.hranker.com",
    "Referer": "https://selectionway.hranker.com/",
  };

  // Step: find correct API base
  if (step === "all" || step === "base") {
    results["base_check"] = {};
    for (const base of candidateBases) {
      try {
        const r = await axios.get(`${base}/home-data/1`, {
          headers: baseHeaders,
          timeout: 8000,
        });
        (results["base_check"] as Record<string, unknown>)[base] = {
          status: r.status,
          state: (r.data as Record<string, unknown>)["state"],
          keys: Object.keys(r.data as object),
        };
      } catch (e: unknown) {
        const err = e as { response?: { status: number }; message: string };
        (results["base_check"] as Record<string, unknown>)[base] = {
          error: err.message,
          httpStatus: err.response?.status,
        };
      }
    }
  }

  const BASE = "https://selectionway.hranker.com/admin/api";

  // Step: test registration
  if (step === "all" || step === "register") {
    const ts = Date.now();
    try {
      const r = await axios.post(`${BASE}/user-registration`, {
        name: "TestUser",
        email: `test${ts}@yopmail.com`,
        mobile: `9${String(ts).slice(-9)}`,
        password: "Test@1234",
      }, { headers: baseHeaders, timeout: 10000 });
      results["register"] = { status: r.status, data: r.data };
    } catch (e: unknown) {
      const err = e as { response?: { status: number; data: unknown }; message: string };
      results["register"] = { error: err.message, status: err.response?.status, data: err.response?.data };
    }
  }

  // Step: test course listing / home-data
  if ((step === "all" || step === "courses") && userId && token) {
    const authHeaders = { ...baseHeaders, ...(token ? { Authorization: `Bearer ${token}`, token } : {}) };
    const courseEndpoints = [
      `${BASE}/home-data/${userId}`,
      `${BASE}/user-packages/${userId}`,
      `${BASE}/package-list`,
      `${BASE}/all-packages`,
    ];
    results["courses"] = {};
    for (const url of courseEndpoints) {
      try {
        const r = await axios.get(url, { headers: authHeaders, timeout: 8000 });
        (results["courses"] as Record<string, unknown>)[url] = { status: r.status, data: r.data };
      } catch (e: unknown) {
        const err = e as { response?: { status: number; data: unknown }; message: string };
        (results["courses"] as Record<string, unknown>)[url] = { error: err.message, status: err.response?.status };
      }
    }
  }

  // Step: test series/content for a course
  if ((step === "all" || step === "series") && userId) {
    const seriesEndpoints = [
      `${BASE}/package-series/${userId}/${courseId}`,
      `${BASE}/home-series/${userId}/${courseId}`,
      `${BASE}/get-tab-package-series/${userId}/${courseId}/0`,
      `${BASE}/series/${courseId}`,
      `${BASE}/chapter-list/${courseId}`,
      `${BASE}/package-detail/${courseId}`,
    ];
    results["series"] = {};
    for (const url of seriesEndpoints) {
      try {
        const r = await axios.get(url, { headers: baseHeaders, timeout: 8000 });
        (results["series"] as Record<string, unknown>)[url] = { status: r.status, data: r.data };
      } catch (e: unknown) {
        const err = e as { response?: { status: number; data: unknown }; message: string };
        (results["series"] as Record<string, unknown>)[url] = { error: err.message, status: err.response?.status };
      }
    }
  }

  res.json({ courseId, userId, step, results });
});

export default debugRouter;
