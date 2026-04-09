import axios from "axios";
import type { Platform } from "./index.js";

interface VidCryptLesson {
  title: string;
  type: string;
  url?: string;
  pdfUrl?: string;
  chapter?: string;
}

interface VidCryptCourse {
  id: string;
  name: string;
  platform: string;
  instructor?: string;
  lessons: VidCryptLesson[];
  totalLinks: number;
  totalVideos: number;
  totalPdfs: number;
}

export async function extractVidCryptCourse(
  courseId: string,
  platform: Platform,
): Promise<VidCryptCourse> {
  const domain = platform.domain;
  const base = `https://${domain}`;
  const course: VidCryptCourse = {
    id: courseId,
    name: `Course ${courseId}`,
    platform: platform.name,
    lessons: [],
    totalLinks: 0,
    totalVideos: 0,
    totalPdfs: 0,
  };

  const headers = {
    "User-Agent": "Mozilla/5.0 (Linux; Android 11) AppleWebKit/537.36",
    Accept: "application/json",
    Origin: base,
    Referer: base + "/",
  };

  // Try common VidCrypt API endpoints
  const endpoints = [
    `${base}/api/course/${courseId}`,
    `${base}/api/v1/course/${courseId}`,
    `${base}/course/details?id=${courseId}`,
    `${base}/api/batch/${courseId}`,
  ];

  for (const endpoint of endpoints) {
    try {
      const res = await axios.get(endpoint, { headers, timeout: 15000 });
      const data = res.data?.data || res.data?.course || res.data;
      if (data && (data.title || data.name)) {
        course.name = data.title || data.name;
        course.instructor = data.teacher || data.instructor;
        break;
      }
    } catch {
      // try next
    }
  }

  // Try to get lectures
  const lectureEndpoints = [
    `${base}/api/course/${courseId}/lectures?limit=500`,
    `${base}/api/v1/course/${courseId}/videos?limit=500`,
    `${base}/api/batch/${courseId}/subjects`,
    `${base}/course/content?id=${courseId}`,
  ];

  for (const endpoint of lectureEndpoints) {
    try {
      const res = await axios.get(endpoint, { headers, timeout: 20000 });
      const items =
        res.data?.data ||
        res.data?.lectures ||
        res.data?.videos ||
        res.data?.subjects ||
        res.data ||
        [];

      if (Array.isArray(items) && items.length > 0) {
        for (const item of items) {
          const lesson: VidCryptLesson = {
            title: String(item.title || item.name || item.lecture_title || "Lecture"),
            type: String(item.type || "video"),
          };

          const rawUrl =
            item.video_url ||
            item.videoUrl ||
            item.url ||
            item.lecture_url;
          const rawPdf = item.pdf_url || item.pdfUrl || item.file_url;

          if (rawUrl && typeof rawUrl === "string") {
            lesson.url = rawUrl;
            course.totalVideos++;
            course.totalLinks++;
          }
          if (rawPdf && typeof rawPdf === "string") {
            lesson.pdfUrl = rawPdf;
            if (!lesson.url) lesson.url = rawPdf;
            course.totalPdfs++;
            course.totalLinks++;
          }

          if (lesson.url || lesson.pdfUrl) {
            course.lessons.push(lesson);
          }
        }
        if (course.lessons.length > 0) break;
      }
    } catch {
      // try next
    }
  }

  return course;
}

export function formatVidCryptTxt(course: VidCryptCourse): string {
  const now = new Date().toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

  const lines: string[] = [];
  lines.push(`━━━━━━━━━━━━━━━━━━━━`);
  lines.push(`   COURSE DETAILS`);
  lines.push(`━━━━━━━━━━━━━━━━━━━━`);
  lines.push(`🎓 Platform: ${course.platform}`);
  lines.push(`⭐ Course: ${course.name}`);
  lines.push(`🆔 ID: ${course.id}`);
  if (course.instructor) lines.push(`👨‍🏫 Instructor: ${course.instructor}`);
  lines.push("");
  lines.push(`━━━━━━━━━━━━━━━━━━━━`);
  lines.push(`   LINK SUMMARY`);
  lines.push(`━━━━━━━━━━━━━━━━━━━━`);
  lines.push(`🔗 Total Links: ${course.totalLinks}`);
  lines.push(`🎬 Total Videos: ${course.totalVideos}`);
  lines.push(`📄 Total PDFs: ${course.totalPdfs}`);
  lines.push("");
  lines.push(`━━━━━━━━━━━━━━━━━━━━`);
  lines.push(`   LINKS`);
  lines.push(`━━━━━━━━━━━━━━━━━━━━`);
  lines.push("");

  for (const lesson of course.lessons) {
    lines.push(`📌 ${lesson.title}`);
    if (lesson.url && lesson.url === lesson.pdfUrl) {
      lines.push(`   📄 ${lesson.url}`);
    } else {
      if (lesson.url) lines.push(`   🎬 ${lesson.url}`);
      if (lesson.pdfUrl) lines.push(`   📄 ${lesson.pdfUrl}`);
    }
    lines.push("");
  }

  lines.push(`━━━━━━━━━━━━━━━━━━━━`);
  lines.push(`Generated On: ${now} IST`);
  lines.push(`━━━━━━━━━━━━━━━━━━━━`);

  return lines.join("\n");
}
