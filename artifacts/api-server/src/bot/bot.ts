import TelegramBot from "node-telegram-bot-api";
import fs from "fs";
import os from "os";
import path from "path";
import { getSession, setSession, clearSession, type CourseItem } from "./utils/session.js";
import {
  PLATFORMS,
  NO_LOGIN_PLATFORMS,
  VIDCRYPT_PLATFORMS,
  LOGIN_PLATFORMS,
  getPlatform,
} from "./platforms/index.js";
import { extractPinnacleCourse, formatPinnacleTxt } from "./platforms/pinnacle.js";
import { listAppXCourses, extractAppXCourse, formatAppXTxt, appxSendOtp, appxVerifyOtp } from "./platforms/appx.js";
import { extractVidCryptCourse, formatVidCryptTxt } from "./platforms/vidcrypt.js";
import { extractUnacademyCourse, formatUnacademyTxt } from "./platforms/unacademy.js";
import { extractKGSCourse, formatKGSTxt } from "./platforms/kgs.js";
import {
  hrankerLogin,
  hrankerAutoRegister,
  listHRankerCourses,
  extractHRankerCourse,
  formatHRankerTxt,
} from "./platforms/hranker.js";
import {
  parseClassPlusUrl,
  getOrgSettings,
  sendOtp as classplusSendOtp,
  verifyOtp as classplusVerifyOtp,
  extractCourseContent as classplusExtract,
} from "./platforms/classplus.js";
import { logger } from "../lib/logger.js";

const ITEMS_PER_PAGE = 8;

// Silently ignore "message is not modified" errors from Telegram
async function safeEdit(
  bot: TelegramBot,
  chatId: number,
  messageId: number,
  text: string,
  options?: Omit<TelegramBot.EditMessageTextOptions, "chat_id" | "message_id">,
): Promise<void> {
  try {
    await bot.editMessageText(text, { chat_id: chatId, message_id: messageId, ...options });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes("message is not modified") && !msg.includes("not modified")) {
      throw err;
    }
    // silently ignore duplicate content edits
  }
}

function chunkArray<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

