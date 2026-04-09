import TelegramBot from "node-telegram-bot-api";
import fs from "fs";
import os from "os";
import path from "path";
import { getSession, setSession, clearSession } from "./utils/session.js";
import {
  PLATFORMS,
  NO_LOGIN_PLATFORMS,
  VIDCRYPT_PLATFORMS,
  getPlatform,
} from "./platforms/index.js";
import { extractPinnacleCourse, formatPinnacleTxt } from "./platforms/pinnacle.js";
import { extractAppXCourse, formatAppXTxt } from "./platforms/appx.js";
import { extractVidCryptCourse, formatVidCryptTxt } from "./platforms/vidcrypt.js";
import { extractUnacademyCourse, formatUnacademyTxt } from "./platforms/unacademy.js";
import { extractKGSCourse, formatKGSTxt } from "./platforms/kgs.js";
import { logger } from "../lib/logger.js";

const BOT_NAME = "Course Extractor Bot";
const VERSION = "v1.0";

const ITEMS_PER_PAGE = 8;

function chunkArray<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

export function startBot(): TelegramBot {
  const token = process.env["TELEGRAM_BOT_TOKEN"];
  if (!token) {
    throw new Error("TELEGRAM_BOT_TOKEN is not set");
  }

  const bot = new TelegramBot(token, { polling: true });

  logger.info("Telegram bot started");

  // ─── /start ────────────────────────────────────────────────────────
  bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from?.id ?? chatId;
    clearSession(userId);
    await sendMainMenu(bot, chatId);
  });

  // ─── Callback queries (button clicks) ──────────────────────────────
  bot.on("callback_query", async (query) => {
    if (!query.message) return;
    const chatId = query.message.chat.id;
    const userId = query.from.id;
    const data = query.data ?? "";

    await bot.answerCallbackQuery(query.id);

    // ── Main menu ──
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

    // ── No login category ──
    if (data === "cat_nologin") {
      setSession(userId, { step: "awaiting_platform", category: "nologin" });
      await showPlatformList(bot, chatId, query.message.message_id, "nologin", 0);
      return;
    }

    // ── VidCrypt category ──
    if (data === "cat_vidcrypt") {
      setSession(userId, { step: "awaiting_platform", category: "vidcrypt" });
      await showPlatformList(bot, chatId, query.message.message_id, "vidcrypt", 0);
      return;
    }

    // ── Pagination ──
    if (data.startsWith("page_")) {
      const parts = data.split("_");
      const category = parts[1]!;
      const page = parseInt(parts[2] ?? "0", 10);
      await showPlatformList(bot, chatId, query.message.message_id, category, page);
      return;
    }

    // ── Platform selected ──
    if (data.startsWith("plat_")) {
      const platformId = data.replace("plat_", "");
      const platform = getPlatform(platformId);
      if (!platform) return;

      if (platform.status === "down") {
        await bot.editMessageText(
          `⚠️ <b>${platform.name}</b> is currently <b>DOWN</b>.\n\nPlease try another platform.`,
          {
            chat_id: chatId,
            message_id: query.message.message_id,
            parse_mode: "HTML",
            reply_markup: { inline_keyboard: [[{ text: "🔙 Back", callback_data: `cat_${getSession(userId).category}` }]] },
          },
        );
        return;
      }

      if (platform.status === "soon") {
        await bot.editMessageText(
          `🔜 <b>${platform.name}</b> is <b>Coming Soon!</b>\n\nStay tuned.`,
          {
            chat_id: chatId,
            message_id: query.message.message_id,
            parse_mode: "HTML",
            reply_markup: { inline_keyboard: [[{ text: "🔙 Back", callback_data: `cat_${getSession(userId).category}` }]] },
          },
        );
        return;
      }

      setSession(userId, { step: "awaiting_course_id", platformId });

      const caps: string[] = [];
      if (platform.supportsVideo) caps.push("🎬 Videos");
      if (platform.supportsPDF) caps.push("📄 PDFs");
      if (platform.supportsTest) caps.push("📝 Tests");

      await bot.editMessageText(
        `${platform.emoji} <b>${platform.name}</b>\n\n` +
          `<b>Supports:</b> ${caps.join(", ")}\n\n` +
          `📨 <b>Course ID bhejo extract karne ke liye:</b>`,
        {
          chat_id: chatId,
          message_id: query.message.message_id,
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [
              [{ text: "❌ Cancel", callback_data: `cat_${getSession(userId).category}` }],
            ],
          },
        },
      );
      return;
    }

    // ── Cancel / close ──
    if (data === "close") {
      await bot.deleteMessage(chatId, query.message.message_id);
      return;
    }
  });

  // ─── Text messages (course ID input) ───────────────────────────────
  bot.on("message", async (msg) => {
    if (!msg.text || msg.text.startsWith("/")) return;
    const chatId = msg.chat.id;
    const userId = msg.from?.id ?? chatId;
    const session = getSession(userId);

    if (session.step !== "awaiting_course_id") return;
    if (!session.platformId) return;

    const courseId = msg.text.trim();
    const platform = getPlatform(session.platformId);
    if (!platform) return;

    setSession(userId, { step: "extracting" });

    const statusMsg = await bot.sendMessage(
      chatId,
      `⏳ <b>Extracting...</b>\n\n${platform.emoji} <b>${platform.name}</b>\n🆔 Course ID: <code>${courseId}</code>\n\nPlease wait...`,
      { parse_mode: "HTML" },
    );

    try {
      let txtContent = "";
      let fileName = `${platform.id}_${courseId}`;

      if (platform.type === "pinnacle") {
        const course = await extractPinnacleCourse(courseId);
        txtContent = formatPinnacleTxt(course);
        fileName = `Pinnacle_${courseId}`;
      } else if (platform.type === "unacademy") {
        const course = await extractUnacademyCourse(courseId);
        txtContent = formatUnacademyTxt(course);
        fileName = `Unacademy_${courseId}`;
      } else if (platform.type === "kgs") {
        const course = await extractKGSCourse(courseId);
        txtContent = formatKGSTxt(course);
        fileName = `KGS_${courseId}`;
      } else if (platform.type === "vidcrypt") {
        const course = await extractVidCryptCourse(courseId, platform);
        txtContent = formatVidCryptTxt(course);
        fileName = `${platform.name.replace(/\s+/g, "_")}_${courseId}`;
      } else {
        // AppX-based
        const course = await extractAppXCourse(courseId, platform);
        txtContent = formatAppXTxt(course);
        fileName = `${platform.name.replace(/\s+/g, "_")}_${courseId}`;
      }

      // Write to temp file
      const tmpPath = path.join(os.tmpdir(), `${fileName}.txt`);
      fs.writeFileSync(tmpPath, txtContent, "utf-8");

      // Count lines
      const totalLinks = (txtContent.match(/https?:\/\//g) || []).length;

      await bot.editMessageText(
        `✅ <b>Extraction Complete!</b>\n\n${platform.emoji} <b>${platform.name}</b>\n🆔 Course ID: <code>${courseId}</code>\n🔗 Links found: <b>${totalLinks}</b>\n\n📄 Sending file...`,
        {
          chat_id: chatId,
          message_id: statusMsg.message_id,
          parse_mode: "HTML",
        },
      );

      await bot.sendDocument(chatId, tmpPath, {
        caption: `${platform.emoji} <b>${platform.name}</b>\n🆔 <code>${courseId}</code>\n🔗 Total links: <b>${totalLinks}</b>`,
        parse_mode: "HTML",
      });

      fs.unlinkSync(tmpPath);
    } catch (err) {
      logger.error({ err }, "Extraction error");
      await bot.editMessageText(
        `❌ <b>Extraction Failed!</b>\n\n${platform.emoji} <b>${platform.name}</b>\n🆔 Course ID: <code>${courseId}</code>\n\n⚠️ Error: Could not extract course data.\n\nPlease verify the Course ID and try again.`,
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
        },
      );
    } finally {
      clearSession(userId);
    }
  });

  // ─── Error handling ─────────────────────────────────────────────────
  bot.on("polling_error", (error) => {
    logger.error({ error }, "Polling error");
  });

  return bot;
}

