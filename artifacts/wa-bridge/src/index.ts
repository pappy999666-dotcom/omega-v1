// ============================================================
// WA-Bridge — Main Entry Point
// Telegram ↔ WhatsApp Automation Bridge
// Initialization: Redis → WorkerPool → SocketManager → TelegramBot
// ============================================================

import 'dotenv/config';
import { ensureRuntimeEnv } from './web/env-prompt.js';
import { runSetupWizard } from './setup/index.js';
import fs from 'fs';
import { startWebServer } from './web/server.js';
import { logger } from './utils/logger.js';
import { getRedis, shutdownQueues } from './services/queue.js';
import { startOutreachWorker } from './services/workers/outreach-worker.js';
import { startValidatorWorker } from './services/workers/validator-worker.js';
import { startLifecycleWorker } from './services/workers/lifecycle-worker.js';
import { startOmniWorker } from './services/workers/omni-worker.js';
import { setAlertCallback, setEventCallback, getUserSockets, getSocket, closeAllSockets } from './whatsapp/socket-manager.js';
import { handleWAEvent, registerSessionOwner } from './whatsapp/event-handlers.js';
import { createBot, createAlertSender } from './telegram/bot.js';
import { getAllUserIds, loadAllSessions } from './services/workspace.js';
import { setOutreachBotRef } from './services/workers/outreach-worker.js';
import { setValidatorBotRef } from './services/workers/validator-worker.js';
import { setLifecycleBotRef } from './services/workers/lifecycle-worker.js';
import { startAutoPromoteScheduler } from './services/auto-promote.js';
import { initSocket } from './whatsapp/socket-manager.js';
import type { BaileysEventMap } from './whatsapp/baileys-types.js';
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

  // Check if configuration is missing
  if (!fs.existsSync('.env') || !fs.existsSync('config.json')) {
    console.log('\x1b[33mConfiguration missing. Entering Setup Mode...\x1b[0m');
    await runSetupWizard();
    // Re-load environment after setup
    const dotenv = await import('dotenv');
    dotenv.config();
  } else {
    await ensureRuntimeEnv();
  }

  logger.info('[Boot] Starting WA-Bridge...');

  // 1. Verify environment & Build
  const healthResults: any[] = [];
  
  // Check required env
  const requiredEnv = ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_OWNER_ID'];
  for (const key of requiredEnv) {
    if (!process.env[key]) {
      healthResults.push({ component: `Env: ${key}`, status: 'error', message: 'Missing' });
    } else {
      healthResults.push({ component: `Env: ${key}`, status: 'ok' });
    }
  }

  // Check directories
  const dirs = ['logs', 'sessions', 'uploads', 'temp'];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) {
      try {
        fs.mkdirSync(dir, { recursive: true });
        healthResults.push({ component: `Dir: ${dir}`, status: 'ok', message: 'Created' });
      } catch (e) {
        healthResults.push({ component: `Dir: ${dir}`, status: 'error', message: 'Failed to create' });
      }
    } else {
      healthResults.push({ component: `Dir: ${dir}`, status: 'ok' });
    }
  }

  // Import HealthReporter
  const { HealthReporter } = await import('./utils/HealthReporter.js');
  
  // 2. Test Redis connection without blocking core Telegram/WhatsApp controls forever.
  logger.info('[Boot] Connecting to Redis...');
  const redis = getRedis();
  let redisAvailable = false;
  try {
    await Promise.race([
      redis.ping(),
      new Promise<never>((_, reject) => {
        const timer = setTimeout(() => reject(new Error('Redis startup timeout')), 10_000);
        timer.unref();
      }),
    ]);
    redisAvailable = true;
    logger.info('[Boot] Redis connected ✓');
  } catch (err) {
    logger.warn('[Boot] Redis unavailable; starting in degraded mode without BullMQ workers', {
      err: err instanceof Error ? err.message : String(err),
    });
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

  if (redisAvailable) {
    startOutreachWorker();
    startValidatorWorker();
    startLifecycleWorker();
    startOmniWorker();
    logger.info('[Boot] BullMQ workers started ✓');
    healthResults.push({ component: 'Redis Workers', status: 'ok' });
  } else {
    logger.warn('[Boot] Queue-backed bulk operations are disabled until the next healthy restart');
    healthResults.push({ component: 'Redis Workers', status: 'warn', message: 'Disabled (Redis unavailable)' });
  }

  // 7. Restore active sessions from disk
  logger.info('[Boot] Restoring sessions from disk...');
  try {
    await restoreSessions();
    healthResults.push({ component: 'Sessions', status: 'ok' });
  } catch (e) {
    healthResults.push({ component: 'Sessions', status: 'warn', message: 'Failed to restore' });
  }

  // Start auto-promote scheduler (7 AM + 6 PM WAT daily)
  startAutoPromoteScheduler();
  healthResults.push({ component: 'Schedulers', status: 'ok' });

  // 8. Launch web dashboard
  try {
    await startWebServer();
    healthResults.push({ component: 'Web Server', status: 'ok', message: `Port ${process.env.WEB_PORT || 3000}` });
  } catch (e) {
    healthResults.push({ component: 'Web Server', status: 'error', message: String(e) });
  }

  // 9. Launch Telegram bot
  logger.info('[Boot] Launching Telegram bot...');
  try {
    await bot.launch({
      allowedUpdates: [
        'message',
        'callback_query',
        'inline_query',
        'chosen_inline_result',
      ],
    });
    healthResults.push({ component: 'Telegram Bot', status: 'ok' });
  } catch (e) {
    healthResults.push({ component: 'Telegram Bot', status: 'error', message: 'Failed to launch' });
  }

  // Display Health Report
  const isHealthy = HealthReporter.display(healthResults);

  if (!isHealthy) {
    console.log('\x1b[31mCritical startup failures detected. Check logs for details.\x1b[0m');
    // We don't exit here to allow for manual inspection if needed, but in production we might.
  }

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
    await closeAllSockets();
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
      // Restore open sessions and frozen sessions (frozen = user-paused, still paired).
      // On restart the in-memory freeze flag is gone, so frozen sessions come back live.
      // We reset their status to 'open' before restoring so they reconnect normally.
      if (!meta.pairedAt) continue;
      if (meta.status !== 'open' && meta.status !== 'frozen') continue;

      // Clear stale frozen status — bot restarted, no reason to stay frozen
      if (meta.status === 'frozen') {
        meta.status = 'open';
        const { saveSessionMeta } = await import('./services/workspace.js');
        saveSessionMeta(meta);
      }

      try {
        registerSessionOwner(meta.sessionId, telegramId);
        await initSocket(meta, {});
        restored++;
        await sleep(1500);
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