export function startBot(): TelegramBot {
  const token = process.env["TELEGRAM_BOT_TOKEN"];
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN is not set");

  const bot = new TelegramBot(token, { polling: true });
  logger.info("Telegram bot started");

  // ─── /start ───────────────────────────────────────────────────────
  bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    clearSession(msg.from?.id ?? chatId);
    await sendMainMenu(bot, chatId);
  });

  // ─── Callback queries ─────────────────────────────────────────────
  bot.on("callback_query", async (query) => {
    if (!query.message) return;
    const chatId = query.message.chat.id;
    const userId = query.from.id;
    const data = query.data ?? "";

    try {
      await bot.answerCallbackQuery(query.id);
    } catch {
      // ignore if already answered
    }

    // Ignore noop buttons (page indicators, etc.)
    if (data === "noop" || !data) return;

    try {

    // Main menu
    if (data === "menu_main") {
      clearSession(userId);
      await bot.editMessageText(buildMainMenuText(), {
        chat_id: chatId,
        message_id: query.message.message_id,
        parse_mode: "HTML",
        reply_markup: buildMainMenuKeyboard(),
      });
      return;
    }

    // Category selection
    if (data === "cat_nologin" || data === "cat_vidcrypt" || data === "cat_login") {
      const category = data === "cat_nologin" ? "nologin" : data === "cat_login" ? "login" : "vidcrypt";
      setSession(userId, { step: "awaiting_platform", category });
      await showPlatformList(bot, chatId, query.message.message_id, category, 0);
      return;
    }

    // Pagination
    if (data.startsWith("page_")) {
      const parts = data.split("_");
      const category = parts.slice(1, -1).join("_");
      const pageStr = parts[parts.length - 1];
      await showPlatformList(bot, chatId, query.message.message_id, category!, parseInt(pageStr ?? "0", 10));
      return;
    }

    // Platform selected
    if (data.startsWith("plat_")) {
      const platformId = data.replace("plat_", "");
      const platform = getPlatform(platformId);
      if (!platform) return;

      if (platform.status === "down") {
        await bot.editMessageText(
          `⚠️ <b>${platform.name}</b> filhaal <b>DOWN</b> hai.\n\nKoi dusra platform try karo.`,
          {
            chat_id: chatId,
            message_id: query.message.message_id,
            parse_mode: "HTML",
            reply_markup: { inline_keyboard: [[{ text: "🔙 Back", callback_data: `cat_${getSession(userId).category}` }]] },
          }
        );
        return;
      }

      if (platform.status === "soon") {
        await bot.editMessageText(
          `🔜 <b>${platform.name}</b> <b>Coming Soon!</b>`,
          {
            chat_id: chatId,
            message_id: query.message.message_id,
            parse_mode: "HTML",
            reply_markup: { inline_keyboard: [[{ text: "🔙 Back", callback_data: `cat_${getSession(userId).category}` }]] },
          }
        );
        return;
      }

      // HRanker platform — auto-register OR manual login
      if (platform.type === "hranker") {
        const session = getSession(userId);

        // Already logged in for this platform
        if (session.hrankerUser && session.hrankerUser.subdomain === (platform.hrankerSubdomain ?? platform.id)) {
          await handleHRankerPlatformSelected(bot, chatId, query.message.message_id, userId, platform);
          return;
        }

        // Auto-register (without login) — dummy login like Nova Extractor
        if (!platform.loginRequired) {
          await bot.editMessageText(
            `${platform.emoji} <b>${platform.name}</b>\n\n⏳ <b>Auto-connect ho raha hai...</b>\n<i>Kuch seconds mein ready ho jayega...</i>`,
            { chat_id: chatId, message_id: query.message.message_id, parse_mode: "HTML" }
          );

          try {
            const subdomain = platform.hrankerSubdomain ?? platform.id;
            const apiBase = platform.hrankerApiBase;
            const hrankerUser = await hrankerAutoRegister(subdomain, apiBase);
            setSession(userId, { step: "awaiting_course_selection", platformId, hrankerUser });

            let courseList: CourseItem[] = [];
            try {
              const courses = await listHRankerCourses(hrankerUser);
              courseList = courses.map(c => ({ id: c.id, name: c.name }));
            } catch (e) {
              logger.error({ e }, "HRanker course list after auto-register");
            }

            // Fallback to hardcoded courses if API returns empty
            if (courseList.length === 0 && platform.hardcodedCourses && platform.hardcodedCourses.length > 0) {
              courseList = platform.hardcodedCourses.map(c => ({ id: c.id, name: c.name }));
            }

            setSession(userId, {
              step: courseList.length > 0 ? "awaiting_course_selection" : "awaiting_course_id",
              platformId,
              hrankerUser,
              courseList,
            });

            if (courseList.length > 0) {
              await showCourseList(bot, chatId, query.message.message_id, platform.emoji, platform.name, courseList, 0);
            } else {
              await bot.editMessageText(
                `${platform.emoji} <b>${platform.name}</b>\n\n` +
                `✅ Connected!\n\n📨 <b>Course ID paste karo:</b>\n\n` +
                `<i>Example: 1231</i>`,
                {
                  chat_id: chatId,
                  message_id: query.message.message_id,
                  parse_mode: "HTML",
                  reply_markup: {
                    inline_keyboard: [
                      [{ text: "🔐 Login with my account", callback_data: `login_${platformId}` }],
                      [{ text: "🏠 Main Menu", callback_data: "menu_main" }],
                    ],
                  },
                }
              );
            }
          } catch (err) {
            logger.error({ err }, "HRanker auto-register failed");
            // Fallback to manual login
            setSession(userId, { step: "awaiting_login_email", platformId });
            await bot.editMessageText(
              `${platform.emoji} <b>${platform.name}</b>\n\n` +
              `🔐 Auto-connect failed. Manually login karo:\n\n📧 <b>Email bhejo:</b>`,
              {
                chat_id: chatId,
                message_id: query.message.message_id,
                parse_mode: "HTML",
                reply_markup: { inline_keyboard: [[{ text: "🏠 Main Menu", callback_data: "menu_main" }]] },
              }
            );
          }
          return;
        }

        // Manual Login Required
        setSession(userId, { step: "awaiting_login_email", platformId });

        await bot.editMessageText(
          `${platform.emoji} <b>${platform.name}</b>\n\n` +
          `🔐 <b>Login Required</b>\n\n` +
          `━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
          `📧 Apna <b>Email</b> bhejo:\n\n` +
          `<i>Login sirf is session ke liye use hoga.</i>`,
          {
            chat_id: chatId,
            message_id: query.message.message_id,
            parse_mode: "HTML",
            reply_markup: {
              inline_keyboard: [
                [{ text: "🏠 Main Menu", callback_data: "menu_main" }],
              ],
            },
          }
        );
        return;
      }

      // AppX platform with appKey → needs phone OTP login for video links
      if (platform.type === "appx" && platform.appKey) {
        const session = getSession(userId);

        // Already logged in for this AppX platform
        if (session.appxUser && session.appxUser.appKey === platform.appKey) {
          const courseList = await listAppXCourses(platform).catch(() => [] as CourseItem[]);
          setSession(userId, {
            step: courseList.length > 0 ? "awaiting_course_selection" : "awaiting_course_id",
            platformId,
            courseList,
          });
          if (courseList.length > 0) {
            await showCourseList(bot, chatId, query.message.message_id, platform.emoji, platform.name, courseList, 0);
          } else {
            await bot.editMessageText(
              `${platform.emoji} <b>${platform.name}</b>\n✅ Logged in as <b>${session.appxUser.name}</b>\n\n📨 <b>Course ID paste karo:</b>`,
              { chat_id: chatId, message_id: query.message.message_id, parse_mode: "HTML",
                reply_markup: { inline_keyboard: [[{ text: "🏠 Main Menu", callback_data: "menu_main" }]] } }
            );
          }
          return;
        }

        // Prompt phone OTP login
        setSession(userId, { step: "awaiting_appx_phone", platformId, messageId: query.message.message_id });
        await bot.editMessageText(
          `${platform.emoji} <b>${platform.name}</b>\n\n` +
          `📱 <b>Phone Number Daalo</b>\n\n` +
          `━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
          `Video links ke liye <b>Selection Way</b> pe registered number chahiye.\n\n` +
          `<b>Free registration hai — purchase ki zaroorat nahi!</b>\n\n` +
          `📲 Apna <b>10-digit mobile number</b> type karo:\n` +
          `<i>(jaise: 9876543210)</i>`,
          {
            chat_id: chatId,
            message_id: query.message.message_id,
            parse_mode: "HTML",
            reply_markup: { inline_keyboard: [[{ text: "🏠 Main Menu", callback_data: "menu_main" }]] },
          }
        );
        return;
      }

      // Show loading for non-login platforms
      await bot.editMessageText(
        `${platform.emoji} <b>${platform.name}</b>\n\n⏳ <b>Courses fetch ho rahe hain...</b>\n\nPlease wait...`,
        { chat_id: chatId, message_id: query.message.message_id, parse_mode: "HTML" }
      );

      // Fetch course list
      let courseList: CourseItem[] = [];
      try {
        if (platform.type === "appx") {
          courseList = await listAppXCourses(platform);
        }
      } catch (err) {
        logger.error({ err }, "Course list fetch failed");
      }

      setSession(userId, {
        step: courseList.length > 0 ? "awaiting_course_selection" : "awaiting_course_id",
        platformId,
        courseList,
      });

      if (courseList.length > 0) {
        await showCourseList(bot, chatId, query.message.message_id, platform.emoji, platform.name, courseList, 0);
      } else {
        await bot.editMessageText(
          `${platform.emoji} <b>${platform.name}</b>\n\n` +
            `📨 <b>Course ID paste karo:</b>\n\n` +
            `<i>Example: 69ae9daca2b1ae04337afa9a</i>`,
          {
            chat_id: chatId,
            message_id: query.message.message_id,
            parse_mode: "HTML",
            reply_markup: {
              inline_keyboard: [
                [{ text: "🏠 Main Menu", callback_data: "menu_main" }],
              ],
            },
          }
        );
      }
      return;
    }

    // Course list pagination
    if (data.startsWith("cpage_")) {
      const pageStr = data.replace("cpage_", "");
      const session = getSession(userId);
      if (!session.platformId || !session.courseList) return;
      const platform = getPlatform(session.platformId);
      if (!platform) return;
      await showCourseList(
        bot, chatId, query.message.message_id,
        platform.emoji, platform.name,
        session.courseList, parseInt(pageStr, 10)
      );
      return;
    }

    // Switch to manual login (override auto-register)
    if (data.startsWith("login_")) {
      const platformId = data.replace("login_", "");
      const platform = getPlatform(platformId);
      if (!platform) return;
      setSession(userId, { step: "awaiting_login_email", platformId, hrankerUser: undefined });
      await bot.editMessageText(
        `${platform.emoji} <b>${platform.name}</b>\n\n` +
        `🔐 <b>Login with your account</b>\n\n📧 <b>Email bhejo:</b>\n\n` +
        `<i>Aapka login sirf is session ke liye use hoga.</i>`,
        {
          chat_id: chatId,
          message_id: query.message.message_id,
          parse_mode: "HTML",
          reply_markup: { inline_keyboard: [[{ text: "🏠 Main Menu", callback_data: "menu_main" }]] },
        }
      );
      return;
    }

    // Logout HRanker
    if (data.startsWith("logout_")) {
      const platformId = data.replace("logout_", "");
      setSession(userId, { hrankerUser: undefined });
      const platform = getPlatform(platformId);
      await bot.editMessageText(
        `✅ <b>Logout ho gaya!</b>\n\nDobara login ke liye platform select karo.`,
        {
          chat_id: chatId,
          message_id: query.message.message_id,
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [
              platform ? [{ text: `${platform.emoji} ${platform.name}`, callback_data: `plat_${platformId}` }] : [],
              [{ text: "🏠 Main Menu", callback_data: "menu_main" }],
            ],
          },
        }
      );
      return;
    }

    // Close
    if (data === "close") {
      await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
      return;
    }

    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("message is not modified") || msg.includes("not modified")) return;
      logger.error({ err, data }, "Callback query error");
    }
  });

  // ─── Text messages ─────────────────────────────────────────────────
  bot.on("message", async (msg) => {
    if (!msg.text || msg.text.startsWith("/")) return;
    const chatId = msg.chat.id;
    const userId = msg.from?.id ?? chatId;
    const session = getSession(userId);
    const input = msg.text.trim();

    // ── ClassPlus URL Detection (any step) ───────────────────────────
    if (
      (input.includes("d2a5xnk4s7n8a6.cloudfront.net") || input.includes("classplusapp.com/courses")) &&
      session.step !== "awaiting_classplus_phone" &&
      session.step !== "awaiting_classplus_otp" &&
      session.step !== "extracting"
    ) {
      const parsed = parseClassPlusUrl(input);
      if (parsed) {
        logger.info({ parsed }, "ClassPlus URL detected");
        setSession(userId, {
          step: "awaiting_classplus_phone",
          classplusOrgHexId: parsed.orgHexId,
          classplusCourseHexId: parsed.courseHexId,
        });
        await bot.sendMessage(
          chatId,
          `📚 <b>ClassPlus Course Detected!</b>\n\n` +
          `🔑 <b>Org ID:</b> <code>${parsed.orgHexId || "unknown"}</code>\n` +
          `📖 <b>Course ID:</b> <code>${parsed.courseHexId}</code>\n\n` +
          `📱 Login ke liye apna <b>mobile number</b> bhejo:\n` +
          `<i>(10-digit, without +91)</i>`,
          { parse_mode: "HTML" }
        );
        return;
      }
    }

    // ── ClassPlus Phone OTP Step 1 ────────────────────────────────────
    if (session.step === "awaiting_classplus_phone") {
      const cleanMobile = input.replace(/\D/g, "").replace(/^91/, "").slice(-10);
      if (cleanMobile.length !== 10) {
        await bot.sendMessage(chatId,
          `❌ <b>Invalid number!</b> 10-digit mobile number bhejo (without 91).`,
          { parse_mode: "HTML" }
        );
        return;
      }

      const statusMsg = await bot.sendMessage(chatId,
        `📱 <b>${cleanMobile}</b> pe OTP bheja ja raha hai...\nPlease wait...`,
        { parse_mode: "HTML" }
      );

      // Try to get org settings for the org
      const orgId = session.classplusOrgId || 0;
      if (!orgId) {
        // Need orgCode to get orgId - prompt user for orgCode
        setSession(userId, {
          step: "awaiting_classplus_phone",
          classplusPhone: cleanMobile,
          messageId: statusMsg.message_id,
        });
        await bot.editMessageText(
          `⚠️ <b>Org Code Needed</b>\n\n` +
          `ClassPlus OTP ke liye organization code chahiye.\n\n` +
          `📱 Number saved: <code>${cleanMobile}</code>\n\n` +
          `🔤 <b>Apna ClassPlus org code bhejo</b>\n` +
          `<i>(Example: ojhacademy, pathfinder, etc.)</i>`,
          { chat_id: chatId, message_id: statusMsg.message_id, parse_mode: "HTML" }
        );
        setSession(userId, { step: "awaiting_classplus_orgcode" as any, classplusPhone: cleanMobile });
        return;
      }

      const result = await classplusSendOtp(cleanMobile, orgId);
      if (result.success) {
        setSession(userId, { step: "awaiting_classplus_otp", classplusPhone: cleanMobile });
        await bot.editMessageText(
          `✅ <b>OTP Sent!</b>\n\n📱 Number: <code>${cleanMobile}</code>\n\n🔐 Ab apna <b>4-6 digit OTP</b> bhejo:`,
          { chat_id: chatId, message_id: statusMsg.message_id, parse_mode: "HTML" }
        );
      } else {
        await bot.editMessageText(
          `❌ <b>OTP failed:</b> ${result.message}\n\nPhir se phone number bhejo:`,
          {
            chat_id: chatId, message_id: statusMsg.message_id, parse_mode: "HTML",
            reply_markup: { inline_keyboard: [[{ text: "🏠 Main Menu", callback_data: "menu_main" }]] }
          }
        );
      }
      return;
    }

    // ── ClassPlus Org Code (when needed) ─────────────────────────────
    if ((session.step as string) === "awaiting_classplus_orgcode") {
      const orgCode = input.trim().toLowerCase();
      const statusMsg = await bot.sendMessage(chatId,
        `🔍 Org settings fetch ho rahe hain: <code>${orgCode}</code>...`,
        { parse_mode: "HTML" }
      );

      const orgSettings = await getOrgSettings(orgCode);
      if (!orgSettings || !orgSettings.orgId) {
        await bot.editMessageText(
          `❌ <b>Org not found!</b> Org code <code>${orgCode}</code> galat hai.\n\nDobara correct org code bhejo:`,
          { chat_id: chatId, message_id: statusMsg.message_id, parse_mode: "HTML" }
        );
        return;
      }

      setSession(userId, { classplusOrgId: orgSettings.orgId });
      const mobile = session.classplusPhone || "";

      const result = await classplusSendOtp(mobile, orgSettings.orgId);
      if (result.success) {
        setSession(userId, { step: "awaiting_classplus_otp" });
        await bot.editMessageText(
          `✅ <b>OTP Sent!</b>\n\n📱 <code>${mobile}</code>\n🏫 Org: <b>${orgSettings.name}</b>\n\n🔐 Ab apna OTP bhejo:`,
          { chat_id: chatId, message_id: statusMsg.message_id, parse_mode: "HTML" }
        );
      } else {
        await bot.editMessageText(
          `❌ OTP failed: ${result.message}`,
          {
            chat_id: chatId, message_id: statusMsg.message_id, parse_mode: "HTML",
            reply_markup: { inline_keyboard: [[{ text: "🏠 Main Menu", callback_data: "menu_main" }]] }
          }
        );
      }
      return;
    }

    // ── ClassPlus OTP Verify Step 2 ───────────────────────────────────
    if (session.step === "awaiting_classplus_otp") {
      if (!session.classplusPhone || !session.classplusOrgId) {
        clearSession(userId);
        await bot.sendMessage(chatId, "❌ Session expired. /start karo.");
        return;
      }

      const otp = input.replace(/\D/g, "").slice(0, 6);
      if (otp.length < 4) {
        await bot.sendMessage(chatId, `❌ Invalid OTP! 4-6 digit OTP bhejo.`);
        return;
      }

      const statusMsg = await bot.sendMessage(chatId, `🔐 OTP verify ho raha hai...`);

      const cpUser = await classplusVerifyOtp(session.classplusPhone, otp, session.classplusOrgId);
      if (!cpUser || !cpUser.token) {
        await bot.editMessageText(
          `❌ <b>OTP Wrong!</b> Dobara correct OTP bhejo:`,
          {
            chat_id: chatId, message_id: statusMsg.message_id, parse_mode: "HTML",
            reply_markup: { inline_keyboard: [[{ text: "🏠 Main Menu", callback_data: "menu_main" }]] }
          }
        );
        return;
      }

      setSession(userId, { classplusUser: cpUser, step: "extracting" });

      await bot.editMessageText(
        `✅ <b>Login Successful!</b>\n\n📚 <b>Course extract ho raha hai...</b>\nPlease wait...`,
        { chat_id: chatId, message_id: statusMsg.message_id, parse_mode: "HTML" }
      );

      const orgHexId = session.classplusOrgHexId || "";
      const courseHexId = session.classplusCourseHexId || "";
      const result = await classplusExtract(cpUser.token, orgHexId, courseHexId);

      clearSession(userId);

      if (!result.lines.length) {
        await bot.editMessageText(
          `⚠️ <b>No content found!</b>\n\nCourse ID: <code>${courseHexId}</code>\n\n` +
          `Maybe course empty hai ya aur course ID chahiye.`,
          {
            chat_id: chatId, message_id: statusMsg.message_id, parse_mode: "HTML",
            reply_markup: { inline_keyboard: [[{ text: "🏠 Main Menu", callback_data: "menu_main" }]] }
          }
        );
        return;
      }

      const txtContent = [
        `ClassPlus Course: ${courseHexId}`,
        `Total Videos: ${result.totalVideos}`,
        `Total PDFs: ${result.totalPdfs}`,
        `Extracted: ${new Date().toLocaleString("en-IN")}`,
        "─".repeat(50),
        ...result.lines,
      ].join("\n");

      const tmpPath = path.join(os.tmpdir(), `classplus_${courseHexId}_${Date.now()}.txt`);
      fs.writeFileSync(tmpPath, txtContent, "utf-8");

      await bot.sendDocument(chatId, tmpPath, {
        caption:
          `✅ <b>ClassPlus Extraction Done!</b>\n\n` +
          `📖 Course: <code>${courseHexId}</code>\n` +
          `🎬 Videos: <b>${result.totalVideos}</b>\n` +
          `📄 PDFs: <b>${result.totalPdfs}</b>`,
        parse_mode: "HTML",
      });
      fs.unlinkSync(tmpPath);
      await sendMainMenu(bot, chatId);
      return;
    }

    // ── AppX Phone OTP Step 1: Receive Phone Number ───
    if (session.step === "awaiting_appx_phone") {
      const platform = session.platformId ? getPlatform(session.platformId) : null;
      if (!platform || !platform.appKey) {
        clearSession(userId);
        await bot.sendMessage(chatId, "❌ Session expired. /start se dobara try karo.");
        return;
      }

      const cleanMobile = input.replace(/\D/g, "").replace(/^91/, "").slice(-10);
      if (cleanMobile.length !== 10) {
        await bot.sendMessage(
          chatId,
          `❌ <b>Invalid number!</b>\n\nSirf 10-digit mobile number bhejo.\n<i>Example: 9876543210</i>`,
          { parse_mode: "HTML" }
        );
        return;
      }

      const statusMsg = await bot.sendMessage(
        chatId,
        `📱 <b>${cleanMobile}</b> pe OTP bheja ja raha hai...\n\nPlease wait...`,
        { parse_mode: "HTML" }
      );

      const sent = await appxSendOtp(cleanMobile, platform.appKey);
      if (sent) {
        setSession(userId, { step: "awaiting_appx_otp", appxPhone: cleanMobile, messageId: statusMsg.message_id });
        await bot.editMessageText(
          `✅ <b>OTP Sent!</b>\n\n` +
          `📱 Number: <code>${cleanMobile}</code>\n\n` +
          `🔐 Ab apna <b>6-digit OTP</b> bhejo jo aapke phone pe aaya hai:`,
          { chat_id: chatId, message_id: statusMsg.message_id, parse_mode: "HTML" }
        );
      } else {
        await bot.editMessageText(
          `❌ <b>OTP send nahi hua!</b>\n\n` +
          `Possible reasons:\n` +
          `• Number Selection Way pe registered nahi hai\n` +
          `• Pehle <b>selectionway.in</b> pe free register karo\n` +
          `• Phir dobara try karo\n\n` +
          `Phone number dobara bhejo ya /start karo:`,
          { chat_id: chatId, message_id: statusMsg.message_id, parse_mode: "HTML",
            reply_markup: { inline_keyboard: [[{ text: "🏠 Main Menu", callback_data: "menu_main" }]] } }
        );
      }
      return;
    }

    // ── AppX Phone OTP Step 2: Verify OTP ───
    if (session.step === "awaiting_appx_otp") {
      const platform = session.platformId ? getPlatform(session.platformId) : null;
      if (!platform || !platform.appKey || !session.appxPhone) {
        clearSession(userId);
        await bot.sendMessage(chatId, "❌ Session expired. /start se dobara try karo.");
        return;
      }

      const otp = input.replace(/\D/g, "").slice(0, 6);
      if (otp.length < 4) {
        await bot.sendMessage(chatId, `❌ Invalid OTP! 4-6 digit OTP bhejo.`, { parse_mode: "HTML" });
        return;
      }

      const statusMsg = await bot.sendMessage(
        chatId,
        `🔐 OTP verify ho raha hai...\n\nPlease wait...`,
        { parse_mode: "HTML" }
      );

      const appxUser = await appxVerifyOtp(session.appxPhone, otp, platform.appKey);
      if (!appxUser) {
        await bot.editMessageText(
          `❌ <b>OTP Incorrect!</b>\n\n` +
          `OTP galat hai ya expire ho gaya.\n\n` +
          `Phir se OTP bhejo, ya /start karo:`,
          { chat_id: chatId, message_id: statusMsg.message_id, parse_mode: "HTML",
            reply_markup: { inline_keyboard: [[{ text: "🏠 Main Menu", callback_data: "menu_main" }]] } }
        );
        return;
      }

      setSession(userId, { appxUser, step: "awaiting_course_selection" });
      logger.info({ userId, name: appxUser.name, appKey: appxUser.appKey }, "AppX OTP login success");

      await bot.editMessageText(
        `✅ <b>Login Successful!</b>\n\n` +
        `${platform.emoji} <b>${platform.name}</b>\n` +
        `👤 <b>${appxUser.name}</b>\n` +
        `📱 <code>${appxUser.mobile}</code>\n\n` +
        `⏳ Courses fetch ho rahe hain...`,
        { chat_id: chatId, message_id: statusMsg.message_id, parse_mode: "HTML" }
      );

      const courseList = await listAppXCourses(platform).catch(() => [] as CourseItem[]);
      setSession(userId, {
        step: courseList.length > 0 ? "awaiting_course_selection" : "awaiting_course_id",
        courseList,
      });

      if (courseList.length > 0) {
        await showCourseList(bot, chatId, statusMsg.message_id, platform.emoji, platform.name, courseList, 0);
      } else {
        await bot.editMessageText(
          `${platform.emoji} <b>${platform.name}</b>\n✅ Login: <b>${appxUser.name}</b>\n\n📨 <b>Course ID paste karo:</b>`,
          {
            chat_id: chatId, message_id: statusMsg.message_id, parse_mode: "HTML",
            reply_markup: { inline_keyboard: [[{ text: "🏠 Main Menu", callback_data: "menu_main" }]] },
          }
        );
      }
      return;
    }

    // ── Login Email ───
    if (session.step === "awaiting_login_email") {
      setSession(userId, { step: "awaiting_login_password", loginEmail: input });
      const platform = session.platformId ? getPlatform(session.platformId) : null;
      await bot.sendMessage(
        chatId,
        `${platform?.emoji ?? "🔐"} <b>${platform?.name ?? "Platform"}</b>\n\n` +
        `✅ Email received: <code>${input}</code>\n\n` +
        `🔑 Ab apna <b>Password</b> bhejo:`,
        { parse_mode: "HTML" }
      );
      return;
    }

    // ── Login Password ───
    if (session.step === "awaiting_login_password") {
      if (!session.platformId || !session.loginEmail) {
        clearSession(userId);
        await bot.sendMessage(chatId, "❌ Session expired. /start se dobara try karo.");
        return;
      }

      const platform = getPlatform(session.platformId);
      if (!platform || platform.type !== "hranker") {
        clearSession(userId);
        return;
      }

      const statusMsg = await bot.sendMessage(
        chatId,
        `${platform.emoji} <b>${platform.name}</b>\n\n⏳ <b>Login ho raha hai...</b>\n\nPlease wait...`,
        { parse_mode: "HTML" }
      );

      try {
        const hrankerUser = await hrankerLogin(
          session.loginEmail,
          input,
          platform.hrankerSubdomain ?? platform.id,
          platform.hrankerApiBase,
        );

        setSession(userId, {
          step: "awaiting_course_selection",
          hrankerUser,
        });

        await bot.editMessageText(
          `✅ <b>Login Successful!</b>\n\n${platform.emoji} <b>${platform.name}</b>\n👤 <b>${hrankerUser.name}</b>\n\n⏳ Courses fetch ho rahe hain...`,
          { chat_id: chatId, message_id: statusMsg.message_id, parse_mode: "HTML" }
        );

        // Fetch course list
        let courseList: CourseItem[] = [];
        try {
          const courses = await listHRankerCourses(hrankerUser);
          courseList = courses.map(c => ({ id: c.id, name: c.name }));
        } catch (err) {
          logger.error({ err }, "HRanker course list failed");
        }

        setSession(userId, {
          step: courseList.length > 0 ? "awaiting_course_selection" : "awaiting_course_id",
          courseList,
        });

        if (courseList.length > 0) {
          await showCourseList(bot, chatId, statusMsg.message_id, platform.emoji, platform.name, courseList, 0);
        } else {
          await bot.editMessageText(
            `${platform.emoji} <b>${platform.name}</b>\n✅ Login: <b>${hrankerUser.name}</b>\n\n` +
            `📨 <b>Course ID paste karo:</b>`,
            {
              chat_id: chatId,
              message_id: statusMsg.message_id,
              parse_mode: "HTML",
              reply_markup: {
                inline_keyboard: [
                  [{ text: `🔓 Logout`, callback_data: `logout_${platform.id}` }],
                  [{ text: "🏠 Main Menu", callback_data: "menu_main" }],
                ],
              },
            }
          );
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : "Login failed";
        logger.error({ err }, "HRanker login failed");

        setSession(userId, { step: "awaiting_login_email", loginEmail: undefined });

        await bot.editMessageText(
          `❌ <b>Login Failed!</b>\n\n${platform.emoji} <b>${platform.name}</b>\n\n` +
          `⚠️ <b>${errMsg}</b>\n\n` +
          `📧 Dobara apna <b>Email</b> bhejo:`,
          {
            chat_id: chatId,
            message_id: statusMsg.message_id,
            parse_mode: "HTML",
            reply_markup: {
              inline_keyboard: [
                [{ text: "🏠 Main Menu", callback_data: "menu_main" }],
              ],
            },
          }
        );
      }
      return;
    }

    // ── Course ID / Selection ───
    if (
      session.step !== "awaiting_course_id" &&
      session.step !== "awaiting_course_selection"
    ) return;

    if (!session.platformId) return;

    let courseId: string | null = null;

    if (session.step === "awaiting_course_selection" && session.courseList) {
      const num = parseInt(input, 10);
      if (!isNaN(num) && num >= 1 && num <= session.courseList.length) {
        courseId = session.courseList[num - 1]!.id;
      } else if (/^[a-f0-9]{24}$/i.test(input) || input.length > 6) {
        courseId = input;
      } else {
        await bot.sendMessage(chatId,
          `⚠️ <b>Invalid input.</b>\n\nList se number bhejo (1-${session.courseList.length}) ya Course ID directly paste karo.`,
          { parse_mode: "HTML" }
        );
        return;
      }
    } else {
      courseId = input;
    }

    if (!courseId) return;

    const platform = getPlatform(session.platformId);
    if (!platform) return;

    setSession(userId, { step: "extracting" });

    const courseName = session.courseList?.find(c => c.id === courseId)?.name;
    const statusMsg = await bot.sendMessage(
      chatId,
      `⏳ <b>Extracting...</b>\n\n${platform.emoji} <b>${platform.name}</b>\n` +
        `${courseName ? `📚 <b>${courseName}</b>\n` : ""}` +
        `🆔 <code>${courseId}</code>\n\nLinks fetch ho rahe hain...`,
      { parse_mode: "HTML" }
    );

    try {
      let txtContent = "";
      let displayName = "";

      if (platform.type === "hranker" && session.hrankerUser) {
        const course = await extractHRankerCourse(courseId, session.hrankerUser, platform.name);
        txtContent = formatHRankerTxt(course);
        displayName = course.name;
      } else if (platform.type === "pinnacle") {
        const course = await extractPinnacleCourse(courseId);
        txtContent = formatPinnacleTxt(course);
        displayName = course.name;
      } else if (platform.type === "unacademy") {
        const course = await extractUnacademyCourse(courseId);
        txtContent = formatUnacademyTxt(course);
        displayName = course.name;
      } else if (platform.type === "kgs") {
        const course = await extractKGSCourse(courseId);
        txtContent = formatKGSTxt(course);
        displayName = course.name;
      } else if (platform.type === "vidcrypt") {
        const course = await extractVidCryptCourse(courseId, platform);
        txtContent = formatVidCryptTxt(course);
        displayName = course.name;
      } else {
        // Pass auth token if user is logged in via AppX OTP
        const appxToken = session.appxUser?.appKey === platform.appKey ? session.appxUser?.token : undefined;
        const course = await extractAppXCourse(courseId, platform, appxToken);
        txtContent = formatAppXTxt(course);
        displayName = course.name;
      }

      const totalLinks = (txtContent.match(/https?:\/\//g) ?? []).length;
      const fileName = `${platform.name.replace(/\s+/g, "_")}_${courseId.slice(-8)}.txt`;
      const tmpPath = path.join(os.tmpdir(), fileName);
      fs.writeFileSync(tmpPath, txtContent, "utf-8");

      await bot.editMessageText(
        `✅ <b>Extraction Complete!</b>\n\n${platform.emoji} <b>${platform.name}</b>\n` +
          `📚 <b>${displayName}</b>\n🆔 <code>${courseId}</code>\n🔗 Links: <b>${totalLinks}</b>\n\nFile bhej raha hoon...`,
        { chat_id: chatId, message_id: statusMsg.message_id, parse_mode: "HTML" }
      );

      await bot.sendDocument(chatId, tmpPath, {
        caption:
          `${platform.emoji} <b>${platform.name}</b>\n` +
          `📚 ${displayName}\n🆔 <code>${courseId}</code>\n🔗 Total Links: <b>${totalLinks}</b>`,
        parse_mode: "HTML",
      });

      fs.unlinkSync(tmpPath);

      const retryButtons: TelegramBot.InlineKeyboardButton[][] = [
        [{ text: `🔄 ${platform.name} — Dusra Course`, callback_data: `plat_${platform.id}` }],
      ];
      if (platform.type === "hranker") {
        if (session.hrankerUser?.isDummy) {
          retryButtons.push([{ text: `🔐 Login with my account`, callback_data: `login_${platform.id}` }]);
        } else {
          retryButtons.push([{ text: `🔓 Logout`, callback_data: `logout_${platform.id}` }]);
        }
      }
      retryButtons.push([{ text: "🏠 Main Menu", callback_data: "menu_main" }]);

      await bot.sendMessage(chatId,
        `Kya aur extract karna hai?`,
        {
          parse_mode: "HTML",
          reply_markup: { inline_keyboard: retryButtons },
        }
      );

      // Restore session for next extraction (keep login info for HRanker)
      if (platform.type === "hranker" && session.hrankerUser) {
        setSession(userId, {
          step: "awaiting_course_id",
          platformId: platform.id,
          hrankerUser: session.hrankerUser,
          courseList: session.courseList,
        });
      } else {
        clearSession(userId);
      }
    } catch (err) {
      logger.error({ err }, "Extraction error");
      clearSession(userId);
      await bot.editMessageText(
        `❌ <b>Extraction Failed!</b>\n\n${platform.emoji} <b>${platform.name}</b>\n🆔 <code>${courseId}</code>\n\n` +
          `⚠️ Data extract nahi hua. Course ID check karo.\n\n` +
          `<i>Agar problem continue ho toh try again karo.</i>`,
        {
          chat_id: chatId,
          message_id: statusMsg.message_id,
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [
              [{ text: "🔄 Try Again", callback_data: `plat_${session.platformId}` }],
              [{ text: "🏠 Main Menu", callback_data: "menu_main" }],
            ],
          },
        }
      );
    }
  });

  bot.on("polling_error", (error) => {
    logger.error({ error }, "Polling error");
  });

  return bot;
}

// ─── Helper for HRanker platform selected when already logged in ──────────────

async function handleHRankerPlatformSelected(
  bot: TelegramBot,
  chatId: number,
  messageId: number,
  userId: number,
  platform: import("./platforms/index.js").Platform,
): Promise<void> {
  const session = getSession(userId);

  await bot.editMessageText(
    `${platform.emoji} <b>${platform.name}</b>\n✅ Logged in as <b>${session.hrankerUser?.name}</b>\n\n⏳ Courses fetch ho rahe hain...`,
    { chat_id: chatId, message_id: messageId, parse_mode: "HTML" }
  );

  let courseList: CourseItem[] = [];
  try {
    if (session.hrankerUser) {
      const courses = await listHRankerCourses(session.hrankerUser);
      courseList = courses.map(c => ({ id: c.id, name: c.name }));
    }
  } catch (err) {
    logger.error({ err }, "HRanker course list failed (already logged in)");
  }

  setSession(userId, {
    step: courseList.length > 0 ? "awaiting_course_selection" : "awaiting_course_id",
    platformId: platform.id,
    courseList,
  });

  if (courseList.length > 0) {
    await showCourseList(bot, chatId, messageId, platform.emoji, platform.name, courseList, 0);
  } else {
    await bot.editMessageText(
      `${platform.emoji} <b>${platform.name}</b>\n\n📨 <b>Course ID paste karo:</b>`,
      {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [{ text: `🔓 Logout`, callback_data: `logout_${platform.id}` }],
            [{ text: "🏠 Main Menu", callback_data: "menu_main" }],
          ],
        },
      }
    );
  }
}

