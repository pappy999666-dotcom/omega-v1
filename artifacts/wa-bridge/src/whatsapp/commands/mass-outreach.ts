// ============================================================
// WA-Bridge — Mass Outreach Commands
// .allstatus / .allchat — with exponential backoff & jitter
// ============================================================

import type { WASocket, AnyMessageContent } from '@whiskeysockets/baileys';
import type { JobResult } from '../../types/index.js';
import { allstatusDelay, exponentialBackoff } from '../../utils/delay.js';
import { logger } from '../../utils/logger.js';
import { hydratedMessage } from '../preview-generator.js';
import { isFrozen } from '../socket-manager.js';
import {
  isCircuitOpen,
  recordFailure,
  recordSuccess,
} from '../../services/circuit-breaker.js';
import { resultBox } from '../../utils/ascii-art.js';
import { humanDuration } from '../../utils/delay.js';

// Track active allstatus/allchat runs
const activeRuns = new Map<string, boolean>();

export function stopOutreach(sessionId: string): void {
  activeRuns.set(sessionId, false);
}

export function isOutreachRunning(sessionId: string): boolean {
  return activeRuns.get(sessionId) === true;
}

// ── Fetch All Joined Groups ───────────────────────────────

async function getJoinedGroups(
  socket: WASocket
): Promise<{ id: string; subject: string }[]> {
  try {
    const groups = await socket.groupFetchAllParticipating();
    return Object.values(groups).map((g) => ({ id: g.id, subject: g.subject }));
  } catch (err) {
    logger.error('[Outreach] Failed to fetch groups', { err: String(err) });
    return [];
  }
}

// ── .allstatus ─────────────────────────────────────────────

/**
 * Post to the WhatsApp STATUS of every joined group sequentially.
 * Uses exponential backoff + jitter between posts.
 */
export async function cmdAllStatus(
  socket: WASocket,
  sessionId: string,
  telegramId: string,
  text: string,
  opts: {
    mediaBuffer?: Buffer;
    mediaType?: string;
    caption?: string;
    onProgress?: (msg: string) => Promise<void>;
  } = {}
): Promise<JobResult> {
  const start = Date.now();
  const result: JobResult = {
    success: 0,
    failed: 0,
    skipped: 0,
    rateLimited: 0,
    details: [],
    duration: 0,
  };

  if (isFrozen(sessionId)) {
    result.details.push('Session frozen — aborted');
    result.duration = Date.now() - start;
    return result;
  }

  activeRuns.set(sessionId, true);

  const groups = await getJoinedGroups(socket);
  await opts.onProgress?.(
    `📡 Starting allstatus for ${groups.length} groups…`
  );

  let consecutiveFailures = 0;

  for (let i = 0; i < groups.length; i++) {
    const group = groups[i]!;

    // Check kill switch
    if (!activeRuns.get(sessionId)) {
      result.details.push(`⛔ Stopped at ${i}/${groups.length}`);
      break;
    }

    // Circuit breaker check
    if (isCircuitOpen(telegramId, sessionId, 'allstatus')) {
      result.rateLimited++;
      result.details.push(`🚦 Circuit open — ${groups.length - i} groups skipped`);
      break;
    }

    // Frozen check
    if (isFrozen(sessionId)) {
      result.skipped += groups.length - i;
      result.details.push(`❄️ Frozen at ${i}/${groups.length}`);
      break;
    }

    try {
      const content = buildContent(text, opts);

      // Post to group status channel
      await socket.sendMessage('status@broadcast', content, {
        statusJidList: [group.id],
      });

      result.success++;
      consecutiveFailures = 0;
      recordSuccess(telegramId, sessionId, 'allstatus');
      result.details.push(`✅ ${group.subject}`);

      // Progress update every 10 groups
      if (i % 10 === 0 && opts.onProgress) {
        await opts.onProgress(
          `📡 allstatus ${i + 1}/${groups.length} — ✅${result.success} ❌${result.failed}`
        );
      }

      // Jittered delay between sends
      await allstatusDelay();
    } catch (err) {
      const msg = String(err);
      consecutiveFailures++;

      if (msg.includes('rate') || msg.includes('429') || msg.includes('spam')) {
        result.rateLimited++;
        const tripped = recordFailure(telegramId, sessionId, 'allstatus');
        result.details.push(`🚦 Rate limited on ${group.subject}`);

        if (tripped) {
          await opts.onProgress?.(
            `🚦 Rate limit circuit tripped — pausing for 1h`
          );
          break;
        }

        // Exponential backoff on rate errors
        await exponentialBackoff(consecutiveFailures, 5000, 120_000);
      } else {
        result.failed++;
        result.details.push(`❌ ${group.subject}: ${msg.slice(0, 50)}`);
        if (consecutiveFailures >= 5) {
          await exponentialBackoff(consecutiveFailures, 2000, 30_000);
        }
      }
    }
  }

  activeRuns.delete(sessionId);
  result.duration = Date.now() - start;

  // Send final WA summary back to the triggering chat
  await opts.onProgress?.(
    resultBox({
      op: 'ALLSTATUS',
      success: result.success,
      failed: result.failed,
      skipped: result.skipped,
      rateLimited: result.rateLimited,
      duration: humanDuration(result.duration),
    })
  );

  return result;
}

