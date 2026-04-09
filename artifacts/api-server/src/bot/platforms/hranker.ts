import axios, { type AxiosRequestConfig } from "axios";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { logger } from "../../lib/logger.js";

const DEFAULT_API_BASE = "https://www.hranker.com/admin/api";

// ─── Persistent dummy account cache ───────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, "../../../data");
const CACHE_FILE = path.join(DATA_DIR, "dummy_accounts.json");

interface CachedAccount {
  userId: string;
  token: string;
  email: string;
  mobile: string;
  password: string;
  apiBase: string;
  createdAt: string;
}

type AccountCache = Record<string, CachedAccount>;

function loadCache(): AccountCache {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(CACHE_FILE)) return {};
    return JSON.parse(fs.readFileSync(CACHE_FILE, "utf-8")) as AccountCache;
  } catch {
    return {};
  }
}

function saveCache(cache: AccountCache): void {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2), "utf-8");
  } catch (err) {
    logger.error({ err }, "Failed to save dummy account cache");
  }
}

// ─── Interfaces ───────────────────────────────────────────────────────────────

export interface HRankerUser {
  userId: string;
  token: string;
  name: string;
  subdomain: string;
  apiBase: string;
  isDummy: boolean;
}

export interface HRankerCourse {
  id: string;
  name: string;
}

export interface HRankerLesson {
  title: string;
  sectionName?: string;
  videoUrl?: string;
  pdfUrl?: string;
  youtubeUrl?: string;
}

export interface HRankerExtractedCourse {
  id: string;
  name: string;
  platform: string;
  lessons: HRankerLesson[];
  totalLinks: number;
  totalVideos: number;
  totalPdfs: number;
  totalYoutube: number;
}

// ─── HTTP helper ──────────────────────────────────────────────────────────────

