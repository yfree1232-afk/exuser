export type BotStep =
  | "idle"
  | "awaiting_category"
  | "awaiting_platform"
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
