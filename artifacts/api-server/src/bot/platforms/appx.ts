import axios, { type AxiosRequestConfig } from "axios";
import type { Platform } from "./index.js";

export interface AppXUser {
  token: string;
  userId: string;
  name: string;
  mobile: string;
  appKey: string;
}

export interface AppXCourseItem {
  id: string;
  name: string;
}

export interface AppXLesson {
  title: string;
  chapterName?: string;
  videoUrl?: string;
  youtubeUrl?: string;
  pdfUrl?: string;
  testUrl?: string;
}

export interface AppXCourse {
  id: string;
  name: string;
  platform: string;
  instructor?: string;
  lessons: AppXLesson[];
  totalLinks: number;
  totalVideos: number;
  totalYoutube: number;
  totalPdfs: number;
  totalTests: number;
}

// ─── HTTP helper ──────────────────────────────────────────────────────────────

function makeAxiosConfig(domain: string, appKey?: string, extra: Partial<AxiosRequestConfig> = {}): AxiosRequestConfig {
  const isAppxAc = domain === "api.appx.ac";
  return {
    timeout: 15000,
    headers: {
      "User-Agent": isAppxAc
        ? "Dart/2.19 (dart:io)"
        : "Mozilla/5.0 (Linux; Android 11; Pixel 5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/109.0.0.0 Mobile Safari/537.36",
      Accept: "application/json, text/plain, */*",
      "Accept-Language": "en-US,en;q=0.9",
      ...(isAppxAc
        ? {
            "Accept-Encoding": "gzip",
            "appVersion": "1.4.39.1",
          }
        : { Origin: `https://${domain}`, Referer: `https://${domain}/` }),
      "Content-Type": "application/json",
      ...(appKey ? { appKey } : {}),
    },
    ...extra,
  };
}

async function tryGet(url: string, cfg: AxiosRequestConfig): Promise<unknown> {
  const res = await axios.get(url, cfg);
  return res.data;
}

// Try multiple endpoints in parallel, return first successful result with data
async function tryParallel(urls: string[], cfg: AxiosRequestConfig): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let resolved = false;
    let remaining = urls.length;

    for (const url of urls) {
      axios.get(url, { ...cfg, timeout: 8000 })
        .then((res) => {
          if (!resolved && res.data) {
            const items = extractArray(res.data, ["data", "topics", "videos", "lectures", "batches", "courses", "result", "list"]);
            if (items.length > 0) {
              resolved = true;
              resolve(res.data);
            }
          }
        })
        .catch(() => { /* ignore */ })
        .finally(() => {
          remaining--;
          if (remaining === 0 && !resolved) reject(new Error("All endpoints failed"));
        });
    }
  });
}

// ─── AppX OTP Auth ────────────────────────────────────────────────────────────

function makeAppxAuthConfig(appKey: string): AxiosRequestConfig {
  return {
    timeout: 12000,
    headers: {
      "User-Agent": "Dart/2.19 (dart:io)",
      "Accept": "application/json",
      "Accept-Encoding": "gzip",
      "appVersion": "1.4.39.1",
      "Content-Type": "application/json",
      "appKey": appKey,
    },
  };
}

export async function appxSendOtp(mobile: string, appKey: string): Promise<boolean> {
  const cfg = makeAppxAuthConfig(appKey);
  const cleanMobile = mobile.replace(/\D/g, "").replace(/^91/, "").slice(-10);

  const endpoints = [
    { url: "https://api.appx.ac/v1/user/requestotp", body: { mob: cleanMobile, appKey } },
    { url: "https://api.appx.ac/v1/user/requestotp", body: { mob: `+91${cleanMobile}`, appKey } },
    { url: "https://api.appx.ac/v1/auth/sendOtp", body: { mobile: cleanMobile, appKey, countryCode: "+91" } },
    { url: "https://api.appx.ac/v1/auth/login/otp", body: { mobile: cleanMobile, appKey } },
  ];

  for (const ep of endpoints) {
    try {
      const res = await axios.post(ep.url, ep.body, cfg);
      const d = res.data as Record<string, unknown>;
      if (res.status === 200 && (d["success"] || d["message"] || d["status"] === "success" || d["data"])) {
        return true;
      }
    } catch {
      // try next
    }
  }
  return false;
}

