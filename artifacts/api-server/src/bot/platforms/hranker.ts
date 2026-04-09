import axios, { type AxiosRequestConfig } from "axios";
import { logger } from "../../lib/logger.js";

const HRANKER_API = "https://www.hranker.com/admin/api";

export interface HRankerUser {
  userId: string;
  token: string;
  name: string;
  subdomain: string;
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

function makeConfig(subdomain: string, extra: Partial<AxiosRequestConfig> = {}): AxiosRequestConfig {
  return {
    timeout: 12000,
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Accept": "application/json, text/plain, */*",
      "Accept-Language": "en-US,en;q=0.9",
      "Content-Type": "application/json",
      "Origin": `https://${subdomain}.hranker.com`,
      "Referer": `https://${subdomain}.hranker.com/`,
    },
    ...extra,
  };
}

// ─── Auto-Register a dummy account (no manual credentials needed) ─────────────

export async function hrankerAutoRegister(subdomain: string): Promise<HRankerUser> {
  const cfg = makeConfig(subdomain);
  const ts = Date.now();
  const rnd = Math.floor(Math.random() * 9000) + 1000;
  const email = `bot${ts}${rnd}@yopmail.com`;
  const mobile = `7${String(ts).slice(-9)}`;

  try {
    const res = await axios.post(`${HRANKER_API}/user-registration`, {
      name: "Bot User",
      email,
      mobile,
      password: `Bot@${rnd}`,
    }, cfg);

    const d = res.data as Record<string, unknown>;
    const data = (d["data"] ?? d) as Record<string, unknown>;

    if (d["state"] === 200 || data["user_id"]) {
      return {
        userId: String(data["user_id"] ?? ""),
        token: String(data["token_id"] ?? data["token"] ?? ""),
        name: String(data["first_name"] ?? "Bot"),
        subdomain,
        isDummy: true,
      };
    }

    throw new Error(String(d["msg"] ?? "Registration failed"));
  } catch (err) {
    logger.error({ err }, "Auto-register failed, trying login");
    // Fallback: try logging in with a known dummy (if server already has one)
    throw err;
  }
}

// ─── Manual Login ─────────────────────────────────────────────────────────────

export async function hrankerLogin(email: string, password: string, subdomain: string): Promise<HRankerUser> {
  const cfg = makeConfig(subdomain);
  const res = await axios.post(`${HRANKER_API}/user-login`, { email, password }, cfg);
  const data = res.data as Record<string, unknown>;

  if (!data || data["state"] !== 200) {
    const msg = String(data?.["msg"] || data?.["message"] || "Login failed");
    throw new Error(msg);
  }

  const userData = (data["data"] || data["userData"] || data["user"]) as Record<string, unknown>;
  if (!userData) throw new Error("User data missing in login response");

  const userId = String(userData["user_id"] || userData["id"] || userData["userId"] || "");
  const name = String(userData["first_name"] || userData["name"] || userData["full_name"] || email.split("@")[0]);
  const token = String(data["token"] || userData["token_id"] || userData["token"] || userData["auth_token"] || userId);

  if (!userId) throw new Error("Could not extract user ID from login response");

  return { userId, token, name, subdomain, isDummy: false };
}

// ─── List Courses ─────────────────────────────────────────────────────────────

export async function listHRankerCourses(user: HRankerUser): Promise<HRankerCourse[]> {
  const cfg = makeConfig(user.subdomain);

  // 1. Get all packages from the search endpoint (public)
  try {
    const res = await axios.get(`${HRANKER_API}/search`, cfg);
    const data = res.data as Record<string, unknown>;
    const items = extractArray(data, ["data", "result", "courses", "packages"]);
    if (items.length > 0) {
      return items
        .map((item) => ({
          id: String(item["pid"] || item["id"] || item["package_id"] || ""),
          name: String(item["name"] || item["title"] || item["package_name"] || ""),
        }))
        .filter((c) => c.id && c.name);
    }
  } catch (err) {
    logger.debug({ err }, "Search endpoint failed");
  }

  // 2. Fallback: Try user's packages
  const endpoints = [
    `${HRANKER_API}/user-package/${user.userId}/0`,
    `${HRANKER_API}/packages/${user.userId}/0`,
    `${HRANKER_API}/packages-data/${user.userId}/0`,
  ];

  for (const url of endpoints) {
    try {
      const res = await axios.get(url, cfg);
      const data = res.data as Record<string, unknown>;
      if (!data || data["state"] === 404 || data["state"] === 400) continue;

      const items = extractArray(data, ["data", "packages", "package", "result", "courses"]);
      if (items.length > 0) {
        return items
          .map((item) => ({
            id: String(item["id"] || item["package_id"] || item["pid"] || item["course_id"] || ""),
            name: String(item["name"] || item["title"] || item["package_name"] || item["course_name"] || ""),
          }))
          .filter((c) => c.id && c.name);
      }
    } catch (err) {
      logger.debug({ err, url }, "HRanker course list endpoint failed");
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
  const cfg = makeConfig(user.subdomain);
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
  try {
    const res = await axios.get(`${HRANKER_API}/package-detail/${courseId}`, cfg);
    const data = res.data as Record<string, unknown>;
    const detail = unwrap(data, ["data", "package", "result"]) as Record<string, unknown>;
    if (detail && typeof detail === "object") {
      const name = detail["name"] || detail["title"] || detail["package_name"];
      if (name) result.name = String(name);
    }
  } catch {
    // continue
  }

  // Step 2: Get series/chapters for this course
  const seriesEndpoints = [
    `${HRANKER_API}/package-series/${uid}/${courseId}`,
    `${HRANKER_API}/home-series/${uid}/${courseId}`,
    `${HRANKER_API}/get-tab-package-series/${uid}/${courseId}/0`,
    `${HRANKER_API}/get-user-series-data-v1/${uid}?package_id=${courseId}`,
  ];

  let seriesItems: Record<string, unknown>[] = [];
  for (const url of seriesEndpoints) {
    try {
      const res = await axios.get(url, cfg);
      const data = res.data as Record<string, unknown>;
      if (!data || data["state"] === 400 || data["state"] === 404) continue;
      const items = extractArray(data, ["data", "series", "chapters", "sections", "result", "topics"]);
      if (items.length > 0) {
        seriesItems = items;
        break;
      }
    } catch {
      // continue
    }
  }

  // Step 3: For each series, get video/PDF content
  for (const series of seriesItems) {
    const seriesId = String(series["series_id"] || series["id"] || series["section_id"] || "");
    const seriesName = String(series["series_name"] || series["name"] || series["title"] || "Section");

    if (!seriesId) continue;

    const studyEndpoints = [
      `${HRANKER_API}/study-data/${seriesId}`,
      `${HRANKER_API}/study-detail/${seriesId}`,
      `${HRANKER_API}/get-user-series-data-v1/${uid}?series_id=${seriesId}`,
      `${HRANKER_API}/get-user-series-recent-v1/${uid}?series_id=${seriesId}`,
    ];

    for (const url of studyEndpoints) {
      try {
        const res = await axios.get(url, cfg);
        const data = res.data as Record<string, unknown>;
        if (!data || data["state"] === 400 || data["state"] === 404) continue;

        const topics = extractArray(data, ["data", "topics", "videos", "content", "result", "study_data", "lectures"]);
        if (topics.length > 0) {
          processTopics(topics, result, seriesName);
          break;
        }
      } catch {
        // continue
      }
    }
  }

  // Step 4: Fallback — direct content load
  if (result.totalLinks === 0) {
    const fallbackEndpoints = [
      `${HRANKER_API}/package-series-load/${uid}/${courseId}/0/500`,
      `${HRANKER_API}/get-tab-package-series/${uid}/${courseId}/0`,
      `${HRANKER_API}/home-series-data/${courseId}`,
      `${HRANKER_API}/user-series/${uid}`,
    ];

    for (const url of fallbackEndpoints) {
      try {
        const res = await axios.get(url, cfg);
        const data = res.data as Record<string, unknown>;
        if (!data || data["state"] === 400 || data["state"] === 404) continue;
        const items = extractArray(data, ["data", "topics", "videos", "content", "result", "series"]);
        if (items.length > 0) {
          processTopics(items, result);
          if (result.totalLinks > 0) break;
        }
      } catch {
        // continue
      }
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

    const videoUrl = item["video_url"] || item["videoUrl"] || item["url"] || item["video"] || item["content_url"];
    const pdfUrl = item["pdf_url"] || item["pdfUrl"] || item["file_url"] || item["pdf"] || item["notes_url"] || item["attachment"];
    const ytUrl = item["youtube_url"] || item["yt_url"] || item["youtubeUrl"];

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
    lines.push(`       🎬 VIDEO LINKS`);
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
    lines.push(`⚠️  Note: Ye platform primarily test series ke liye hai.`);
    lines.push(`   Video links available nahi hain ya login aur purchase required hai.`);
  }

  lines.push(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  lines.push(`Generated On: ${now} IST`);
  lines.push(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

  return lines.join("\n");
}
