import axios from "axios";

interface UnaLesson {
  title: string;
  type: string;
  url?: string;
  duration?: number;
}

interface UnaCourse {
  id: string;
  name: string;
  instructor?: string;
  lessons: UnaLesson[];
  totalLinks: number;
  totalVideos: number;
  totalPdfs: number;
}

export async function extractUnacademyCourse(courseId: string): Promise<UnaCourse> {
  const course: UnaCourse = {
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
    "X-Source": "web",
  };

  try {
    const res = await axios.get(
      `https://api.unacademy.com/api/v2/course/details/?uid=${courseId}`,
      { headers, timeout: 15000 },
    );
    const data = res.data?.result || res.data;
    if (data) {
      course.name = data.title || data.name || course.name;
      course.instructor = data.educators?.[0]?.name;
    }
  } catch {
    // ignore
  }

  try {
    const res = await axios.get(
      `https://api.unacademy.com/api/v2/course/${courseId}/lessons/?limit=500`,
      { headers, timeout: 20000 },
    );
    const lessons = res.data?.result || res.data?.lessons || res.data || [];
    for (const l of Array.isArray(lessons) ? lessons : []) {
      const lesson: UnaLesson = {
        title: l.title || l.name || "Lesson",
        type: l.type || "video",
        duration: l.duration,
      };
      if (l.video_url || l.url) {
        lesson.url = l.video_url || l.url;
        course.totalVideos++;
        course.totalLinks++;
      }
      if (lesson.url) course.lessons.push(lesson);
    }
  } catch {
    // ignore
  }

  return course;
}

export function formatUnacademyTxt(course: UnaCourse): string {
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
  lines.push(`   COURSE DETAILS — UNACADEMY`);
  lines.push(`━━━━━━━━━━━━━━━━━━━━`);
  lines.push(`⭐ Course: ${course.name}`);
  lines.push(`🆔 ID: ${course.id}`);
  if (course.instructor) lines.push(`👨‍🏫 Instructor: ${course.instructor}`);
  lines.push(``);
  lines.push(`━━━━━━━━━━━━━━━━━━━━`);
  lines.push(`   LINK SUMMARY`);
  lines.push(`━━━━━━━━━━━━━━━━━━━━`);
  lines.push(`🔗 Total Links: ${course.totalLinks}`);
  lines.push(`🎬 Total Videos: ${course.totalVideos}`);
  lines.push(``);
  lines.push(`━━━━━━━━━━━━━━━━━━━━`);
  lines.push(`   LINKS`);
  lines.push(`━━━━━━━━━━━━━━━━━━━━`);
  lines.push(``);
  for (const l of course.lessons) {
    lines.push(`📌 ${l.title}`);
    if (l.url) lines.push(`   🎬 ${l.url}`);
    lines.push(``);
  }
  lines.push(`━━━━━━━━━━━━━━━━━━━━`);
  lines.push(`Generated On: ${now} IST`);
  lines.push(`━━━━━━━━━━━━━━━━━━━━`);
  return lines.join("\n");
}
