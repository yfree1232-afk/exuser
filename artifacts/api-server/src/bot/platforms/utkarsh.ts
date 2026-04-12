import { webcrypto } from "crypto";
import { logger } from "../../lib/logger.js";

const subtle = webcrypto.subtle;

const N_TMPL = "%!F*&^$)_*%3f&B+";
const R_TMPL = "#*$DJvyw2w%!_-$@";
const FIXED_AUTH = "01*#NerglnwwebOI)30@I*Dm'@@";
const BASE_URL = "https://application.utkarshapp.com/data_model";

function padOrTrim(e: string): string {
  if (e.length < 16) return e.padEnd(16, "0");
  if (e.length > 16) return e.substring(0, 16);
  return e;
}

function shuffle(template: string, keyArg: string): string {
  const n = template.split("");
  let out = "";
  for (const c of keyArg) {
    const idx = parseInt(c, 10);
    if (!isNaN(idx) && idx >= 0 && idx < n.length) out += n[idx];
  }
  return out;
}

function getKeyAndIv(userId: string): { key: string; iv: string } {
  const k = userId ? shuffle(N_TMPL, userId) : N_TMPL;
  const i = userId ? shuffle(R_TMPL, userId) : R_TMPL;
  return { key: padOrTrim(k), iv: padOrTrim(i) };
}

async function aesCbcEncrypt(plaintext: string, userId: string): Promise<string> {
  const { key, iv } = getKeyAndIv(userId);
  const keyBuf = await subtle.importKey(
    "raw",
    new TextEncoder().encode(key),
    { name: "AES-CBC" },
    false,
    ["encrypt"],
  );
  const ct = await subtle.encrypt(
    { name: "AES-CBC", iv: new TextEncoder().encode(iv) },
    keyBuf,
    new TextEncoder().encode(plaintext),
  );
  const b64 = Buffer.from(ct).toString("base64");
  return `${b64}:${Buffer.from(userId).toString("base64")}`;
}

async function aesCbcDecrypt(encStr: string, userId: string): Promise<string> {
  const { key, iv } = getKeyAndIv(userId);
  const lastColon = encStr.lastIndexOf(":");
  const encB64 = encStr.substring(0, lastColon).trim();
  const encBuf = Buffer.from(encB64, "base64");
  const keyBuf = await subtle.importKey(
    "raw",
    new TextEncoder().encode(key),
    { name: "AES-CBC" },
    false,
    ["decrypt"],
  );
  const dec = await subtle.decrypt(
    { name: "AES-CBC", iv: new TextEncoder().encode(iv) },
    keyBuf,
    encBuf,
  );
  return new TextDecoder().decode(dec);
}

async function apiCall(
  endpoint: string,
  body: Record<string, unknown>,
  userId: string,
  jwt: string,
  deviceType: string = "4",
): Promise<unknown> {
  const encBody = await aesCbcEncrypt(JSON.stringify(body), userId);
  const res = await fetch(`${BASE_URL}${endpoint}`, {
    method: "POST",
    headers: {
      "Content-Type": "text/plain",
      Authorization: `Bearer ${FIXED_AUTH}`,
      lang: "1",
      version: "1",
      Devicetype: deviceType,
      Userid: userId,
      Jwt: jwt,
    },
    body: encBody,
  });
  const raw = await res.text();
  const trimmed = raw.trim();

  if (!trimmed.includes(":")) {
    return JSON.parse(trimmed);
  }

  const lastColon = trimmed.lastIndexOf(":");
  const keyB64 = trimmed.substring(lastColon + 1);
  const keyArg = Buffer.from(keyB64, "base64").toString("utf8");
  const decrypted = await aesCbcDecrypt(trimmed, keyArg || userId);
  return JSON.parse(decrypted);
}

export interface UtkarshUser {
  id: string;
  name: string;
  mobile: string;
  jwt: string;
}

export interface UtkarshCourse {
  id: string;
  name: string;
  type: string;
}

export interface UtkarshResult {
  lines: string[];
  totalVideos: number;
  totalPdfs: number;
}

async function getGuestJwt(): Promise<{ jwt: string; userId: string }> {
  const res = await fetch("https://utkarsh.com/login", {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Linux; Android 11; Pixel 5) AppleWebKit/537.36",
    },
  });
  const cookies = (res.headers as Headers).get("set-cookie") ?? "";

  const jwtMatch = cookies.match(/jwt=([^;]+)/);
  const jwt = jwtMatch?.[1] ?? "";

  if (jwt) {
    try {
      const payload = JSON.parse(
        Buffer.from(jwt.split(".")[1]!, "base64").toString("utf8"),
      );
      return { jwt, userId: payload.id ?? "0" };
    } catch {
      // ignore
    }
  }
  return { jwt, userId: "0" };
}

