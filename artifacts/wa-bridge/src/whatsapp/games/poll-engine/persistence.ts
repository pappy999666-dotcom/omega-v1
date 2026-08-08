// ============================================================
// Poll Game Engine — Persistence
//
// Active games are snapshotted into the session directory so a bot
// restart can recover them (timers are re-armed by the engine on
// restore). Snapshots contain JSON-safe state only — the decryption
// secrets are restored through the poll-votes secret registry.
// ============================================================

import fs from 'fs';
import path from 'path';
import type { PollGameSnapshot } from './types.js';
import { sessionDir } from '../../../services/workspace.js';
import { logger } from '../../../utils/logger.js';

function gamesFilePath(telegramId: string, sessionId: string): string {
  return path.join(sessionDir(telegramId, sessionId), 'poll-games.json');
}

function scopeKey(snapshot: PollGameSnapshot): string {
  return `${snapshot.scope.sessionId}:${snapshot.scope.chatJid}:${snapshot.type}`;
}

function loadFile(telegramId: string, sessionId: string): Record<string, PollGameSnapshot> {
  try {
    const p = gamesFilePath(telegramId, sessionId);
    if (!fs.existsSync(p)) return {};
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, PollGameSnapshot>;
    return parsed ?? {};
  } catch (err) {
    logger.warn('[PollGame] snapshot read failed', { sessionId, err: String(err) });
    return {};
  }
}

function writeFile(telegramId: string, sessionId: string, data: Record<string, PollGameSnapshot>): void {
  try {
    const p = gamesFilePath(telegramId, sessionId);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const tmp = `${p}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, p);
  } catch (err) {
    logger.warn('[PollGame] snapshot write failed', { sessionId, err: String(err) });
  }
}

/** Persist one snapshot (active games kept; finished games removed). */
export function savePollGameSnapshot(telegramId: string, sessionId: string, snapshot: PollGameSnapshot): void {
  const data = loadFile(telegramId, sessionId);
  if (snapshot.status === 'finished') {
    delete data[scopeKey(snapshot)];
  } else {
    data[scopeKey(snapshot)] = snapshot;
  }
  writeFile(telegramId, sessionId, data);
}

/** Load every active snapshot for a session (used at boot / session start). */
export function loadPollGameSnapshots(telegramId: string, sessionId: string): PollGameSnapshot[] {
  const data = loadFile(telegramId, sessionId);
  return Object.values(data).filter((s) => s?.status === 'active' && s?.scope?.sessionId === sessionId);
}

/** Remove all persisted game state for a session (purge). */
export function clearPollGameSnapshots(telegramId: string, sessionId: string): void {
  try {
    const p = gamesFilePath(telegramId, sessionId);
    if (fs.existsSync(p)) fs.rmSync(p, { force: true });
  } catch {
    /* non-critical */
  }
}
