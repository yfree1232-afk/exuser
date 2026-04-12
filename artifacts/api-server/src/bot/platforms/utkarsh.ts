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
  deviceType: string = "1",
): Promise<unknown> {
  const encBody = await aesCbcEncrypt(JSON.stringify(body), userId);
  const res = await fetch(`${BASE_URL}${endpoint}`, {
    method: "POST",
    headers: {
      "Content-Type": "text/plain",
      Authorization: `Bearer ${FIXED_AUTH}`,
      lang: "1",
      version: "2",
      Devicetype: deviceType,
      Userid: userId,
      Jwt: jwt,
    },
    body: encBody,
  });
  const raw = await res.text();
  const trimmed = raw.trim();

  // DT=1 returns plain JSON
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return JSON.parse(trimmed);
  }

  // DT=4 returns encrypted response
  if (trimmed.includes(":")) {
    const lastColon = trimmed.lastIndexOf(":");
    const keyB64 = trimmed.substring(lastColon + 1);
    try {
      const keyArg = Buffer.from(keyB64, "base64").toString("utf8");
      const decrypted = await aesCbcDecrypt(trimmed, keyArg || userId);
      return JSON.parse(decrypted);
    } catch {
      // decryption failed — probably still version error
      return { status: false, message: "Decryption failed" };
    }
  }

  return JSON.parse(trimmed);
}

export interface UtkarshUser {
  id: string;
  name: string;
  mobile: string;
  jwt: string;
  fromEnv?: boolean;
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

/**
 * Try CI4 web panel login — returns ci_session cookie if successful.
 * Online.utkarsh.com CI4 panel uses form-encoded POST with csrf_name field.
 */
async function ci4Login(mobile: string, password: string): Promise<string | null> {
  try {
    // Step 1: Get CSRF token
    const initRes = await fetch("https://online.utkarsh.com/", {
      headers: { "User-Agent": "Mozilla/5.0 Chrome/120" },
      redirect: "manual",
    });
    const cookies1: string[] = [];
    (initRes.headers as Headers).forEach((v, k) => {
      if (k === "set-cookie") cookies1.push(v);
    });
    const csrfToken =
      cookies1
        .find((c) => c.startsWith("csrf_name="))
        ?.split("=")?.[1]
        ?.split(";")?.[0] ?? "";
    const ciSession =
      cookies1
        .find((c) => c.startsWith("ci_session="))
        ?.split("=")?.[1]
        ?.split(";")?.[0] ?? "";

    if (!csrfToken) {
      logger.warn("CI4: Could not get CSRF token");
      return null;
    }

    const cookieStr = `csrf_name=${csrfToken}; ci_session=${ciSession}`;

    // Step 2: POST login
    const fd = new URLSearchParams({
      mobile,
      password,
      csrf_name: csrfToken,
    });

    const loginRes = await fetch(
      "https://online.utkarsh.com/web_panel_ini/login/mobile_password",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Cookie: cookieStr,
          "X-Requested-With": "XMLHttpRequest",
          Referer: "https://online.utkarsh.com/",
          "User-Agent": "Mozilla/5.0 Chrome/120",
          Accept: "application/json, text/plain, */*",
        },
        body: fd.toString(),
        redirect: "manual",
      },
    );

    if (loginRes.status !== 200) {
      logger.warn({ status: loginRes.status }, "CI4 login: non-200 response");
      return null;
    }

    // Collect new session cookies from login response
    const cookies2: string[] = [];
    (loginRes.headers as Headers).forEach((v, k) => {
      if (k === "set-cookie") cookies2.push(v);
    });

    const newSession =
      cookies2
        .find((c) => c.startsWith("ci_session="))
        ?.split("=")?.[1]
        ?.split(";")?.[0] ?? ciSession;

    logger.info({ ciSession, newSession }, "CI4 login session check");

    // Return the session (same session ID = login succeeded server-side, data is stored)
    return newSession || ciSession;
  } catch (err) {
    logger.error({ err }, "CI4 login error");
    return null;
  }
}

/**
 * Get Utkarsh user from stored env vars (owner pre-stores their JWT from the app).
 * Required env vars:
 *   UTKARSH_JWT  — JWT from Utkarsh Android/iOS app (version_code=2 required)
 *   UTKARSH_USER_ID — User ID from the JWT payload (optional, auto-extracted)
 *   UTKARSH_USER_NAME — Display name (optional)
 *   UTKARSH_MOBILE — Owner mobile number (optional)
 */
export function getStoredUtkarshUser(): UtkarshUser | null {
  const jwt = process.env["UTKARSH_JWT"];
  if (!jwt) return null;

  let userId = process.env["UTKARSH_USER_ID"] ?? "0";
  let name = process.env["UTKARSH_USER_NAME"] ?? "Owner";
  const mobile = process.env["UTKARSH_MOBILE"] ?? "";

  // Auto-extract userId from JWT payload
  try {
    const payload = JSON.parse(
      Buffer.from(jwt.split(".")[1]!, "base64url").toString("utf8"),
    );
    if (payload.id && payload.id !== "0") userId = String(payload.id);
    logger.info({ userId, version_code: payload.version_code }, "Utkarsh stored JWT loaded");
  } catch {
    // ignore
  }

  return { id: userId, name, mobile, jwt, fromEnv: true };
}

