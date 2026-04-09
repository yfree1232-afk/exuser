import axios from "axios";
import type { Platform } from "./index.js";

interface AppXVideo {
  id: string | number;
  title: string;
  type: string;
  url?: string;
  videoUrl?: string;
  pdfUrl?: string;
  youtubeUrl?: string;
  duration?: number;
  chapter?: string;
}

interface AppXCourse {
  id: string;
  name: string;
  platform: string;
  instructor?: string;
  description?: string;
  videos: AppXVideo[];
  totalLinks: number;
  totalVideos: number;
  totalPdfs: number;
  totalTests: number;
  totalYoutube: number;
}

function getAppXHeaders(domain: string) {
  return {
    "User-Agent": "AppX/5.0 Dart/3.2",
    Host: domain,
    Accept: "application/json, text/plain, */*",
    "Content-Type": "application/json",
  };
}

export async function extractAppXCourse(
  courseId: string,
  platform: Platform,
): Promise<AppXCourse> {
  const domain = platform.domain;
  const base = `https://${domain}`;
  const headers = getAppXHeaders(domain);

  const course: AppXCourse = {
    id: courseId,
    name: `Course ${courseId}`,
    platform: platform.name,
    videos: [],
    totalLinks: 0,
    totalVideos: 0,
    totalPdfs: 0,
    totalTests: 0,
    totalYoutube: 0,
  };

  // Try to get course details
  try {
    const res = await axios.get(
      `${base}/api/v1/course/${courseId}`,
      { headers, timeout: 15000 },
    );
    const data = res.data?.data || res.data?.course || res.data;
    if (data) {
      course.name = data.title || data.name || course.name;
      course.instructor = data.teacher_name || data.instructor;
      course.description = data.description;
    }
  } catch {
    // try alternate endpoint
    try {
      const res = await axios.get(
        `${base}/api/course?id=${courseId}`,
        { headers, timeout: 15000 },
      );
      const data = res.data?.data || res.data;
      if (data) {
        course.name = data.title || data.name || course.name;
        course.instructor = data.teacher_name || data.instructor;
      }
    } catch {
      // ignore
    }
  }

  // Get videos/content
  const videoEndpoints = [
    `${base}/api/v1/course/${courseId}/videos?limit=1000&page=1`,
    `${base}/api/v1/course/${courseId}/lessons?limit=1000&page=1`,
    `${base}/api/coursevideo?courseid=${courseId}&limit=1000&page=1`,
    `${base}/data/coursevideo?courseid=${courseId}&limit=1000&page=1`,
  ];

  let contentFetched = false;
  for (const endpoint of videoEndpoints) {
    if (contentFetched) break;
    try {
      const res = await axios.get(endpoint, { headers, timeout: 20000 });
      const items = res.data?.data || res.data?.videos || res.data?.lessons || res.data || [];
      if (Array.isArray(items) && items.length > 0) {
        processAppXItems(items, course);
        contentFetched = true;
      }
    } catch {
      // try next endpoint
    }
  }

  // Get chapters/subjects if no videos found directly
  if (!contentFetched) {
    try {
      const chapRes = await axios.get(
        `${base}/api/v1/course/${courseId}/chapters`,
        { headers, timeout: 15000 },
      );
      const chapters = chapRes.data?.data || chapRes.data || [];
      for (const chapter of Array.isArray(chapters) ? chapters : []) {
        const chapterId = chapter.id || chapter._id;
        const chapterName = chapter.title || chapter.name || "Chapter";
        try {
          const vidRes = await axios.get(
            `${base}/api/v1/course/${courseId}/chapters/${chapterId}/videos?limit=500`,
            { headers, timeout: 15000 },
          );
          const vids = vidRes.data?.data || vidRes.data || [];
          if (Array.isArray(vids)) {
            processAppXItems(vids, course, chapterName);
          }
        } catch {
          // ignore
        }
      }
    } catch {
      // ignore
    }
  }

  return course;
}