// ── .allchat ──────────────────────────────────────────────

/**
 * Blast a hidetag (@all invisible mention) message to all groups.
 * Uses the same circuit breaker + jitter system.
 */
export async function cmdAllChat(
  socket: WASocket,
  sessionId: string,
  telegramId: string,
  text: string,
  opts: {
    mediaBuffer?: Buffer;
    mediaType?: string;
    onProgress?: (msg: string) => Promise<void>;
  } = {}
): Promise<JobResult> {
  const start = Date.now();
  const result: JobResult = {
    success: 0,
    failed: 0,
    skipped: 0,
    rateLimited: 0,
    details: [],
    duration: 0,
  };

  if (isFrozen(sessionId)) {
    result.duration = Date.now() - start;
    return result;
  }

  activeRuns.set(sessionId, true);

  const groups = await getJoinedGroups(socket);
  await opts.onProgress?.(
    `📣 Starting allchat for ${groups.length} groups…`
  );

  for (let i = 0; i < groups.length; i++) {
    const group = groups[i]!;

    if (!activeRuns.get(sessionId)) break;
    if (isCircuitOpen(telegramId, sessionId, 'allchat')) {
      result.rateLimited += groups.length - i;
      break;
    }

    try {
      // Build hidetag: @all invisible mention
      const participants = await getGroupParticipants(socket, group.id);
      const mentions = participants.map((p) => p.id);

      const content: AnyMessageContent = opts.mediaBuffer
        ? {
            image: opts.mediaBuffer,
            caption: text,
            mentions,
          }
        : {
            text,
            mentions,
          };

      await socket.sendMessage(group.id, content);
      result.success++;
      recordSuccess(telegramId, sessionId, 'allchat');

      if (i % 10 === 0 && opts.onProgress) {
        await opts.onProgress(
          `📣 allchat ${i + 1}/${groups.length} — ✅${result.success} ❌${result.failed}`
        );
      }

      await allstatusDelay();
    } catch (err) {
      const msg = String(err);
      if (msg.includes('rate') || msg.includes('429')) {
        result.rateLimited++;
        const tripped = recordFailure(telegramId, sessionId, 'allchat');
        if (tripped) break;
        await exponentialBackoff(result.rateLimited, 5000, 120_000);
      } else {
        result.failed++;
      }
    }
  }

  activeRuns.delete(sessionId);
  result.duration = Date.now() - start;

  await opts.onProgress?.(
    resultBox({
      op: 'ALLCHAT',
      success: result.success,
      failed: result.failed,
      skipped: result.skipped,
      rateLimited: result.rateLimited,
      duration: humanDuration(result.duration),
    })
  );

  return result;
}

// ── Helpers ───────────────────────────────────────────────

async function getGroupParticipants(
  socket: WASocket,
  groupJid: string
): Promise<{ id: string }[]> {
  try {
    const meta = await socket.groupMetadata(groupJid);
    return meta.participants;
  } catch {
    return [];
  }
}

function buildContent(
  text: string,
  opts: { mediaBuffer?: Buffer; mediaType?: string; caption?: string }
): AnyMessageContent {
  if (opts.mediaBuffer) {
    if (opts.mediaType === 'video') {
      return { video: opts.mediaBuffer, caption: opts.caption ?? text };
    }
    if (opts.mediaType === 'audio') {
      return { audio: opts.mediaBuffer, mimetype: 'audio/mp4' };
    }
    return { image: opts.mediaBuffer, caption: opts.caption ?? text };
  }
  return { text };
}