// ─── Main Menu ────────────────────────────────────────────────────────────────

function buildMainMenuText(): string {
  const noLoginCount = NO_LOGIN_PLATFORMS.length;
  const vidcryptCount = VIDCRYPT_PLATFORMS.length;
  const loginCount = LOGIN_PLATFORMS.length;
  return (
    `╔══════════════════════════════╗\n` +
    `║   💎 Course Extractor Bot   ║\n` +
    `╚══════════════════════════════╝\n\n` +
    `🎯 <b>Platform Categories:</b>\n\n` +
    `🟢 <b>Without Login</b> — ${noLoginCount} platforms\n` +
    `   <i>Free access, no purchase needed</i>\n\n` +
    `🔷 <b>VidCrypt Platforms</b> — ${vidcryptCount} platforms\n` +
    `   <i>w/o purchase</i>\n\n` +
    `🔐 <b>Login Required</b> — ${loginCount} platforms\n` +
    `   <i>Apne account se login karo</i>\n\n` +
    `━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
    `<i>👇 Category select karo:</i>`
  );
}

function buildMainMenuKeyboard(): TelegramBot.InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [{ text: `🟢 Without Login (${NO_LOGIN_PLATFORMS.length} platforms)`, callback_data: "cat_nologin" }],
      [{ text: `🔷 VidCrypt Platforms (${VIDCRYPT_PLATFORMS.length} platforms)`, callback_data: "cat_vidcrypt" }],
      [{ text: `🔐 Login Required (${LOGIN_PLATFORMS.length} platforms)`, callback_data: "cat_login" }],
      [{ text: "❌ Close", callback_data: "close" }],
    ],
  };
}

async function sendMainMenu(bot: TelegramBot, chatId: number): Promise<void> {
  await bot.sendMessage(chatId, buildMainMenuText(), {
    parse_mode: "HTML",
    reply_markup: buildMainMenuKeyboard(),
  });
}

// ─── Platform List ────────────────────────────────────────────────────────────

async function showPlatformList(
  bot: TelegramBot,
  chatId: number,
  messageId: number,
  category: string,
  page: number,
): Promise<void> {
  let platforms;
  if (category === "vidcrypt") platforms = VIDCRYPT_PLATFORMS;
  else if (category === "login") platforms = LOGIN_PLATFORMS;
  else platforms = NO_LOGIN_PLATFORMS;

  const pages = chunkArray(platforms, ITEMS_PER_PAGE);
  const currentPage = pages[page] ?? [];
  const totalPages = pages.length;

  const catLabel =
    category === "vidcrypt" ? "🔷 VidCrypt Platforms" :
    category === "login" ? "🔐 Login Required Platforms" :
    "🟢 Without Login Platforms";

  let text = `${catLabel} — Page ${page + 1}/${totalPages}\n━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
  for (const p of currentPage) {
    const tag = p.status === "down" ? " ❌" : p.status === "soon" ? " 🔜" : "";
    const caps = [
      p.supportsVideo ? "Vid" : "",
      p.supportsPDF ? "PDF" : "",
      p.supportsTest ? "Test" : "",
    ].filter(Boolean).join(" | ");
    text += `${p.emoji} <b>${p.name}</b>${tag}  <i>(${caps})</i>\n`;
  }
  text += `\n<i>👇 Platform select karo:</i>`;

  const buttons: TelegramBot.InlineKeyboardButton[][] = [];
  for (let i = 0; i < currentPage.length; i += 2) {
    const row: TelegramBot.InlineKeyboardButton[] = [];
    const p1 = currentPage[i];
    if (p1) row.push({ text: `${p1.emoji} ${p1.name}`, callback_data: `plat_${p1.id}` });
    const p2 = currentPage[i + 1];
    if (p2) row.push({ text: `${p2.emoji} ${p2.name}`, callback_data: `plat_${p2.id}` });
    buttons.push(row);
  }

  const navRow: TelegramBot.InlineKeyboardButton[] = [];
  if (page > 0) navRow.push({ text: "⬅️ Prev", callback_data: `page_${category}_${page - 1}` });
  navRow.push({ text: `${page + 1}/${totalPages}`, callback_data: "noop" });
  if (page < totalPages - 1) navRow.push({ text: "Next ➡️", callback_data: `page_${category}_${page + 1}` });

  await bot.editMessageText(text, {
    chat_id: chatId,
    message_id: messageId,
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [
        ...buttons,
        navRow,
        [{ text: "🏠 Main Menu", callback_data: "menu_main" }],
      ],
    },
  });
}