export async function utkarshLoginWithPassword(
  mobile: string,
  password: string,
): Promise<UtkarshUser | null> {
  // First check env vars (owner pre-stored JWT)
  const stored = getStoredUtkarshUser();
  if (stored) {
    logger.info("Using stored Utkarsh owner JWT");
    return stored;
  }

  try {
    const { jwt, userId } = await getGuestJwt();
    logger.info({ mobile, userId }, "Utkarsh data_model login attempt");

    const body: Record<string, string> = { mobile, password };
    const resp = (await apiCall("/users/login_auth", body, userId, jwt, "1")) as Record<
      string,
      unknown
    >;

    logger.info({ resp }, "Utkarsh login_auth response");

    if (!resp || resp["status"] === false) {
      const msg = (resp?.["message"] as string | undefined) ?? "";
      if (msg.toLowerCase().includes("version") || msg.toLowerCase().includes("update")) {
        logger.warn({ msg }, "Utkarsh version check error — API blocked");
        // Return a special "version blocked" signal
        return null;
      }
      return null;
    }
    return extractUser(resp, jwt);
  } catch (err) {
    logger.error({ err }, "Utkarsh login error");
    return null;
  }
}

/**
 * Check if the Utkarsh API is version-blocked (without valid app JWT).
 */
export async function isUtkarshVersionBlocked(): Promise<boolean> {
  try {
    const { jwt, userId } = await getGuestJwt();
    const body = { mobile: "0000000000", password: "test" };
    const resp = (await apiCall("/users/login_auth", body, userId, jwt, "1")) as Record<
      string,
      unknown
    >;
    const msg = (resp?.["message"] as string | undefined) ?? "";
    return msg.toLowerCase().includes("version") || msg.toLowerCase().includes("update");
  } catch {
    return true;
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
  // Try multiple endpoint patterns for batch/course listing
  const endpoints = [
    "/student_course/my_courses",
    "/batches/get_my_batches",
    "/batch/my_batches",
    "/users/my_batches",
    "/batches/get_batch_list",
  ];

  for (const endpoint of endpoints) {
    try {
      const resp = (await apiCall(
        endpoint,
        { student_id: user.id, user_id: user.id },
        user.id,
        user.jwt,
        "1",
      )) as Record<string, unknown>;

      const msg = (resp?.["message"] as string | undefined) ?? "";
      if (msg.toLowerCase().includes("version") || msg.toLowerCase().includes("update")) {
        logger.warn({ endpoint }, "Utkarsh version check on course list");
        continue;
      }

      const data = resp["data"] as Array<Record<string, unknown>> | undefined;
      if (Array.isArray(data) && data.length > 0) {
        logger.info({ endpoint, count: data.length }, "Utkarsh courses found");
        return data.map((c) => ({
          id: String(c["id"] ?? c["course_id"] ?? c["batch_id"] ?? ""),
          name: String(c["name"] ?? c["course_name"] ?? c["batch_name"] ?? "Unknown"),
          type: String(c["type"] ?? c["course_type"] ?? "course"),
        }));
      }
    } catch (err) {
      logger.error({ err, endpoint }, "Utkarsh list courses endpoint error");
    }
  }

  return [];
}

export async function utkarshExtractCourse(
  user: UtkarshUser,
  courseId: string,
): Promise<UtkarshResult> {
  const lines: string[] = [];
  let totalVideos = 0;
  let totalPdfs = 0;

  // Try multiple endpoint patterns for content
  const contentEndpoints = [
    "/student_course/get_course_content",
    "/batches/get_batch_content",
    "/batch/get_content",
    "/content/get_batch_content",
    "/batches/get_content",
  ];

  for (const endpoint of contentEndpoints) {
    try {
      const resp = (await apiCall(
        endpoint,
        { course_id: courseId, batch_id: courseId, student_id: user.id, user_id: user.id },
        user.id,
        user.jwt,
        "1",
      )) as Record<string, unknown>;

      logger.info({ resp: JSON.stringify(resp).substring(0, 300), endpoint }, "Utkarsh content response");

      const msg = (resp?.["message"] as string | undefined) ?? "";
      if (msg.toLowerCase().includes("version") || msg.toLowerCase().includes("update")) {
        continue;
      }

      const data = resp["data"] as Array<Record<string, unknown>> | undefined;
      if (!Array.isArray(data) || data.length === 0) {
        continue;
      }

      for (const section of data) {
        const sectionName = String(section["name"] ?? section["title"] ?? "Section");
        lines.push(`\n📁 ${sectionName}`);
        lines.push("─".repeat(40));

        const contents = (section["contents"] ?? section["content"] ?? section["items"] ?? []) as Array<
          Record<string, unknown>
        >;
        for (const item of contents) {
          const title = String(item["title"] ?? item["name"] ?? "Untitled");
          const type = String(item["content_type"] ?? item["type"] ?? "");
          const url = String(
            item["url"] ??
              item["video_url"] ??
              item["pdf_url"] ??
              item["file_url"] ??
              item["link"] ??
              "",
          );

          if (type.toLowerCase().includes("video") || url.includes("m3u8") || url.includes("mp4") || url.includes("youtube") || url.includes("youtu.be")) {
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

      if (lines.length > 0) break;
    } catch (err) {
      logger.error({ err, endpoint }, "Utkarsh extract course endpoint error");
    }
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
