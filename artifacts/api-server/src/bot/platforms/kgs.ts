import axios from "axios";

interface KGSLesson {
  title: string;
  url?: string;
  pdfUrl?: string;
  chapter?: string;
}

interface KGSCourse {
  id: string;
  name: string;
  instructor?: string;
  lessons: KGSLesson[];
  totalLinks: number;
  totalVideos: number;
  totalPdfs: number;
}

export async function extractKGSCourse(courseId: string): Promise<KGSCourse> {
  const course: KGSCourse = {
    id: courseId,
    name: `Course ${courseId}`,
    lessons: [],
    totalLinks: 0,
    totalVideos: 0,
    totalPdfs: 0,
  };

  const headers = {
    "User-Agent": "Mozilla/5.0 (Linux; Android 11)",
    Accept: "application/json",
  };

  const endpoints = [
    `https://kgs.ac/api/course/${courseId}`,
    `https://api.kgs.ac/v1/course/${courseId}`,
    `https://kgs.ac/api/batch/${courseId}/videos`,
  ];

  for (const endpoint of endpoints) {
    try {
      const res = await axios.get(endpoint, { headers, timeout: 15000 });
      const data = res.data?.data || res.data;
      if (data) {
        if (data.title || data.name) {
          course.name = data.title || data.name;
          course.instructor = data.teacher || data.instructor;
        }
        const items = data.videos || data.lessons || (Array.isArray(data) ? data : []);
        for (const item of items) {
          const lesson: KGSLesson = {
            title: item.title || item.name || "Lecture",
          };
          if (item.video_url || item.url) {
            lesson.url = item.video_url || item.url;
            course.totalVideos++;
            course.totalLinks++;
          }
          if (item.pdf_url) {
            lesson.pdfUrl = item.pdf_url;
            course.totalPdfs++;
            course.totalLinks++;
          }
          if (lesson.url || lesson.pdfUrl) course.lessons.push(lesson);
        }
        if (course.lessons.length > 0) break;
      }
    } catch {
      // try next
    }
  }

  return course;
}

export function formatKGSTxt(course: KGSCourse): string {
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
  lines.push(`   COURSE DETAILS — KGS`);
  lines.push(`━━━━━━━━━━━━━━━━━━━━`);
  lines.push(`⭐ Course: ${course.name}`);
  lines.push(`🆔 ID: ${course.id}`);
  if (course.instructor) lines.push(`👨‍🏫 Instructor: ${course.instructor}`);
  lines.push(``);
  lines.push(`━━━━━━━━━━━━━━━━━━━━`);
  lines.push(`   LINK SUMMARY`);
  lines.push(`━━━━━━━━━━━━━━━━━━━━`);
  lines.push(`🔗 Total Links: ${course.totalLinks}`);
  lines.push(`🎬 Videos: ${course.totalVideos}`);
  lines.push(`📄 PDFs: ${course.totalPdfs}`);
  lines.push(``);
  lines.push(`━━━━━━━━━━━━━━━━━━━━`);
  lines.push(`   LINKS`);
  lines.push(`━━━━━━━━━━━━━━━━━━━━`);
  lines.push(``);
  for (const l of course.lessons) {
    lines.push(`📌 ${l.title}`);
    if (l.url) lines.push(`   🎬 ${l.url}`);
    if (l.pdfUrl) lines.push(`   📄 ${l.pdfUrl}`);
    lines.push(``);
  }
  lines.push(`━━━━━━━━━━━━━━━━━━━━`);
  lines.push(`Generated On: ${now} IST`);
  lines.push(`━━━━━━━━━━━━━━━━━━━━`);
  return lines.join("\n");
}