// ─── Helper: Main Menu ───────────────────────────────────────────────

function buildMainMenuText(): string {
  return (
    `<b>💎 Course Extractor Bot 💎</b>\n` +
    `<i>${VERSION}</i>\n\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `🎯 <b>Platform Categories:</b>\n\n` +
    `🟢 <b>Without Login</b> — Free access (18 platforms)\n` +
    `🔷 <b>VidCrypt Platforms</b> — w/o purchase (15 platforms)\n\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `<i>Select a category below 👇</i>`
  );
}

function buildMainMenuKeyboard(): TelegramBot.InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [{ text: "🟢 Without Login (18 platforms)", callback_data: "cat_nologin" }],
      [{ text: "🔷 VidCrypt Platforms (15 platforms)", callback_data: "cat_vidcrypt" }],
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

// ─── Helper: Platform List with Pagination ───────────────────────────

async function showPlatformList(
  bot: TelegramBot,
  chatId: number,
  messageId: number,
  category: string,
  page: number,
): Promise<void> {
  const platforms =
    category === "vidcrypt" ? VIDCRYPT_PLATFORMS : NO_LOGIN_PLATFORMS;
  const pages = chunkArray(platforms, ITEMS_PER_PAGE);
  const currentPage = pages[page] ?? [];
  const totalPages = pages.length;

  const catLabel = category === "vidcrypt" ? "🔷 VidCrypt Platforms" : "🟢 Without Login Platforms";

  let text = `${catLabel}\n<b>Page ${page + 1}/${totalPages}</b>\n━━━━━━━━━━━━━━━━━━━━\n\n`;
  for (const p of currentPage) {
    const statusTag =
      p.status === "down" ? " ❌ DOWN" : p.status === "soon" ? " 🔜 SOON" : "";
    const caps: string[] = [];
    if (p.supportsVideo) caps.push("Vid");
    if (p.supportsPDF) caps.push("PDF");
    if (p.supportsTest) caps.push("Test");
    text += `${p.emoji} <b>${p.name}</b>${statusTag}\n`;
    text += `   <i>${caps.join(" | ")}</i>\n\n`;
  }

  // Build keyboard
  const platformButtons: TelegramBot.InlineKeyboardButton[][] = [];

  for (let i = 0; i < currentPage.length; i += 2) {
    const row: TelegramBot.InlineKeyboardButton[] = [];
    const p1 = currentPage[i];
    if (p1) row.push({ text: `${p1.emoji} ${p1.name}`, callback_data: `plat_${p1.id}` });
    const p2 = currentPage[i + 1];
    if (p2) row.push({ text: `${p2.emoji} ${p2.name}`, callback_data: `plat_${p2.id}` });
    platformButtons.push(row);
  }

  // Pagination row
  const navRow: TelegramBot.InlineKeyboardButton[] = [];
  if (page > 0) {
    navRow.push({ text: "⬅️ Previous", callback_data: `page_${category}_${page - 1}` });
  }
  navRow.push({ text: `📄 ${page + 1}/${totalPages}`, callback_data: "noop" });
  if (page < totalPages - 1) {
    navRow.push({ text: "Next ➡️", callback_data: `page_${category}_${page + 1}` });
  }

  const keyboard: TelegramBot.InlineKeyboardMarkup = {
    inline_keyboard: [
      ...platformButtons,
      navRow,
      [{ text: "🏠 Main Menu", callback_data: "menu_main" }],
    ],
  };

  await bot.editMessageText(text, {
    chat_id: chatId,
    message_id: messageId,
    parse_mode: "HTML",
    reply_markup: keyboard,
  });
}
