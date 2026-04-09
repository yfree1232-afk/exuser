import axios from "axios";
import { logger } from "../../lib/logger.js";

const API_BASE = "https://api.classplusapp.com";
const CDN_BASE = "https://d2a5xnk4s7n8a6.cloudfront.net";

const HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json",
  "x-access-token": "",
  "x-device-type": "ANDROID",
  "x-app-version": "1.6.2.1",
  "User-Agent": "ClassPlus/1.6.2 Android",
};

// ─── URL Parsing ──────────────────────────────────────────────────────────────

export interface ClassPlusUrl {
  orgHexId: string;   // MongoDB ObjectId of org
  courseHexId: string; // MongoDB ObjectId of course
  userId?: string;
  type: "cdn" | "course";
}

/**
 * Parse a ClassPlus CDN or course URL
 * CDN: https://d2a5xnk4s7n8a6.cloudfront.net/m/o/{orgId}/v/{courseId}/u/{userId}/p/...
 * Course: https://{domain}/courses/{slug}--{courseId}
 */
export function parseClassPlusUrl(url: string): ClassPlusUrl | null {
  try {
    // CDN URL pattern
    const cdnMatch = url.match(
      /d2a5xnk4s7n8a6\.cloudfront\.net\/m\/o\/([a-f0-9]{24})\/v\/([a-f0-9]{24})(?:\/u\/([a-f0-9]{24}))?/
    );
    if (cdnMatch) {
      return {
        orgHexId: cdnMatch[1],
        courseHexId: cdnMatch[2],
        userId: cdnMatch[3],
        type: "cdn",
      };
    }
    // Course page URL: ends with --{hexId}
    const courseMatch = url.match(/--([a-f0-9]{24})(?:\?|$|\/)/);
    if (courseMatch) {
      return {
        orgHexId: "",
        courseHexId: courseMatch[1],
        type: "course",
      };
    }
    return null;
  } catch {
    return null;
  }
}

// ─── Org Settings ─────────────────────────────────────────────────────────────

export interface OrgSettings {
  orgId: number;
  orgCode: string;
  name: string;
  isMobileVerificationRequired: boolean;
}

export async function getOrgSettings(orgCode: string): Promise<OrgSettings | null> {
  try {
    const res = await axios.get(
      `${API_BASE}/v2/org/settings/login/${orgCode}`,
      { headers: HEADERS, timeout: 10000 }
    );
    if (res.data?.status === "success") {
      const d = res.data.data;
      return {
        orgId: d.orgId || 0,
        orgCode,
        name: d.name || orgCode,
        isMobileVerificationRequired: !!d.isMobileVerificationRequired,
      };
    }
    return null;
  } catch (err) {
    logger.warn({ err, orgCode }, "ClassPlus: Failed to get org settings");
    return null;
  }
}

// ─── OTP Flow ─────────────────────────────────────────────────────────────────

export async function sendOtp(
  mobile: string,
  orgId: number,
  countryCode = "+91"
): Promise<{ success: boolean; message: string }> {
  try {
    const res = await axios.post(
      `${API_BASE}/v2/otp/generate`,
      { countryCode, mobileNumber: mobile, orgId },
      { headers: HEADERS, timeout: 10000 }
    );
    logger.info({ mobile, orgId, status: res.data?.status }, "ClassPlus: OTP send");
    if (res.data?.status === "success") {
      return { success: true, message: "OTP sent" };
    }
    return { success: false, message: res.data?.message || "Failed to send OTP" };
  } catch (err: any) {
    logger.error({ err: err?.message }, "ClassPlus: sendOtp failed");
    return { success: false, message: err?.response?.data?.message || "Network error" };
  }
}

export interface ClassPlusUser {
  token: string;
  userId: string;
  orgId: number;
  name?: string;
}

export async function verifyOtp(
  mobile: string,
  otp: string,
  orgId: number,
  countryCode = "+91"
): Promise<ClassPlusUser | null> {
  try {
    // Try users/login endpoint (OTP verification)
    const res = await axios.post(
      `${API_BASE}/users/login`,
      { countryCode, mobileNumber: mobile, otp, orgId },
      { headers: HEADERS, timeout: 10000 }
    );
    logger.info({ mobile, orgId, status: res.data?.status }, "ClassPlus: OTP verify");
    if (res.data?.status === "success") {
      const d = res.data.data;
      return {
        token: d.token || d.accessToken || "",
        userId: String(d.id || d.userId || ""),
        orgId,
        name: d.name,
      };
    }
    return null;
  } catch (err: any) {
    logger.error({ err: err?.message }, "ClassPlus: verifyOtp failed");
    return null;
  }
}