export async function utkarshLoginWithPassword(
  mobile: string,
  password: string,
): Promise<UtkarshUser | null> {
  try {
    const { jwt, userId } = await getGuestJwt();
    logger.info({ mobile, userId }, "Utkarsh login attempt");

    const body: Record<string, string> = { mobile, password };
    const resp = (await apiCall("/users/login_auth", body, userId, jwt, "4")) as Record<
      string,
      unknown
    >;

    logger.info({ resp }, "Utkarsh login_auth response");

    if (!resp || resp["status"] === false) {
      const msg = resp?.["message"] as string | undefined;
      if (msg?.includes("version")) {
        logger.warn({ msg }, "Utkarsh version check — trying with version_code in body");
        const body2 = { mobile, password, version_code: "1" };
        const resp2 = (await apiCall("/users/login_auth", body2, userId, jwt, "1")) as Record<
          string,
          unknown
        >;
        logger.info({ resp2 }, "Utkarsh login_auth v2 response");
        if (resp2?.["status"] === false) return null;
        return extractUser(resp2, jwt);
      }
      return null;
    }
    return extractUser(resp, jwt);
  } catch (err) {
    logger.error({ err }, "Utkarsh login error");
    return null;
  }
}

function extractUser(resp: Record<string, unknown>, fallbackJwt: string): UtkarshUser | null {
  const data = resp["data"] as Record<string, unknown> | undefined;
  if (!data) return null;
  const id = String(data["id"] ?? data["user_id"] ?? "0");
  const name = String(data["name"] ?? data["full_name"] ?? "User");
  const mobile = String(data["mobile"] ?? "");
  const jwt = String(data["jwt"] ?? data["token"] ?? fallbackJwt);
  return { id, name, mobile, jwt };
}

export async function utkarshListCourses(user: UtkarshUser): Promise<UtkarshCourse[]> {
  try {
    const resp = (await apiCall(
      "/student_course/my_courses",
      { student_id: user.id },
      user.id,
      user.jwt,
    )) as Record<string, unknown>;

    const data = resp["data"] as Array<Record<string, unknown>> | undefined;
    if (!Array.isArray(data)) return [];

    return data.map((c) => ({
      id: String(c["id"] ?? c["course_id"] ?? ""),
      name: String(c["name"] ?? c["course_name"] ?? "Unknown"),
      type: String(c["type"] ?? "course"),
    }));
  } catch (err) {
    logger.error({ err }, "Utkarsh list courses error");
    return [];
  }
}

export async function utkarshExtractCourse(
  user: UtkarshUser,
  courseId: string,
): Promise<UtkarshResult> {
  const lines: string[] = [];
  let totalVideos = 0;
  let totalPdfs = 0;

  try {
    const resp = (await apiCall(
      "/student_course/get_course_content",
      { course_id: courseId, student_id: user.id },
      user.id,
      user.jwt,
    )) as Record<string, unknown>;

    logger.info({ resp: JSON.stringify(resp).substring(0, 200) }, "Utkarsh course content");

    const data = resp["data"] as Array<Record<string, unknown>> | undefined;
    if (!Array.isArray(data)) {
      logger.warn({ resp }, "Utkarsh course content unexpected format");
      return { lines, totalVideos, totalPdfs };
    }

    for (const section of data) {
      const sectionName = String(section["name"] ?? section["title"] ?? "Section");
      lines.push(`\n📁 ${sectionName}`);
      lines.push("─".repeat(40));

      const contents = (section["contents"] ?? section["content"] ?? []) as Array<
        Record<string, unknown>
      >;
      for (const item of contents) {
        const title = String(item["title"] ?? item["name"] ?? "Untitled");
        const type = String(item["content_type"] ?? item["type"] ?? "");
        const url =
          String(item["url"] ?? item["video_url"] ?? item["pdf_url"] ?? item["file_url"] ?? "");

        if (type.toLowerCase().includes("video") || url.includes("m3u8") || url.includes("mp4")) {
          lines.push(`🎬 ${title}`);
          if (url) lines.push(`   URL: ${url}`);
          totalVideos++;
        } else if (type.toLowerCase().includes("pdf") || url.includes(".pdf")) {
          lines.push(`📄 ${title}`);
          if (url) lines.push(`   PDF: ${url}`);
          totalPdfs++;
        } else {
          lines.push(`📌 ${title} [${type}]`);
          if (url) lines.push(`   Link: ${url}`);
        }
      }
    }
  } catch (err) {
    logger.error({ err }, "Utkarsh extract course error");
  }

  return { lines, totalVideos, totalPdfs };
}

export function formatUtkarshTxt(result: UtkarshResult, courseName: string): string {
  return [
    `Utkarsh Course: ${courseName}`,
    `Total Videos: ${result.totalVideos}`,
    `Total PDFs: ${result.totalPdfs}`,
    `Extracted: ${new Date().toLocaleString("en-IN")}`,
    "─".repeat(50),
    ...result.lines,
  ].join("\n");
}
