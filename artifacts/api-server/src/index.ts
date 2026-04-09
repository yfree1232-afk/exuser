import app from "./app.js";
import { logger } from "./lib/logger.js";
import { startBot } from "./bot/bot.js";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
});

// Start Telegram bot
try {
  startBot();
  logger.info("Telegram bot polling started");
} catch (err) {
  logger.error({ err }, "Failed to start Telegram bot");
}