function makeConfig(domain: string, extra: Partial<AxiosRequestConfig> = {}): AxiosRequestConfig {
  return {
    timeout: 15000,
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Accept": "application/json, text/plain, */*",
      "Accept-Language": "en-US,en;q=0.9",
      "Content-Type": "application/json",
      "Origin": `https://${domain}`,
      "Referer": `https://${domain}/`,
    },
    ...extra,
  };
}

// ─── Verify if a cached account is still valid ────────────────────────────────

async function verifyCachedAccount(cached: CachedAccount): Promise<boolean> {
  try {
    const domain = new URL(cached.apiBase).hostname;
    const cfg = makeConfig(domain);
    const res = await axios.post(`${cached.apiBase}/user-login`, {
      email: cached.email,
      password: cached.password,
    }, cfg);
    const data = res.data as Record<string, unknown>;
    return data["state"] === 200;
  } catch {
    return false;
  }
}

// ─── Find working API base (tries multiple candidates) ───────────────────────

async function findWorkingApiBase(subdomain: string, primaryBase: string): Promise<string> {
  // Build candidate list: primary first, then common variants
  const candidates = [
    primaryBase,
    `https://${subdomain}.hranker.com/admin/api`,
    `https://www.${subdomain}.hranker.com/admin/api`,
    `https://${subdomain}.in/admin/api`,
    `https://www.${subdomain}.in/admin/api`,
  ].filter((v, i, a) => a.indexOf(v) === i); // deduplicate

  for (const base of candidates) {
    try {
      const domain = new URL(base).hostname;
      const cfg = makeConfig(domain);
      const r = await axios.get(`${base}/home-data/1`, { ...cfg, timeout: 6000 });
      const d = r.data as Record<string, unknown>;
      // Accept any JSON response (even with state 404) as a sign the API exists
      if (r.status === 200 && typeof d === "object" && d !== null) {
        logger.info({ subdomain, base }, "Found working HRanker API base");
        return base;
      }
    } catch {
      // try next
    }
  }
  // Fall back to primary if nothing worked
  logger.warn({ subdomain, primaryBase }, "No working API base found, using primary");
  return primaryBase;
}

// ─── Auto-Register (one-time, cached permanently) ────────────────────────────

export async function hrankerAutoRegister(
  subdomain: string,
  apiBase: string = DEFAULT_API_BASE,
): Promise<HRankerUser> {
  const cacheKey = subdomain;
  const cache = loadCache();

  // Return cached account if exists
  if (cache[cacheKey]) {
    const cached = cache[cacheKey]!;
    logger.info({ subdomain, userId: cached.userId }, "Using cached dummy account");
    return {
      userId: cached.userId,
      token: cached.token,
      name: "Bot User",
      subdomain,
      apiBase: cached.apiBase,
      isDummy: true,
    };
  }

  // Discover the correct API base
  const resolvedBase = await findWorkingApiBase(subdomain, apiBase);

  const domain = new URL(resolvedBase).hostname;
  const cfg = makeConfig(domain);
  const ts = Date.now();
  const rnd = Math.floor(Math.random() * 9000) + 1000;
  const email = `bot${ts}${rnd}@yopmail.com`;
  const mobile = `8${String(ts).slice(-9)}`;
  const password = `Bot@${rnd}`;

  logger.info({ subdomain, resolvedBase }, "Registering new dummy account");

  const res = await axios.post(`${resolvedBase}/user-registration`, {
    name: "Bot User",
    email,
    mobile,
    password,
  }, cfg);

  const d = res.data as Record<string, unknown>;
  const data = (d["data"] ?? d) as Record<string, unknown>;

  if (d["state"] !== 200 && !data["user_id"]) {
    throw new Error(String(d["msg"] ?? "Registration failed"));
  }

  const userId = String(data["user_id"] ?? "");
  const token = String(data["token_id"] ?? data["token"] ?? "");

  const newEntry: CachedAccount = {
    userId,
    token,
    email,
    mobile,
    password,
    apiBase: resolvedBase,
    createdAt: new Date().toISOString(),
  };
  cache[cacheKey] = newEntry;
  saveCache(cache);

  logger.info({ subdomain, userId, resolvedBase }, "Dummy account registered and cached");

  return { userId, token, name: "Bot User", subdomain, apiBase: resolvedBase, isDummy: true };
}

// ─── Manual Login ─────────────────────────────────────────────────────────────

export async function hrankerLogin(
  email: string,
  password: string,
  subdomain: string,
  apiBase: string = DEFAULT_API_BASE,
): Promise<HRankerUser> {
  const domain = new URL(apiBase).hostname;
  const cfg = makeConfig(domain);
  const res = await axios.post(`${apiBase}/user-login`, { email, password }, cfg);
  const data = res.data as Record<string, unknown>;

  if (!data || data["state"] !== 200) {
    const msg = String(data?.["msg"] || data?.["message"] || "Login failed");
    throw new Error(msg);
  }

  const userData = (data["data"] || data["userData"] || data["user"]) as Record<string, unknown>;
  if (!userData) throw new Error("User data missing in login response");

  const userId = String(userData["user_id"] || userData["id"] || userData["userId"] || "");
  const name = String(userData["first_name"] || userData["name"] || email.split("@")[0]);
  const token = String(data["token"] || userData["token_id"] || userData["token"] || userId);

  if (!userId) throw new Error("Could not extract user ID from login response");

  return { userId, token, name, subdomain, apiBase, isDummy: false };
}

// ─── List Courses ─────────────────────────────────────────────────────────────

export async function listHRankerCourses(user: HRankerUser): Promise<HRankerCourse[]> {
  const domain = new URL(user.apiBase).hostname;
  const cfg = makeConfig(domain);
  const base = user.apiBase;

  const uid = user.userId;

  // 1. home-data (works on selectionway.com and similar HRanker instances)
  try {
    const res = await axios.get(`${base}/home-data/${uid}`, cfg);
    const data = res.data as Record<string, unknown>;
    if (data && data["state"] === 200) {
      const homeData = (data["data"] || {}) as Record<string, unknown>;
      const packageData = homeData["packageData"];
      if (Array.isArray(packageData) && packageData.length > 0) {
        return (packageData as Record<string, unknown>[])
          .map((item) => ({
            id: String(item["package_id"] || item["pid"] || item["id"] || ""),
            name: String(item["package_name"] || item["name"] || item["title"] || ""),
          }))
          .filter((c) => c.id && c.name);
      }
    }
  } catch (err) {
    logger.debug({ err }, "home-data failed");
  }

  // 2. Search / public listing
  const searchEndpoints = [
    `${base}/search`,
    `${base}/packages/list`,
    `${base}/all-packages`,
  ];

  for (const url of searchEndpoints) {
    try {
      const res = await axios.get(url, cfg);
      const data = res.data as Record<string, unknown>;
      if (!data || typeof data !== "object") continue;
      const items = extractArray(data, ["data", "result", "courses", "packages", "list"]);
      if (items.length > 0) {
        return items
          .map((item) => ({
            id: String(item["pid"] || item["package_id"] || item["id"] || ""),
            name: String(item["name"] || item["package_name"] || item["title"] || ""),
          }))
          .filter((c) => c.id && c.name);
      }
    } catch (err) {
      logger.debug({ err, url }, "HRanker course list endpoint failed");
    }
  }

  // 3. Fallback: user's own packages
  for (const url of [`${base}/user-package/${uid}/0`, `${base}/packages/${uid}/0`]) {
    try {
      const res = await axios.get(url, cfg);
      const data = res.data as Record<string, unknown>;
      if (!data || data["state"] === 404 || data["state"] === 400) continue;
      const items = extractArray(data, ["data", "packages", "result", "courses"]);
      if (items.length > 0) {
        return items
          .map((item) => ({
            id: String(item["id"] || item["package_id"] || item["pid"] || ""),
            name: String(item["name"] || item["title"] || item["package_name"] || ""),
          }))
          .filter((c) => c.id && c.name);
      }
    } catch (err) {
      logger.debug({ err, url }, "HRanker user package endpoint failed");
    }
  }

  return [];
}

// ─── Extract Course ───────────────────────────────────────────────────────────

export async function extractHRankerCourse(
  courseId: string,
  user: HRankerUser,
  platformName: string,
): Promise<HRankerExtractedCourse> {
  const domain = new URL(user.apiBase).hostname;
  const cfg = makeConfig(domain);
  const base = user.apiBase;
  const uid = user.userId;

  const result: HRankerExtractedCourse = {
    id: courseId,
    name: `Course ${courseId}`,
    platform: platformName,
    lessons: [],
    totalLinks: 0,
    totalVideos: 0,
    totalPdfs: 0,
    totalYoutube: 0,
  };

  // Step 1: Get course/package name
  const detailEndpoints = [
    `${base}/package-detail/${courseId}`,
    `${base}/packages-detail/${courseId}`,
    `${base}/batch-detail/${courseId}`,
  ];

  for (const url of detailEndpoints) {
    try {
      const res = await axios.get(url, cfg);
      const data = res.data as Record<string, unknown>;
      if (!data || data["state"] === 404) continue;
      const detail = unwrap(data, ["data", "package", "result"]) as Record<string, unknown>;
      if (detail && typeof detail === "object") {
        const name = detail["name"] || detail["title"] || detail["package_name"];
        if (name) { result.name = String(name); break; }
      }
    } catch { continue; }
  }

  // Step 2: Get chapters/series list
  const seriesEndpoints = [
    `${base}/package-series/${uid}/${courseId}`,
    `${base}/home-series/${uid}/${courseId}`,
    `${base}/get-tab-package-series/${uid}/${courseId}/0`,
    `${base}/get-user-series/${uid}/${courseId}`,
    `${base}/series/${courseId}`,
    `${base}/chapter-list/${courseId}`,
  ];

  let seriesItems: Record<string, unknown>[] = [];
  for (const url of seriesEndpoints) {
    try {
      const res = await axios.get(url, cfg);
      const data = res.data as Record<string, unknown>;
      if (!data || data["state"] === 400 || data["state"] === 404) continue;
      const items = extractArray(data, ["data", "series", "chapters", "sections", "result", "topics"]);
      if (items.length > 0) { seriesItems = items; break; }
    } catch { continue; }
  }

  // Step 3: For each series, get video/PDF content
  for (const series of seriesItems) {
    const seriesId = String(series["series_id"] || series["id"] || series["section_id"] || "");
    const seriesName = String(series["series_name"] || series["name"] || series["title"] || "Section");
    if (!seriesId) continue;

    const studyEndpoints = [
      `${base}/study-data/${seriesId}`,
      `${base}/study-detail/${seriesId}`,
      `${base}/get-series-content/${uid}/${seriesId}`,
      `${base}/series-content/${seriesId}`,
      `${base}/video-list/${seriesId}`,
      `${base}/videos/${seriesId}`,
      `${base}/get-user-series-data-v1/${uid}?series_id=${seriesId}`,
    ];

    for (const url of studyEndpoints) {
      try {
        const res = await axios.get(url, cfg);
        const data = res.data as Record<string, unknown>;
        if (!data || data["state"] === 400 || data["state"] === 404) continue;

        const topics = extractArray(data, ["data", "topics", "videos", "content", "result", "study_data", "lectures", "list"]);
        if (topics.length > 0) {
          processTopics(topics, result, seriesName);
          break;
        }
      } catch { continue; }
    }
  }

  // Step 4: Fallback — bulk content load
  if (result.totalLinks === 0) {
    const fallbackEndpoints = [
      `${base}/package-videos/${uid}/${courseId}`,
      `${base}/batch-videos/${courseId}`,
      `${base}/all-content/${courseId}`,
      `${base}/course-content/${uid}/${courseId}`,
    ];

    for (const url of fallbackEndpoints) {
      try {
        const res = await axios.get(url, cfg);
        const data = res.data as Record<string, unknown>;
        if (!data || data["state"] === 400 || data["state"] === 404) continue;
        const items = extractArray(data, ["data", "topics", "videos", "content", "result"]);
        if (items.length > 0) {
          processTopics(items, result);
          if (result.totalLinks > 0) break;
        }
      } catch { continue; }
    }
  }

  return result;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function processTopics(items: Record<string, unknown>[], result: HRankerExtractedCourse, sectionName?: string): void {
  for (const item of items) {
    const lesson: HRankerLesson = {
      title: String(item["name"] || item["title"] || item["topic_name"] || item["video_name"] || "Lecture"),
      sectionName,
    };

    const videoUrl = item["video_url"] || item["videoUrl"] || item["url"] || item["video"] || item["content_url"] || item["stream_url"];
    const pdfUrl = item["pdf_url"] || item["pdfUrl"] || item["file_url"] || item["pdf"] || item["notes_url"] || item["attachment"] || item["document_url"];
    const ytUrl = item["youtube_url"] || item["yt_url"] || item["youtubeUrl"] || item["youtube"];

    if (typeof videoUrl === "string" && videoUrl.trim()) {
      const url = videoUrl.trim();
      if (url.includes("youtube.com") || url.includes("youtu.be")) {
        lesson.youtubeUrl = url;
        result.totalYoutube++;
        result.totalLinks++;
      } else {
        lesson.videoUrl = url;
        result.totalVideos++;
        result.totalLinks++;
      }
    }

    if (typeof ytUrl === "string" && ytUrl.trim() && !lesson.youtubeUrl) {
      lesson.youtubeUrl = ytUrl.trim();
      result.totalYoutube++;
      result.totalLinks++;
    }

    if (typeof pdfUrl === "string" && pdfUrl.trim()) {
      lesson.pdfUrl = pdfUrl.trim();
      result.totalPdfs++;
      result.totalLinks++;
    }

    if (lesson.videoUrl || lesson.youtubeUrl || lesson.pdfUrl) {
      result.lessons.push(lesson);
    }
  }
}

function extractArray(data: unknown, keys: string[]): Record<string, unknown>[] {
  if (Array.isArray(data)) return data as Record<string, unknown>[];
  if (data && typeof data === "object") {
    const obj = data as Record<string, unknown>;
    for (const key of keys) {
      if (Array.isArray(obj[key])) return obj[key] as Record<string, unknown>[];
    }
    for (const key of keys) {
      if (obj[key] && typeof obj[key] === "object") {
        const nested = obj[key] as Record<string, unknown>;
        for (const k2 of keys) {
          if (Array.isArray(nested[k2])) return nested[k2] as Record<string, unknown>[];
        }
      }
    }
  }
  return [];
}

function unwrap(data: unknown, keys: string[]): unknown {
  if (!data || typeof data !== "object") return data;
  const obj = data as Record<string, unknown>;
  for (const key of keys) {
    if (obj[key] !== undefined && obj[key] !== null) return obj[key];
  }
  return data;
}

// ─── Formatter ────────────────────────────────────────────────────────────────

export function formatHRankerTxt(course: HRankerExtractedCourse): string {
  const now = new Date().toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  });

  const lines: string[] = [];
  lines.push(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  lines.push(`       📚 COURSE DETAILS`);
  lines.push(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  lines.push(`🏫 Platform  : ${course.platform}`);
  lines.push(`⭐ Course    : ${course.name}`);
  lines.push(`🆔 ID        : ${course.id}`);
  lines.push(``);
  lines.push(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  lines.push(`       🔗 LINK SUMMARY`);
  lines.push(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  lines.push(`🔗 Total Links    : ${course.totalLinks}`);
  lines.push(`🎬 Videos         : ${course.totalVideos}`);
  lines.push(`▶️  YouTube Videos : ${course.totalYoutube}`);
  lines.push(`📄 PDFs           : ${course.totalPdfs}`);
  lines.push(``);

  if (course.lessons.length > 0) {
    lines.push(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    lines.push(`       🎬 CONTENT LINKS`);
    lines.push(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    lines.push(``);

    let lastSection = "";
    for (const lesson of course.lessons) {
      if (lesson.sectionName && lesson.sectionName !== lastSection) {
        lines.push(`📁 ${lesson.sectionName}`);
        lines.push(`${"─".repeat(40)}`);
        lastSection = lesson.sectionName;
      }
      lines.push(`📌 ${lesson.title}`);
      if (lesson.videoUrl) lines.push(`   🎬 ${lesson.videoUrl}`);
      if (lesson.youtubeUrl) lines.push(`   ▶️  ${lesson.youtubeUrl}`);
      if (lesson.pdfUrl) lines.push(`   📄 ${lesson.pdfUrl}`);
      lines.push(``);
    }
  } else {
    lines.push(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    lines.push(`⚠️  NOTE`);
    lines.push(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    lines.push(`Ye platform test series based hai.`);
    lines.push(`Video/PDF content ke liye apna account se login karo.`);
    lines.push(`"Login with my account" button use karo.`);
  }

  lines.push(``);
  lines.push(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  lines.push(`Generated On: ${now} IST`);
  lines.push(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

  return lines.join("\n");
}
