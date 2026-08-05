// ============================================================
// Group Security Engine — Pending Restore Persistence
// ============================================================
//
// Restores that fail all retry attempts are written to disk so
// they survive restarts and are retried after reconnect.
//
// File: workspaces/{tg_id}/sessions/{session_id}/pending-restores.json
// ============================================================

import fs from 'fs';
import path from 'path';
import { sessionDir } from '../../services/workspace.js';
import { logger } from '../../utils/logger.js';

export interface PendingRestore {
  id: string;
  groupJid: string;
  participants: string[];
  action: 'promote' | 'demote';
  reason: string;
  addedAt: string;
}

function restorePath(sessionId: string, telegramId: string): string {
  return path.join(sessionDir(telegramId, sessionId), 'pending-restores.json');
}

function loadAll(sessionId: string, telegramId: string): PendingRestore[] {
  const p = restorePath(sessionId, telegramId);
  if (!fs.existsSync(p)) return [];
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8')) as PendingRestore[];
  } catch (err) {
    logger.warn('[PendingRestores] Failed to parse, resetting', { err: String(err) });
    return [];
  }
}

function saveAll(sessionId: string, telegramId: string, restores: PendingRestore[]): void {
  const p = restorePath(sessionId, telegramId);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(restores, null, 2), 'utf8');
}

export function addPendingRestore(
  sessionId: string,
  telegramId: string,
  entry: Omit<PendingRestore, 'addedAt'>
): void {
  const restores = loadAll(sessionId, telegramId);
  // Avoid duplicates by id
  if (restores.some((r) => r.id === entry.id)) return;
  restores.push({ ...entry, addedAt: new Date().toISOString() });
  saveAll(sessionId, telegramId, restores);
}

export function removePendingRestore(
  sessionId: string,
  telegramId: string,
  id: string
): void {
  const restores = loadAll(sessionId, telegramId).filter((r) => r.id !== id);
  saveAll(sessionId, telegramId, restores);
}

export function loadPendingRestores(
  sessionId: string,
  telegramId: string
): PendingRestore[] {
  return loadAll(sessionId, telegramId);
}