export async function appxVerifyOtp(mobile: string, otp: string, appKey: string): Promise<AppXUser | null> {
  const cfg = makeAppxAuthConfig(appKey);
  const cleanMobile = mobile.replace(/\D/g, "").replace(/^91/, "").slice(-10);

  const endpoints = [
    { url: "https://api.appx.ac/v1/user/login", body: { mob: cleanMobile, otp, appKey } },
    { url: "https://api.appx.ac/v1/user/login", body: { mob: `+91${cleanMobile}`, otp, appKey } },
    { url: "https://api.appx.ac/v1/auth/verifyOtp", body: { mobile: cleanMobile, otp, appKey, countryCode: "+91" } },
    { url: "https://api.appx.ac/v1/auth/login/verify", body: { mobile: cleanMobile, otp, appKey } },
  ];

  for (const ep of endpoints) {
    try {
      const res = await axios.post(ep.url, ep.body, cfg);
      const raw = res.data as Record<string, unknown>;
      const data = (raw["data"] ?? raw) as Record<string, unknown>;
      const token = String(data["token"] || data["accessToken"] || data["access_token"] || "");
      const userId = String(data["id"] || data["userId"] || data["user_id"] || data["_id"] || "");
      const name = String(data["name"] || data["fullName"] || data["full_name"] || data["username"] || "User");
      if (token) {
        return { token, userId, name, mobile: cleanMobile, appKey };
      }
    } catch {
      // try next
    }
  }
  return null;
}

// ─── Course Listing ───────────────────────────────────────────────────────────

export async function listAppXCourses(platform: Platform): Promise<AppXCourseItem[]> {
  // Use hardcoded course list if available (faster, no API needed)
  if (platform.hardcodedCourses && platform.hardcodedCourses.length > 0) {
    return platform.hardcodedCourses;
  }

  const domain = platform.domain;
  const appKey = platform.appKey;
  const isAppxAc = domain === "api.appx.ac";
  const appDomain = domain.startsWith("api.") ? domain : `app.${domain}`;
  const cfg = makeAxiosConfig(domain, appKey);

  // For api.appx.ac with appKey, use the proper AppX shared API endpoints
  const candidates = isAppxAc ? [
    `https://api.appx.ac/v1/batch/allBatchesWithoutEnrollment?page=0&limit=500`,
    `https://api.appx.ac/v1/batch?page=0&limit=500&status=1`,
    `https://api.appx.ac/v1/batch?page=1&limit=500`,
    `https://api.appx.ac/v2/batch?page=0&limit=500`,
  ] : [
    // Standard domain
    `https://${domain}/api/v1/batch?page=1&limit=200&status=1`,
    `https://${domain}/api/v1/batch?page=0&limit=200`,
    `https://${domain}/api/v1/course?page=1&limit=200&status=1`,
    `https://${domain}/api/v1/course?page=0&limit=200`,
    `https://${domain}/api/batch?page=1&limit=200`,
    `https://${domain}/api/course?page=1&limit=200`,
    `https://${domain}/api/v2/batch?page=1&limit=200`,
    `https://${domain}/data/listcourse?userid=0&admin_login=0&status=1&limit=200&page=1&start=0`,
    `https://${domain}/api/v1/public/batch`,
    `https://${domain}/api/public/batches`,
    // app.domain
    `https://${appDomain}/api/v1/batch?page=1&limit=200`,
    `https://${appDomain}/api/v1/course?page=1&limit=200`,
    `https://${appDomain}/api/batch?page=1&limit=200`,
  ];

  try {
    const data = await tryParallel(candidates, cfg);
    const items = extractArray(data, ["data", "batches", "courses", "batch", "result", "list", "topics"]);
    if (items.length > 0) {
      return items
        .map((item: Record<string, unknown>) => ({
          id: String(item["_id"] || item["id"] || ""),
          name: String(item["name"] || item["title"] || item["batch_name"] || item["course_name"] || "Unnamed"),
        }))
        .filter((c: AppXCourseItem) => c.id && c.name !== "Unnamed");
    }
  } catch {
    // parallel failed, try sequential
    for (const url of candidates.slice(0, 5)) {
      try {
        const data = await tryGet(url, cfg);
        const items = extractArray(data, ["data", "batches", "courses", "batch", "result", "list"]);
        if (items.length > 0) {
          return items
            .map((item: Record<string, unknown>) => ({
              id: String(item["_id"] || item["id"] || ""),
              name: String(item["name"] || item["title"] || item["batch_name"] || item["course_name"] || "Unnamed"),
            }))
            .filter((c: AppXCourseItem) => c.id && c.name !== "Unnamed");
        }
      } catch {
        // try next
      }
    }
  }

  return [];
}

