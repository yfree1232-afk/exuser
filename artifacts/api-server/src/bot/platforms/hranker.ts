import axios, { type AxiosRequestConfig } from "axios";
import { logger } from "../../lib/logger.js";

const HRANKER_API = "https://www.hranker.com/admin/api";

export interface HRankerUser {
  userId: string;
  token: string;
  name: string;
  subdomain: string;
}

export interface HRankerCourse {
  id: string;
  name: string;
  thumbnail?: string;
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

export async function hrankerLogin(email: string, password: string, subdomain: string): Promise<HRankerUser> {
  const cfg = makeConfig(subdomain);
  const url = `${HRANKER_API}/user-login`;

  const res = await axios.post(url, { email, password }, cfg);
  const data = res.data as Record<string, unknown>;

  if (!data || data["state"] !== 200) {
    const msg = String(data?.["msg"] || data?.["message"] || "Login failed");
    throw new Error(msg);
  }

  const userData = (data["userData"] || data["data"] || data["user"]) as Record<string, unknown>;
  if (!userData) throw new Error("User data missing in login response");

  const userId = String(userData["id"] || userData["user_id"] || userData["userId"] || "");
  const name = String(userData["name"] || userData["full_name"] || userData["username"] || email);
  const token = String(data["token"] || userData["token"] || userData["auth_token"] || userId);

  if (!userId) throw new Error("Could not extract user ID from login response");

  return { userId, token, name, subdomain };
}

export async function listHRankerCourses(user: HRankerUser): Promise<HRankerCourse[]> {
  const cfg = makeConfig(user.subdomain);
  const courses: HRankerCourse[] = [];

  const endpoints = [
    `${HRANKER_API}/user-package/${user.userId}/0`,
    `${HRANKER_API}/packages/${user.userId}/0`,
    `${HRANKER_API}/packages-data/${user.userId}/0`,
    `${HRANKER_API}/main-menu`,
  ];

  for (const url of endpoints) {
    try {
      const res = await axios.get(url, cfg);
      const data = res.data as Record<string, unknown>;
      if (!data || data["state"] === 404 || data["state"] === 400) continue;

      const items = extractArray(data, ["data", "packages", "package", "result", "courses", "menu"]);
      if (items.length > 0) {
        for (const item of items) {
          const id = String(item["id"] || item["package_id"] || item["course_id"] || "");
          const name = String(item["name"] || item["title"] || item["package_name"] || item["course_name"] || "");
          if (id && name) {
            courses.push({ id, name, thumbnail: String(item["thumbnail"] || item["image"] || "") });
          }
        }
        if (courses.length > 0) break;
      }
    } catch (err) {
      logger.debug({ err, url }, "HRanker course list endpoint failed");
    }
  }

  return courses;
}

export async function extractHRankerCourse(courseId: string, user: HRankerUser, platformName: string): Promise<HRankerExtractedCourse> {
  const cfg = makeConfig(user.subdomain);

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

  // Step 1: Get package details
  const detailEndpoints = [
    `${HRANKER_API}/package-detail/${courseId}`,
    `${HRANKER_API}/packages/${user.userId}/${courseId}`,
  ];

  for (const url of detailEndpoints) {
    try {
      const res = await axios.get(url, cfg);
      const data = res.data as Record<string, unknown>;
      const detail = unwrap(data, ["data", "package", "result"]) as Record<string, unknown>;
      if (detail && detail["name"]) {
        result.name = String(detail["name"] || detail["title"] || result.name);
        break;
      }
    } catch {
      // continue
    }
  }

  // Step 2: Get series/chapters
  const seriesEndpoints = [
    `${HRANKER_API}/package-series/${user.userId}/${courseId}`,
    `${HRANKER_API}/home-series/${user.userId}/${courseId}`,
    `${HRANKER_API}/user-series/${user.userId}`,
  ];

  let seriesItems: Record<string, unknown>[] = [];

  for (const url of seriesEndpoints) {
    try {
      const res = await axios.get(url, cfg);
      const data = res.data as Record<string, unknown>;
      if (!data || data["state"] === 404 || data["state"] === 400) continue;

      const items = extractArray(data, ["data", "series", "chapters", "sections", "result"]);
      if (items.length > 0) {
        seriesItems = items;
        break;
      }
    } catch {
      // continue
    }
  }

  // Step 3: For each series item, get study-data (videos/PDFs)
  for (const series of seriesItems) {
    const seriesId = String(series["id"] || series["series_id"] || "");
    const seriesName = String(series["name"] || series["title"] || series["series_name"] || "Section");

    if (!seriesId) continue;

    const studyEndpoints = [
      `${HRANKER_API}/study-data/${seriesId}`,
      `${HRANKER_API}/study-detail/${seriesId}`,
      `${HRANKER_API}/get-tab-package-series/${user.userId}/${courseId}/${seriesId}`,
    ];

    for (const url of studyEndpoints) {
      try {
        const res = await axios.get(url, cfg);
        const data = res.data as Record<string, unknown>;
        if (!data || data["state"] === 404 || data["state"] === 400) continue;

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

  // Fallback: try direct package-series-load for all content at once
  if (result.totalLinks === 0) {
    try {
      const url = `${HRANKER_API}/package-series-load/${user.userId}/${courseId}/0/1000`;
      const res = await axios.get(url, cfg);
      const data = res.data as Record<string, unknown>;
      const items = extractArray(data, ["data", "topics", "videos", "content", "result"]);
      if (items.length > 0) {
        processTopics(items, result);
      }
    } catch {
      // ignore
    }
  }

  return result;
}

function processTopics(items: Record<string, unknown>[], result: HRankerExtractedCourse, sectionName?: string): void {
  for (const item of items) {
    const lesson: HRankerLesson = {
      title: String(
        item["name"] || item["title"] || item["topic_name"] || item["video_name"] || "Lecture"
      ),
      sectionName,
    };

    const videoUrl = item["video_url"] || item["videoUrl"] || item["url"] || item["video"] || item["content_url"];
    const pdfUrl = item["pdf_url"] || item["pdfUrl"] || item["file_url"] || item["pdf"] || item["notes_url"];
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
  }

  lines.push(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  lines.push(`Generated On: ${now} IST`);
  lines.push(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

  return lines.join("\n");
}
