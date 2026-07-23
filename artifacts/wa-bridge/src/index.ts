// ============================================================
// WA-Bridge — Main Entry Point
// Telegram ↔ WhatsApp Automation Bridge
// Initialization: Redis → WorkerPool → SocketManager → TelegramBot
// ============================================================

import 'dotenv/config';
import { logger } from './utils/logger.js';
import { getRedis, shutdownQueues } from './services/queue.js';
import { startOutreachWorker } from './services/workers/outreach-worker.js';
import { startValidatorWorker } from './services/workers/validator-worker.js';
import { startLifecycleWorker } from './services/workers/lifecycle-worker.js';
import { startOmniWorker } from './services/workers/omni-worker.js';
import { setAlertCallback, setEventCallback, getUserSockets, getSocket } from './whatsapp/socket-manager.js';
import { handleWAEvent, registerSessionOwner } from './whatsapp/event-handlers.js';
import { createBot, createAlertSender } from './telegram/bot.js';
import { getAllUserIds, loadAllSessions } from './services/workspace.js';
import { setOutreachBotRef } from './services/workers/outreach-worker.js';
import { setValidatorBotRef } from './services/workers/validator-worker.js';
import { setLifecycleBotRef } from './services/workers/lifecycle-worker.js';
import { initSocket } from './whatsapp/socket-manager.js';
import type { BaileysEventMap } from '@whiskeysockets/baileys';
import { sleep } from './utils/delay.js';

// ── ASCII Banner ──────────────────────────────────────────

function printBanner(): void {
  console.log(`
╔═══════════════════════════════════════════════════╗
║                                                   ║
║   ██╗    ██╗ █████╗       ██████╗ ██████╗        ║
║   ██║    ██║██╔══██╗     ██╔══██╗██╔══██╗        ║
║   ██║ █╗ ██║███████║     ██████╔╝██████╔╝        ║
║   ██║███╗██║██╔══██║     ██╔══██╗██╔══██╗        ║
║   ╚███╔███╔╝██║  ██║     ██████╔╝██║  ██║        ║
║    ╚══╝╚══╝ ╚═╝  ╚═╝     ╚═════╝ ╚═╝  ╚═╝        ║
║                                                   ║
║   Telegram ↔ WhatsApp Automation Bridge v1.0      ║
║   Production-Grade Multi-Device Control Center    ║
╚═══════════════════════════════════════════════════╝
`);
}

// ── Startup Sequence ──────────────────────────────────────

async function bootstrap(): Promise<void> {
  printBanner();
  logger.info('[Boot] Starting WA-Bridge...');

  // 1. Verify environment
  if (!process.env.TELEGRAM_BOT_TOKEN) {
    throw new Error('TELEGRAM_BOT_TOKEN is required. Copy .env.example to .env and fill it in.');
  }
  if (!process.env.TELEGRAM_OWNER_ID) {
    throw new Error('TELEGRAM_OWNER_ID is required.');
  }

  // 2. Test Redis connection
  logger.info('[Boot] Connecting to Redis...');
  const redis = getRedis();
  try {
    await redis.ping();
    logger.info('[Boot] Redis connected ✓');
  } catch (err) {
    throw new Error(`Redis connection failed: ${err}. Is Redis running?`);
  }

  // 3. Start Telegram bot
  logger.info('[Boot] Initializing Telegram bot...');
  const bot = createBot();

  // 4. Wire alert callback (socket → Telegram)
  setAlertCallback(createAlertSender(bot));

  // 5. Wire WhatsApp event callback
  setEventCallback((sessionId, event, data) => {
    const socket = getSocket(sessionId);
    if (socket) {
      handleWAEvent(sessionId, event as keyof BaileysEventMap, data, socket).catch((err) => {
        logger.error('[EventHandler] Error', { sessionId, err: String(err) });
      });
    }
  });

  // 6. Start BullMQ workers
  logger.info('[Boot] Starting BullMQ workers...');
  const botRef = {
    telegram: {
      sendMessage: (chatId: number, text: string, opts?: object) =>
        bot.telegram.sendMessage(chatId, text, opts),
      editMessageText: (chatId: number, msgId: number, _: null, text: string, opts?: object) =>
        bot.telegram.editMessageText(chatId, msgId, undefined, text, opts as Parameters<typeof bot.telegram.editMessageText>[4]),
    },
  };

  setOutreachBotRef(botRef);
  setValidatorBotRef(botRef);
  setLifecycleBotRef(botRef);

  startOutreachWorker();
  startValidatorWorker();
  startLifecycleWorker();
  startOmniWorker();
  logger.info('[Boot] BullMQ workers started ✓');

  // 7. Restore active sessions from disk
  logger.info('[Boot] Restoring sessions from disk...');
  await restoreSessions();

  // 8. Launch Telegram bot
  logger.info('[Boot] Launching Telegram bot...');
  await bot.launch({
    allowedUpdates: [
      'message',
      'callback_query',
      'inline_query',
      'chosen_inline_result',
    ],
  });

  logger.info('[Boot] WA-Bridge is live! ✓');

  // Notify owner on startup
  try {
    await bot.telegram.sendMessage(
      parseInt(process.env.TELEGRAM_OWNER_ID!, 10),
      `🟢 <b>WA-Bridge started</b>\n\nAll systems operational. Use /start to begin.`,
      { parse_mode: 'HTML' }
    );
  } catch {
    // Owner may not have started the bot yet
  }

  // ── Graceful Shutdown ──────────────────────────────────
  const shutdown = async (signal: string) => {
    logger.info(`[Shutdown] ${signal} received — shutting down gracefully...`);

    bot.stop(signal);
    await shutdownQueues();

    logger.info('[Shutdown] Goodbye!');
    process.exit(0);
  };

  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

// ── Session Restoration ───────────────────────────────────

async function restoreSessions(): Promise<void> {
  const userIds = getAllUserIds();
  let restored = 0;

  for (const telegramId of userIds) {
    const sessions = loadAllSessions(telegramId);

    for (const meta of Object.values(sessions)) {
      // Only restore sessions that were previously open
      if (meta.status !== 'open' && meta.status !== 'connecting') continue;

      try {
        registerSessionOwner(meta.sessionId, telegramId);
        await initSocket(meta, {});
        restored++;
        await sleep(1500); // Stagger reconnects
      } catch (err) {
        logger.warn(`[Boot] Failed to restore session ${meta.sessionId}`, {
          err: String(err),
        });
      }
    }
  }

  logger.info(`[Boot] Restored ${restored} session(s)`);
}

// ── Run ───────────────────────────────────────────────────

bootstrap().catch((err) => {
  logger.error('[Boot] Fatal error during startup', { err: String(err) });
  process.exit(1);
});
