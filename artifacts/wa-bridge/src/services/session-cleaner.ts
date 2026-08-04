// ============================================================
// WA-Bridge — Automatic Session Cleaner (Purge Engine)
// Periodically scans for dead, stale, or orphaned sessions.
// ============================================================

import { logger } from '../utils/logger.js';
import { getAllUserIds, loadAllSessions, purgeSession } from './workspace.js';
import { getAllSockets, closeSocket, markPurged } from '../whatsapp/socket-manager.js';
import fs from 'fs';
import path from 'path';

const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // Every 5 minutes
const PAIRING_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes for pairing

let cleanerTimer: NodeJS.Timeout | null = null;

/**
 * The core Session Cleaner / Purge Engine.
 * Implements the "Session Cleaner" requirements.
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

      // Check for stale pairing
      if (status === 'PAIRING' && !pairedAt) {
        const age = Date.now() - (meta.lastSeen || Date.now());
        if (age > PAIRING_TIMEOUT_MS) {
          shouldPurge = true;
          reason = 'Stale pairing timeout';
        }
      }

      // Check for invalid status
      if (status === 'PURGED') {
        shouldPurge = true;
        reason = 'Marked as purged';
      }

      // Check for missing auth files for ACTIVE sessions
      if (status === 'ACTIVE') {
        const authDir = path.join(process.cwd(), 'workspaces', telegramId, 'sessions', sessionId, 'auth');
        if (!fs.existsSync(path.join(authDir, 'creds.json'))) {
          shouldPurge = true;
          reason = 'Missing authentication credentials';
        }
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
    if (handle.socket.ws?.readyState === 3) { // CLOSED
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
