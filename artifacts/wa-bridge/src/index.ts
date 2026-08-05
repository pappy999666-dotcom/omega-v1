// ============================================================
// WA-Bridge — Main Entry Point
// Telegram ↔ WhatsApp Automation Bridge
// Initialization: Redis → WorkerPool → SocketManager → TelegramBot
// ============================================================

import 'dotenv/config';

import { runSetupWizard } from './setup/index.js';
import fs from 'fs';
import path from 'path';
import { startWebServer, setBotReference } from './web/server.js';
import { logger } from './utils/logger.js';
import { getRedis, shutdownQueues } from './services/queue.js';
import { startOutreachWorker } from './services/workers/outreach-worker.js';
import { startValidatorWorker } from './services/workers/validator-worker.js';
import { startLifecycleWorker } from './services/workers/lifecycle-worker.js';
import { startOmniWorker } from './services/workers/omni-worker.js';
import { startSessionCleaner } from './services/session-cleaner.js';
import { setAlertCallback, setEventCallback, getUserSockets, getSocket, closeAllSockets } from './whatsapp/socket-manager.js';
import { handleWAEvent, registerSessionOwner } from './whatsapp/event-handlers.js';
import { createBot, createAlertSender } from './telegram/bot.js';
import { getAllUserIds, loadAllSessions, purgeSession, sessionAuthDir } from './services/workspace.js';
import { drainPendingRestores } from './whatsapp/anti-system/group-security-engine.js';
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

  // The main setup script handles initial configuration and wizard execution.
  // If we reach here, configuration is assumed to be present or handled.

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
  setBotReference(bot);

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
    const { resumeStalledJobs, cleanupOrphanedJobs } = await import('./services/queue.js');
    await resumeStalledJobs();
    await cleanupOrphanedJobs();
    
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

  // Start automatic session cleaner (Purge Engine)
  startSessionCleaner();
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

/**
 * Startup Validation: Restores and validates every saved session.
 * Implements the "Startup Validation" requirements.
 */
async function restoreSessions(): Promise<void> {
  const userIds = getAllUserIds();
  let restored = 0;
  let purged = 0;

  for (const telegramId of userIds) {
    const sessions = loadAllSessions(telegramId);

    for (const meta of Object.values(sessions)) {
      const { sessionId, status } = meta;

      // 1. Abandoned Pairings
      // Only purge sessions explicitly in PAIRING state — these were left mid-pair
      // during a crash/shutdown and have no valid credentials.
      // Do NOT purge based on !meta.pairedAt alone: an ACTIVE session with a missing
      // pairedAt timestamp (e.g. from an older code version) must not be silently wiped.
      if (status === 'PAIRING') {
        logger.warn(`[Boot] Purging stale pairing session: ${sessionId}`);
        await purgeSession(telegramId, sessionId);
        purged++;
        continue;
      }

      // 2. Frozen Sessions
      // Frozen sessions survive restart but are NOT reconnected.
      if (status === 'FROZEN') {
        logger.info(`[Boot] Session ${sessionId} is FROZEN. Preserving state.`);
        registerSessionOwner(sessionId, telegramId);
        continue;
      }

      // 3. Purged Sessions
      // Already marked for deletion.
      if (status === 'PURGED') {
        logger.info(`[Boot] Session ${sessionId} is already PURGED. Cleaning up files...`);
        await purgeSession(telegramId, sessionId);
        continue;
      }

      // 4. Active Sessions
      // Attempt to restore and validate authentication.
      // NOTE: If creds.json is missing, do NOT purge — let Baileys attempt
      // to connect; it will emit a 401/disconnect which the error-recovery
      // path handles. Purging here would destroy a session that may simply
      // be on a slow file-system or was interrupted mid-write.
      try {
        registerSessionOwner(sessionId, telegramId);

        const authDir = sessionAuthDir(telegramId, sessionId);
        if (!fs.existsSync(path.join(authDir, 'creds.json'))) {
          logger.warn(
            `[Boot] Auth credentials missing for ${sessionId}. ` +
            `Session preserved as FROZEN — user must manually reconnect.`
          );
          // Freeze instead of purge: the session data is kept, the user can
          // re-pair or manually delete it. Baileys cannot connect without creds.
          const { updateSessionMeta } = await import('./services/workspace.js');
          updateSessionMeta(telegramId, sessionId, { status: 'FROZEN' });
          registerSessionOwner(sessionId, telegramId);
          continue;
        }

        await initSocket(meta, {
          onConnected: async (sid, _isFirst) => {
            // Drain any pending Group Security restores (AntiPromote/AntiDemote
            // reverts that failed during the previous run) now that the socket is live.
            const socket = (await import('./whatsapp/socket-manager.js')).getSocket(sid);
            if (socket) {
              await drainPendingRestores(socket, sid, telegramId).catch((err) => {
                logger.warn('[Boot] drainPendingRestores failed', { err: String(err), sid });
              });
            }
          },
        });
        restored++;
        
        // Throttle reconnection to avoid WhatsApp rate limits on startup
        await sleep(2000);
      } catch (err) {
        logger.error(`[Boot] Failed to restore ${sessionId}. Freezing to preserve auth data.`, {
          err: String(err),
        });
        // Freeze instead of purge: keeps auth data intact so the user can
        // manually reinitialize. Avoids accidentally losing a valid session
        // due to a transient startup error.
        try {
          const { updateSessionMeta } = await import('./services/workspace.js');
          updateSessionMeta(telegramId, sessionId, { status: 'FROZEN' });
        } catch { /* ignore secondary error */ }
      }
    }
  }

  logger.info(`[Boot] Restoration complete: ${restored} active, ${purged} purged.`);
}

// ── Run ───────────────────────────────────────────────────

bootstrap().catch((err) => {
  logger.error('[Boot] Fatal error during startup', { err: String(err) });
  process.exit(1);
});