function processAppXItems(
  items: Record<string, unknown>[],
  course: AppXCourse,
  chapterName?: string,
): void {
  for (const item of items) {
    const video: AppXVideo = {
      id: String(item.id || item._id || ""),
      title: String(item.title || item.name || item.video_name || "Lecture"),
      type: String(item.type || item.content_type || "video"),
      chapter: chapterName,
    };

    const rawVideoUrl = item.video_url || item.videoUrl || item.url || item.video;
    const rawPdfUrl = item.pdf_url || item.pdfUrl || item.file_url;
    const rawYtUrl = item.youtube_url || item.yt_url;

    if (rawVideoUrl && typeof rawVideoUrl === "string") {
      video.videoUrl = rawVideoUrl;
      video.url = rawVideoUrl;
      if (rawVideoUrl.includes("youtube.com") || rawVideoUrl.includes("youtu.be")) {
        course.totalYoutube++;
        video.youtubeUrl = rawVideoUrl;
      } else {
        course.totalVideos++;
      }
      course.totalLinks++;
    }

    if (rawPdfUrl && typeof rawPdfUrl === "string") {
      video.pdfUrl = rawPdfUrl;
      if (!video.url) video.url = rawPdfUrl;
      course.totalPdfs++;
      course.totalLinks++;
    }

    if (rawYtUrl && typeof rawYtUrl === "string") {
      video.youtubeUrl = rawYtUrl;
      if (!video.url) {
        video.url = rawYtUrl;
        course.totalYoutube++;
        course.totalLinks++;
      }
    }

    if (video.type === "test" || video.type === "quiz") {
      course.totalTests++;
    }

    if (video.url || video.videoUrl || video.pdfUrl || video.youtubeUrl) {
      course.videos.push(video);
    }
  }
}

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
  lines.push(`━━━━━━━━━━━━━━━━━━━━`);
  lines.push(`   COURSE DETAILS`);
  lines.push(`━━━━━━━━━━━━━━━━━━━━`);
  lines.push(`📚 Platform: ${course.platform}`);
  lines.push(`⭐ Course: ${course.name}`);
  lines.push(`🆔 ID: ${course.id}`);
  if (course.instructor) lines.push(`👨‍🏫 Instructor: ${course.instructor}`);
  lines.push("");
  lines.push(`━━━━━━━━━━━━━━━━━━━━`);
  lines.push(`   LINK SUMMARY`);
  lines.push(`━━━━━━━━━━━━━━━━━━━━`);
  lines.push(`🔗 Total Links: ${course.totalLinks}`);
  lines.push(`🎬 Total Videos: ${course.totalVideos}`);
  lines.push(`▶️  YouTube Videos: ${course.totalYoutube}`);
  lines.push(`📄 Total PDFs: ${course.totalPdfs}`);
  if (course.totalTests > 0) lines.push(`📝 Total Tests: ${course.totalTests}`);
  lines.push("");
  lines.push(`━━━━━━━━━━━━━━━━━━━━`);
  lines.push(`   VIDEO LINKS`);
  lines.push(`━━━━━━━━━━━━━━━━━━━━`);
  lines.push("");

  let lastChapter = "";
  for (const video of course.videos) {
    if (video.chapter && video.chapter !== lastChapter) {
      lines.push(`📁 ${video.chapter}`);
      lines.push(`${"─".repeat(30)}`);
      lastChapter = video.chapter;
    }
    lines.push(`📌 ${video.title}`);
    if (video.videoUrl && !video.youtubeUrl) lines.push(`   🎬 ${video.videoUrl}`);
    if (video.youtubeUrl) lines.push(`   ▶️  ${video.youtubeUrl}`);
    if (video.pdfUrl) lines.push(`   📄 ${video.pdfUrl}`);
    lines.push("");
  }

  lines.push(`━━━━━━━━━━━━━━━━━━━━`);
  lines.push(`Generated On: ${now} IST`);
  lines.push(`━━━━━━━━━━━━━━━━━━━━`);

  return lines.join("\n");
}
