import type { HRankerUser } from "../platforms/hranker.js";
import type { AppXUser } from "../platforms/appx.js";
import type { ClassPlusUser } from "../platforms/classplus.js";

export type BotStep =
  | "idle"
  | "awaiting_category"
  | "awaiting_platform"
  | "awaiting_login_email"
  | "awaiting_login_password"
  | "awaiting_appx_phone"
  | "awaiting_appx_otp"
  | "awaiting_classplus_phone"
  | "awaiting_classplus_otp"
  | "awaiting_course_selection"
  | "awaiting_course_id"
  | "extracting";

export interface CourseItem {
  id: string;
  name: string;
}

export interface UserSession {
  step: BotStep;
  category?: string;
  platformId?: string;
  courseList?: CourseItem[];
  messageId?: number;
  loginEmail?: string;
  hrankerUser?: HRankerUser;
  appxUser?: AppXUser;
  appxPhone?: string;
  classplusUser?: ClassPlusUser;
  classplusPhone?: string;
  classplusOrgHexId?: string;
  classplusCourseHexId?: string;
  classplusOrgId?: number;
}

const sessions = new Map<number, UserSession>();

export function getSession(userId: number): UserSession {
  if (!sessions.has(userId)) {
    sessions.set(userId, { step: "idle" });
  }
  return sessions.get(userId)!;
}

export function setSession(userId: number, data: Partial<UserSession>): void {
  const current = getSession(userId);
  sessions.set(userId, { ...current, ...data });
}

export function clearSession(userId: number): void {
  sessions.set(userId, { step: "idle" });
}
