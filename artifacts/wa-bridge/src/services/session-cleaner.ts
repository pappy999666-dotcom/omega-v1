// ============================================================
// WA-Bridge — Automatic Session Cleaner (Purge Engine)
// Periodically scans for dead, stale, or orphaned sessions.
//
// STATE MACHINE CONTRACT:
//   Only terminal/stale states are eligible for automatic cleanup.
//   ACTIVE sessions must NEVER be purged automatically — only via
//   explicit user action or a hard auth error from Baileys itself.
//
// States eligible for automatic cleanup:
//   PAIRING  — only after timeout (no successful auth in time)
//   PURGED   — file-system cleanup of already-purged entries
//
// States that are NEVER touched by the cleaner:
//   ACTIVE, CONNECTING, FROZEN, FAILED, LOGGED_OUT
// ============================================================

import { logger } from '../utils/logger.js';
import { getAllUserIds, loadAllSessions, purgeSession, sessionAuthDir } from './workspace.js';
import { getAllSockets, closeSocket, markPurged } from '../whatsapp/socket-manager.js';
import fs from 'fs';
import path from 'path';

const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // Every 5 minutes
const PAIRING_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes for pairing

let cleanerTimer: NodeJS.Timeout | null = null;

/**
 * The core Session Cleaner / Purge Engine.
 * Implements the "Session Cleaner" requirements.
 *
 * ACTIVE sessions are NEVER purged here — they are only managed
 * by explicit user action or Baileys auth-error recovery.
 */
export async function runSessionCleanup(): Promise<void> {
  logger.info('[SessionCleaner] Starting periodic cleanup scan...');
  
  const userIds = getAllUserIds();
  const activeSockets = getAllSockets();
  let cleanedCount = 0;

  // 1. Scan all sessions on disk
  for (const telegramId of userIds) {
    const sessions = loadAllSessions(telegramId);

    for (const meta of Object.values(sessions)) {
      const { sessionId, status, pairedAt } = meta;
      let shouldPurge = false;
      let reason = '';

      // Check for stale pairing (no successful auth within the timeout window)
      if (status === 'PAIRING' && !pairedAt) {
        const age = Date.now() - (meta.lastSeen || Date.now());
        if (age > PAIRING_TIMEOUT_MS) {
          shouldPurge = true;
          reason = 'Stale pairing timeout';
        }
      }

      // Clean up file-system remnants of already-purged entries
      if (status === 'PURGED') {
        shouldPurge = true;
        reason = 'Marked as purged';
      }

      // ── SAFETY: ACTIVE sessions are NEVER purged by the cleaner ──
      // If creds are missing for an ACTIVE session, only warn.
      // Recovery is handled by Baileys (it will emit a 401/disconnect
      // which then triggers the proper classifyBaileysError → purge path).
      if (status === 'ACTIVE') {
        const authDir = sessionAuthDir(telegramId, sessionId);
        if (!fs.existsSync(path.join(authDir, 'creds.json'))) {
          logger.warn(
            `[SessionCleaner] ACTIVE session ${sessionId} is missing creds.json — ` +
            `NOT purging (Baileys will handle this via auth error). Investigate if this persists.`
          );
        }
        // Do NOT set shouldPurge for ACTIVE sessions.
      }

      if (shouldPurge) {
        logger.warn(`[SessionCleaner] Purging session ${sessionId}: ${reason}`);
        await purgeSession(telegramId, sessionId);
        cleanedCount++;
      }
    }
  }

  // 2. Scan active sockets for orphans or duplicates
  for (const [sessionId, handle] of activeSockets.entries()) {
    // Check if session still exists on disk
    const sessions = loadAllSessions(handle.meta.telegramId);
    if (!sessions[sessionId]) {
      logger.warn(`[SessionCleaner] Closing orphaned socket: ${sessionId}`);
      markPurged(sessionId);
      await closeSocket(sessionId);
      cleanedCount++;
    }

    // Check for dead sockets (Baileys might leave them hanging)
    if ((handle.socket as any).ws?.readyState === 3) { // CLOSED
      logger.warn(`[SessionCleaner] Detected dead socket: ${sessionId}`);
      await closeSocket(sessionId);
      cleanedCount++;
    }
  }

  logger.info(`[SessionCleaner] Cleanup scan complete. Removed ${cleanedCount} stale sessions.`);
}

export function startSessionCleaner(): void {
  if (cleanerTimer) return;
  
  // Run once on startup
  runSessionCleanup().catch(err => logger.error('[SessionCleaner] Initial run failed', { err: String(err) }));
  
  cleanerTimer = setInterval(() => {
    runSessionCleanup().catch(err => logger.error('[SessionCleaner] Periodic run failed', { err: String(err) }));
  }, CLEANUP_INTERVAL_MS);
  
  logger.info('[SessionCleaner] Periodic cleaner service started');
}

export function stopSessionCleaner(): void {
  if (cleanerTimer) {
    clearInterval(cleanerTimer);
    cleanerTimer = null;
    logger.info('[SessionCleaner] Service stopped');
  }
}
