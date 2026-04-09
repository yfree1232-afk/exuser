import axios from "axios";

interface PinnacleLesson {
  title: string;
  type: string;
  url?: string;
  videoUrl?: string;
  pdfUrl?: string;
}

interface PinnacleCourse {
  id: string;
  name: string;
  category?: string;
  subject?: string;
  instructor?: string;
  price?: number;
  mrp?: number;
  rating?: number;
  reviewCount?: number;
  lessons: PinnacleLesson[];
  totalLinks: number;
  totalVideos: number;
  totalPdfs: number;
}

const BASE = "https://api.pinnacle.ac/v1";
const HEADERS = {
  "User-Agent":
    "Dart/3.2 (dart:io) PinnacleApp/7.0.0",
  Accept: "application/json",
};

export async function extractPinnacleCourse(
  courseId: string,
): Promise<PinnacleCourse> {
  let courseInfo: Partial<PinnacleCourse> = {
    id: courseId,
    name: `Course ${courseId}`,
    lessons: [],
    totalLinks: 0,
    totalVideos: 0,
    totalPdfs: 0,
  };

  try {
    const detailRes = await axios.get(`${BASE}/batch/${courseId}`, {
      headers: HEADERS,
      timeout: 15000,
    });

    const data = detailRes.data?.data || detailRes.data;
    if (data) {
      courseInfo.name = data.name || data.title || courseInfo.name;
      courseInfo.category = data.category?.name || data.category;
      courseInfo.subject = data.subject;
      courseInfo.instructor = data.instructor?.name || data.teacher?.name;
      courseInfo.price = data.price;
      courseInfo.mrp = data.mrp || data.original_price;
      courseInfo.rating = data.rating;
      courseInfo.reviewCount = data.review_count || data.totalReviews;
    }
  } catch {
    // ignore detail fetch error, try subjects
  }

  try {
    const subjectsRes = await axios.get(`${BASE}/batch/${courseId}/subjects`, {
      headers: HEADERS,
      timeout: 15000,
    });
    const subjects = subjectsRes.data?.data || subjectsRes.data || [];

    for (const subject of Array.isArray(subjects) ? subjects : []) {
      const subjectId = subject.id || subject._id;
      const subjectName = subject.name || subject.title || "Subject";

      try {
        const lecturesRes = await axios.get(
          `${BASE}/batch/${courseId}/subjects/${subjectId}`,
          { headers: HEADERS, timeout: 15000 },
        );
        const lectures = lecturesRes.data?.data || lecturesRes.data || [];

        for (const lecture of Array.isArray(lectures) ? lectures : []) {
          const lesson: PinnacleLesson = {
            title: `[${subjectName}] ${lecture.title || lecture.name || "Lecture"}`,
            type: lecture.type || "video",
          };

          if (lecture.video_url || lecture.videoUrl) {
            lesson.videoUrl = lecture.video_url || lecture.videoUrl;
            lesson.url = lesson.videoUrl;
            courseInfo.totalVideos = (courseInfo.totalVideos || 0) + 1;
          }
          if (lecture.pdf_url || lecture.pdfUrl) {
            lesson.pdfUrl = lecture.pdf_url || lecture.pdfUrl;
            if (!lesson.url) lesson.url = lesson.pdfUrl;
            courseInfo.totalPdfs = (courseInfo.totalPdfs || 0) + 1;
          }

          if (lesson.url) {
            courseInfo.lessons!.push(lesson);
            courseInfo.totalLinks = (courseInfo.totalLinks || 0) + 1;
          }
        }
      } catch {
        // ignore lecture fetch errors
      }
    }
  } catch {
    // Try flat topics endpoint
    try {
      const topicsRes = await axios.get(`${BASE}/batch/${courseId}/topics`, {
        headers: HEADERS,
        timeout: 15000,
      });
      const topics = topicsRes.data?.data || topicsRes.data || [];
      for (const topic of Array.isArray(topics) ? topics : []) {
        const lesson: PinnacleLesson = {
          title: topic.title || topic.name || "Lecture",
          type: topic.type || "video",
          url: topic.video_url || topic.url || topic.videoUrl,
        };
        if (lesson.url) {
          courseInfo.lessons!.push(lesson);
          courseInfo.totalLinks = (courseInfo.totalLinks || 0) + 1;
          if (topic.type === "pdf" || topic.pdfUrl) {
            courseInfo.totalPdfs = (courseInfo.totalPdfs || 0) + 1;
          } else {
            courseInfo.totalVideos = (courseInfo.totalVideos || 0) + 1;
          }
        }
      }
    } catch {
      // no data
    }
  }

  return courseInfo as PinnacleCourse;
}

export function formatPinnacleTxt(course: PinnacleCourse): string {
  const now = new Date().toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

  const lines: string[] = [];
  lines.push(`⭐ Course : ${course.name}`);
  lines.push(`🆔 ID: ${course.id}`);
  if (course.category) lines.push(`📂 Category: ${course.category}`);
  if (course.subject) lines.push(`📚 Subject: ${course.subject}`);
  if (course.instructor) lines.push(`👨‍🏫 Instructor: ${course.instructor}`);
  if (course.price != null)
    lines.push(
      `💰 Price: ₹${course.price}${course.mrp ? ` (MRP: ₹${course.mrp})` : ""}`,
    );
  if (course.rating != null)
    lines.push(
      `⭐ Rating: ${course.rating}${course.reviewCount ? ` (${course.reviewCount} reviews)` : ""}`,
    );
  lines.push("");
  lines.push("━━━━━━━━━━━━━━━━━━━━");
  lines.push("         LINK SUMMARY");
  lines.push("━━━━━━━━━━━━━━━━━━━━");
  lines.push(`🔗 Total Number of Links: ${course.totalLinks}`);
  lines.push(`🎬 Total Videos: ${course.totalVideos}`);
  lines.push(`📄 Total PDFs: ${course.totalPdfs}`);
  lines.push("");
  lines.push("━━━━━━━━━━━━━━━━━━━━");
  lines.push("           LINKS");
  lines.push("━━━━━━━━━━━━━━━━━━━━");
  lines.push("");

  for (const lesson of course.lessons) {
    lines.push(`📌 ${lesson.title}`);
    if (lesson.videoUrl) lines.push(`   🎬 Video: ${lesson.videoUrl}`);
    if (lesson.pdfUrl) lines.push(`   📄 PDF: ${lesson.pdfUrl}`);
    if (lesson.url && !lesson.videoUrl && !lesson.pdfUrl)
      lines.push(`   🔗 ${lesson.url}`);
    lines.push("");
  }

  lines.push("━━━━━━━━━━━━━━━━━━━━");
  lines.push(`Generated On: ${now} IST`);
  lines.push("━━━━━━━━━━━━━━━━━━━━");

  return lines.join("\n");
}