// ─── Course Content ───────────────────────────────────────────────────────────

export interface ClassPlusContentItem {
  id: string;
  name: string;
  type: "video" | "pdf" | "folder" | "other";
  url?: string;
  folderId?: string;
  date?: string;
}

export async function getCourseContent(
  token: string,
  courseId: string
): Promise<ClassPlusContentItem[]> {
  try {
    const res = await axios.get(`${API_BASE}/v2/course/content/get`, {
      params: { courseId },
      headers: { ...HEADERS, "x-access-token": token },
      timeout: 15000,
    });
    logger.info({ courseId, status: res.data?.status }, "ClassPlus: getCourseContent");
    if (res.data?.status !== "success") return [];

    const items: ClassPlusContentItem[] = [];
    const data = res.data.data || {};

    // ClassPlus returns sections/folders with items
    const sections = Array.isArray(data) ? data : data.sections || data.content || [];
    for (const section of sections) {
      const sectionName = section.name || section.title || "";
      const children = section.children || section.items || section.content || [];
      for (const item of children) {
        items.push(parseContentItem(item, sectionName));
      }
      // If section itself is a content item
      if (!children.length && section.type) {
        items.push(parseContentItem(section, ""));
      }
    }
    return items;
  } catch (err: any) {
    logger.error({ err: err?.message, courseId }, "ClassPlus: getCourseContent failed");
    return [];
  }
}

function parseContentItem(item: any, folder: string): ClassPlusContentItem {
  const type = detectType(item);
  return {
    id: String(item._id || item.id || ""),
    name: item.name || item.title || "Untitled",
    type,
    folderId: folder,
    url: item.url || item.videoUrl || item.pdfUrl || "",
    date: item.createdAt || item.uploadedAt || "",
  };
}

function detectType(item: any): ClassPlusContentItem["type"] {
  const t = (item.type || item.contentType || "").toLowerCase();
  if (t.includes("video") || t === "mp4" || t === "hls") return "video";
  if (t.includes("pdf") || t.includes("document")) return "pdf";
  if (t.includes("folder") || t.includes("section")) return "folder";
  return "other";
}

// ─── CDN URL Builder ──────────────────────────────────────────────────────────

export function buildPdfUrl(
  orgHexId: string,
  courseHexId: string,
  contentHexId: string,
  date: string,   // "2026/04/08"
  userHexId = "000000000000000000000000"
): string {
  return `${CDN_BASE}/m/o/${orgHexId}/v/${courseHexId}/u/${userHexId}/p/assets/pdfs/${date}/${contentHexId}/file.pdf`;
}

export function buildVideoUrl(
  orgHexId: string,
  courseHexId: string,
  contentHexId: string,
  date: string,
  userHexId = "000000000000000000000000"
): string {
  return `${CDN_BASE}/m/o/${orgHexId}/v/${courseHexId}/u/${userHexId}/p/assets/videos/${date}/${contentHexId}/master.m3u8`;
}

// ─── Full Extraction ──────────────────────────────────────────────────────────

export interface ClassPlusExtractResult {
  courseName: string;
  totalVideos: number;
  totalPdfs: number;
  lines: string[];
}

export async function extractCourseContent(
  token: string,
  orgHexId: string,
  courseHexId: string
): Promise<ClassPlusExtractResult> {
  const items = await getCourseContent(token, courseHexId);
  const lines: string[] = [];
  let totalVideos = 0;
  let totalPdfs = 0;

  for (const item of items) {
    if (item.type === "video" && item.url) {
      lines.push(`[VIDEO] ${item.folderId ? item.folderId + " > " : ""}${item.name} : ${item.url}`);
      totalVideos++;
    } else if (item.type === "pdf" && item.url) {
      lines.push(`[PDF] ${item.folderId ? item.folderId + " > " : ""}${item.name} : ${item.url}`);
      totalPdfs++;
    }
  }

  return {
    courseName: courseHexId,
    totalVideos,
    totalPdfs,
    lines,
  };
}