// ─── Course Extraction ────────────────────────────────────────────────────────

export async function extractAppXCourse(courseId: string, platform: Platform, authToken?: string): Promise<AppXCourse> {
  const domain = platform.domain;
  const appKey = platform.appKey;
  const isAppxAc = domain === "api.appx.ac";
  const appDomain = domain.startsWith("api.") ? domain : `app.${domain}`;
  const cfg = makeAxiosConfig(domain, appKey);

  // Inject auth token if available (needed for video URLs on authenticated platforms)
  if (authToken && cfg.headers) {
    (cfg.headers as Record<string, string>)["Authorization"] = `Bearer ${authToken}`;
    (cfg.headers as Record<string, string>)["token"] = authToken;
  }

  const course: AppXCourse = {
    id: courseId,
    name: `Course ${courseId}`,
    platform: platform.name,
    lessons: [],
    totalLinks: 0,
    totalVideos: 0,
    totalYoutube: 0,
    totalPdfs: 0,
    totalTests: 0,
  };

  // Step 1: Get course/batch info
  const infoEndpoints = isAppxAc ? [
    `https://api.appx.ac/v1/batch/${courseId}`,
    `https://api.appx.ac/v2/batch/${courseId}`,
  ] : [
    `https://${domain}/api/v1/batch/${courseId}`,
    `https://${domain}/api/v1/course/${courseId}`,
    `https://${domain}/api/batch/${courseId}`,
    `https://${domain}/api/course/${courseId}`,
  ];

  for (const url of infoEndpoints) {
    try {
      const raw = await tryGet(url, cfg);
      const d = unwrap(raw, ["data", "batch", "course", "result"]);
      if (d && typeof d === "object") {
        const rec = d as Record<string, unknown>;
        const title = rec["name"] || rec["title"] || rec["batch_name"] || rec["course_name"];
        if (title) {
          course.name = String(title);
          course.instructor = String(rec["instructor"] || rec["teacher_name"] || rec["teacher"] || "");
          break;
        }
      }
    } catch {
      // continue
    }
  }

  // Step 2: Get videos/topics
  // For api.appx.ac, use the proper AppX v1 batch topic API
  const videoEndpoints = isAppxAc ? [
    `https://api.appx.ac/v1/batch/${courseId}/topics?limit=2000&page=1`,
    `https://api.appx.ac/v1/batch/${courseId}/topics?page=1&limit=2000`,
    `https://api.appx.ac/v2/batch/${courseId}/topics?limit=2000&page=1`,
    `https://api.appx.ac/v1/batch/${courseId}/videos?limit=2000&page=1`,
    `https://api.appx.ac/v1/batch/${courseId}/lectures?limit=2000&page=1`,
  ] : [
    // Standard domain AppX endpoints
    `https://${domain}/api/v1/batch/${courseId}/topics?limit=2000&page=1`,
    `https://${domain}/api/v1/batch/${courseId}/video?limit=2000&page=1`,
    `https://${domain}/api/v1/batch/${courseId}/videos?limit=2000&page=1`,
    `https://${domain}/api/v1/batch/${courseId}/lectures?limit=2000&page=1`,
    `https://${domain}/api/v1/batch/${courseId}/content?limit=2000&page=1`,
    `https://${domain}/api/v1/course/${courseId}/topics?limit=2000&page=1`,
    `https://${domain}/api/v1/course/${courseId}/videos?limit=2000&page=1`,
    `https://${domain}/api/v1/course/${courseId}/lectures?limit=2000&page=1`,
    `https://${domain}/data/coursevideo?courseid=${courseId}&userid=0&admin_login=0&limit=2000&page=1`,
    `https://${domain}/data/listvideo?courseid=${courseId}&userid=0&limit=2000&page=1`,
    `https://${domain}/api/batch/${courseId}/videos`,
    `https://${domain}/api/course/${courseId}/videos`,
    `https://${appDomain}/api/v1/batch/${courseId}/topics?limit=2000&page=1`,
    `https://${appDomain}/api/v1/batch/${courseId}/videos?limit=2000&page=1`,
    `https://${appDomain}/api/v1/course/${courseId}/videos?limit=2000&page=1`,
    `https://${appDomain}/data/coursevideo?courseid=${courseId}&userid=0&admin_login=0&limit=2000&page=1`,
  ];

  for (const url of videoEndpoints) {
    try {
      const raw = await tryGet(url, cfg);
      const items = extractArray(raw, ["data", "topics", "videos", "lectures", "content", "result", "list"]);
      if (items.length > 0) {
        processItems(items, course);
        if (course.totalLinks > 0) break;
      }
    } catch {
      // try next endpoint
    }
  }

  // Step 3: If no videos, try chapter-based approach (for non-appx.ac or as fallback)
  if (course.totalLinks === 0) {
    const chapterEndpoints = isAppxAc ? [
      `https://api.appx.ac/v1/batch/${courseId}/chapters`,
      `https://api.appx.ac/v1/batch/${courseId}/subjects`,
    ] : [
      `https://${domain}/api/v1/batch/${courseId}/chapters`,
      `https://${domain}/api/v1/batch/${courseId}/subjects`,
      `https://${domain}/api/v1/course/${courseId}/chapters`,
    ];

    for (const chapterUrl of chapterEndpoints) {
      try {
        const raw = await tryGet(chapterUrl, cfg);
        const chapters = extractArray(raw, ["data", "chapters", "subjects", "result"]);
        if (chapters.length === 0) continue;

        for (const chapter of chapters) {
          const chapterId = String((chapter as Record<string, unknown>)["_id"] || (chapter as Record<string, unknown>)["id"] || "");
          const chapterName = String((chapter as Record<string, unknown>)["name"] || (chapter as Record<string, unknown>)["title"] || "Chapter");
          if (!chapterId) continue;

          const chapterVideoEndpoints = isAppxAc ? [
            `https://api.appx.ac/v1/batch/${courseId}/chapters/${chapterId}/topics?limit=500`,
            `https://api.appx.ac/v1/batch/${courseId}/chapters/${chapterId}/videos?limit=500`,
          ] : [
            `https://${domain}/api/v1/batch/${courseId}/chapters/${chapterId}/videos?limit=500`,
            `https://${domain}/api/v1/batch/${courseId}/subjects/${chapterId}/videos?limit=500`,
            `https://${domain}/api/v1/batch/${courseId}/chapters/${chapterId}/topics?limit=500`,
          ];

          for (const vidUrl of chapterVideoEndpoints) {
            try {
              const vidRaw = await tryGet(vidUrl, cfg);
              const vids = extractArray(vidRaw, ["data", "videos", "topics", "result"]);
              if (vids.length > 0) {
                processItems(vids, course, chapterName);
                break;
              }
            } catch {
              // continue
            }
          }
        }

        if (course.totalLinks > 0) break;
      } catch {
        // continue
      }
    }
  }

  return course;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function extractArray(data: unknown, keys: string[]): Record<string, unknown>[] {
  if (Array.isArray(data)) return data as Record<string, unknown>[];
  if (data && typeof data === "object") {
    const obj = data as Record<string, unknown>;
    // Direct key match
    for (const key of keys) {
      if (Array.isArray(obj[key])) return obj[key] as Record<string, unknown>[];
    }
    // Try nested one level (e.g. { data: { topics: [...] } })
    for (const key of keys) {
      if (obj[key] && typeof obj[key] === "object" && !Array.isArray(obj[key])) {
        const nested = obj[key] as Record<string, unknown>;
        for (const k2 of keys) {
          if (Array.isArray(nested[k2])) return nested[k2] as Record<string, unknown>[];
        }
        // Also check if nested itself is iterable (values)
        const vals = Object.values(nested);
        for (const v of vals) {
          if (Array.isArray(v) && (v as unknown[]).length > 0) return v as Record<string, unknown>[];
        }
      }
    }
    // Fallback: scan all top-level values for first non-empty array
    for (const val of Object.values(obj)) {
      if (Array.isArray(val) && val.length > 0) return val as Record<string, unknown>[];
    }
  }
  return [];
}

function unwrap(data: unknown, keys: string[]): unknown {
  if (!data || typeof data !== "object") return data;
  const obj = data as Record<string, unknown>;
  for (const key of keys) {
    if (obj[key] !== undefined) return obj[key];
  }
  return data;
}

function processItems(items: Record<string, unknown>[], course: AppXCourse, chapterName?: string): void {
  for (const item of items) {
    const lesson: AppXLesson = {
      title: String(
        item["title"] || item["name"] || item["video_name"] || item["topic_name"] || item["lecture_name"] ||
        item["topicName"] || item["videoName"] || "Lecture"
      ),
      chapterName,
    };

    // Unwrap nested video info (AppX sometimes nests video data)
    const videoInfo = (item["videoInfo"] || item["video_info"] || {}) as Record<string, unknown>;
    const mediaInfo = (item["media"] || item["mediaInfo"] || {}) as Record<string, unknown>;

    // Video URL — check direct + nested
    const videoUrl =
      item["video_url"] || item["videoUrl"] || item["video"] ||
      item["lecture_url"] || item["content_url"] || item["url"] ||
      item["videoLink"] || item["video_link"] || item["streamUrl"] || item["stream_url"] ||
      videoInfo["url"] || videoInfo["videoUrl"] || videoInfo["streamUrl"] ||
      mediaInfo["url"] || mediaInfo["videoUrl"];

    // YouTube
    const ytUrl =
      item["youtube_url"] || item["yt_url"] || item["youtubeUrl"] || item["youtube"] ||
      item["youtubeLink"] || item["yt_link"] ||
      videoInfo["youtubeUrl"] || videoInfo["youtube_url"];

    // PDF
    const pdfUrl =
      item["pdf_url"] || item["pdfUrl"] || item["pdf"] ||
      item["file_url"] || item["attachment_url"] || item["notes_url"] ||
      item["pdfLink"] || item["pdf_link"] || item["noteUrl"] || item["note_url"];

    // DRM/encrypted video (AppX uses Bunny/VdoCipher/CloudFront)
    const drmUrl =
      item["drm_url"] || item["encrypted_url"] || item["hls_url"] ||
      item["encryptedUrl"] || item["hlsUrl"] || item["drmUrl"] ||
      item["embedCode"] || item["embed_code"] ||
      videoInfo["hlsUrl"] || videoInfo["drmUrl"];

    if (typeof videoUrl === "string" && videoUrl.trim()) {
      const url = videoUrl.trim();
      if (url.includes("youtube.com") || url.includes("youtu.be")) {
        lesson.youtubeUrl = url;
        course.totalYoutube++;
        course.totalLinks++;
      } else {
        lesson.videoUrl = url;
        course.totalVideos++;
        course.totalLinks++;
      }
    } else if (typeof drmUrl === "string" && drmUrl.trim()) {
      lesson.videoUrl = drmUrl.trim();
      course.totalVideos++;
      course.totalLinks++;
    }

    if (typeof ytUrl === "string" && ytUrl.trim() && !lesson.youtubeUrl) {
      lesson.youtubeUrl = ytUrl.trim();
      if (!lesson.videoUrl) {
        course.totalYoutube++;
        course.totalLinks++;
      }
    }

    if (typeof pdfUrl === "string" && pdfUrl.trim()) {
      lesson.pdfUrl = pdfUrl.trim();
      course.totalPdfs++;
      course.totalLinks++;
    }

    const itemType = String(item["type"] || item["content_type"] || "");
    if (itemType === "test" || itemType === "quiz" || itemType === "assignment") {
      const testUrl = item["test_url"] || item["quiz_url"] || item["link"];
      if (typeof testUrl === "string") {
        lesson.testUrl = testUrl;
        course.totalTests++;
        course.totalLinks++;
      }
    }

    if (lesson.videoUrl || lesson.youtubeUrl || lesson.pdfUrl || lesson.testUrl) {
      course.lessons.push(lesson);
    }
  }
}

// ─── Formatter ────────────────────────────────────────────────────────────────

export function formatAppXTxt(course: AppXCourse): string {
  const now = new Date().toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

  const lines: string[] = [];
  lines.push(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  lines.push(`       📚 COURSE DETAILS`);
  lines.push(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  lines.push(`🏫 Platform  : ${course.platform}`);
  lines.push(`⭐ Course    : ${course.name}`);
  lines.push(`🆔 ID        : ${course.id}`);
  if (course.instructor) lines.push(`👨‍🏫 Instructor : ${course.instructor}`);
  lines.push(``);
  lines.push(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  lines.push(`       🔗 LINK SUMMARY`);
  lines.push(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  lines.push(`🔗 Total Links    : ${course.totalLinks}`);
  lines.push(`🎬 Videos         : ${course.totalVideos}`);
  lines.push(`▶️  YouTube Videos : ${course.totalYoutube}`);
  lines.push(`📄 PDFs           : ${course.totalPdfs}`);
  if (course.totalTests > 0) lines.push(`📝 Tests          : ${course.totalTests}`);
  lines.push(``);

  if (course.lessons.length > 0) {
    lines.push(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    lines.push(`       🎬 VIDEO LINKS`);
    lines.push(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    lines.push(``);

    let lastChapter = "";
    for (const lesson of course.lessons) {
      if (lesson.chapterName && lesson.chapterName !== lastChapter) {
        lines.push(`📁 ${lesson.chapterName}`);
        lines.push(`${"─".repeat(40)}`);
        lastChapter = lesson.chapterName;
      }
      lines.push(`📌 ${lesson.title}`);
      if (lesson.videoUrl) lines.push(`   🎬 ${lesson.videoUrl}`);
      if (lesson.youtubeUrl) lines.push(`   ▶️  ${lesson.youtubeUrl}`);
      if (lesson.pdfUrl) lines.push(`   📄 ${lesson.pdfUrl}`);
      if (lesson.testUrl) lines.push(`   📝 ${lesson.testUrl}`);
      lines.push(``);
    }
  }

  lines.push(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  lines.push(`Generated On: ${now} IST`);
  lines.push(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

  return lines.join("\n");
}