// ─── Course List ──────────────────────────────────────────────────────────────

async function showCourseList(
  bot: TelegramBot,
  chatId: number,
  messageId: number,
  emoji: string,
  platformName: string,
  courseList: CourseItem[],
  page: number,
): Promise<void> {
  const COURSES_PER_PAGE = 20;
  const pages = chunkArray(courseList, COURSES_PER_PAGE);
  const currentPage = pages[page] ?? [];
  const totalPages = pages.length;
  const offset = page * COURSES_PER_PAGE;

  let text =
    `╔══════════════════════════════════════╗\n` +
    `║  ${emoji} ${platformName.toUpperCase().padEnd(34 - platformName.length)}║\n` +
    `║  BATCHES — Page ${page + 1}/${totalPages}`.padEnd(41) + `║\n` +
    `╚══════════════════════════════════════╝\n\n`;

  for (let i = 0; i < currentPage.length; i++) {
    const course = currentPage[i]!;
    text += `${offset + i + 1}. ${course.name}\n`;
  }

  text += `\n━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
  text += `📨 <b>Number bhejo</b> (1-${courseList.length}) <b>ya Course ID paste karo:</b>`;

  const navRow: TelegramBot.InlineKeyboardButton[] = [];
  if (page > 0) navRow.push({ text: "⬅️ Prev", callback_data: `cpage_${page - 1}` });
  navRow.push({ text: `${page + 1}/${totalPages}`, callback_data: "noop" });
  if (page < totalPages - 1) navRow.push({ text: "Next ➡️", callback_data: `cpage_${page + 1}` });

  await bot.editMessageText(text, {
    chat_id: chatId,
    message_id: messageId,
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [
        ...(navRow.length > 1 ? [navRow] : []),
        [{ text: "🏠 Main Menu", callback_data: "menu_main" }],
      ],
    },
  });
}
