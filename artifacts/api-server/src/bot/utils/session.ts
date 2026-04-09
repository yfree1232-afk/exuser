export type BotStep =
  | "idle"
  | "awaiting_category"
  | "awaiting_platform"
  | "awaiting_course_id"
  | "awaiting_login_id"
  | "awaiting_login_pass"
  | "extracting";

export interface UserSession {
  step: BotStep;
  category?: string;
  platformId?: string;
  loginId?: string;
  loginPass?: string;
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
