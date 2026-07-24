// ============================================================
// WA-Bridge — Mass Outreach Commands
// .allstatus / .allchat — with exponential backoff & jitter
// ============================================================

import type { BridgeWASocket as WASocket, AnyMessageContent } from '../baileys-types.js';
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
import { loadSessionConfig } from '../../services/workspace.js';
import { statusDesignEngine, type StatusTheme } from '../../services/StatusDesignEngine.js';
import { gcDesignAllocator } from '../../services/GCDesignAllocator.js';
import { sendGroupStatus } from '../groupStatus.js';

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
  const config = loadSessionConfig(telegramId, sessionId);
  const stickyThemes = Object.fromEntries(
    Object.entries(config.statusDesignStickyThemes ?? {}).filter((entry): entry is [string, StatusTheme] =>
      statusDesignEngine.themes.includes(entry[1] as StatusTheme)
    )
  );
  const campaign = gcDesignAllocator.createCampaign(groups.map((group) => group.id), stickyThemes);
  const rawUrl = text.match(/https?:\/\/[^\s]+/u)?.[0];
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

    // Circuit breaker check: slow down instead of abandoning the campaign.
    if (isCircuitOpen(telegramId, sessionId, 'allstatus')) {
      result.rateLimited++;
      result.details.push(`🚦 Circuit open — backing off before ${group.subject}`);
      await opts.onProgress?.(`🚦 allstatus backoff before ${i + 1}/${groups.length}; queue preserved.`);
      await exponentialBackoff(Math.max(consecutiveFailures, 1), 30_000, 300_000);
    }

    // Frozen check
    if (isFrozen(sessionId)) {
      result.skipped += groups.length - i;
      result.details.push(`❄️ Frozen at ${i}/${groups.length}`);
      break;
    }

    let posted = false;
    let lastError = '';
    for (let attempt = 1; attempt <= 5 && !posted; attempt += 1) {
      try {
        const designedText = config.statusDesignEnabled !== false && rawUrl && !opts.mediaBuffer
          ? statusDesignEngine.render({
              theme: campaign.themeFor(group.id),
              url: rawUrl,
              message: text.replace(rawUrl, '').trim() || undefined,
            }).text
          : text;

        await sendGroupStatus(socket, sessionId, group.id, designedText, {
          mediaBuffer: opts.mediaBuffer,
          mediaType: opts.mediaType as 'image' | 'video' | 'audio' | undefined,
          caption: opts.caption ?? designedText,
        });
        posted = true;
      } catch (err) {
        lastError = String(err);
        consecutiveFailures++;
        if (/rate|429|spam/i.test(lastError)) {
          result.rateLimited++;
          recordFailure(telegramId, sessionId, 'allstatus');
          await opts.onProgress?.(`🚦 allstatus retry ${attempt}/5 for ${group.subject}`);
          await exponentialBackoff(attempt, 5000, 120_000);
        } else if (/not-authorized|forbidden|not in group|bad request|404/i.test(lastError)) {
          result.skipped++;
          result.details.push(`⏭️ ${group.subject}: ${lastError.slice(0, 50)}`);
          break;
        } else {
          await exponentialBackoff(attempt, 2000, 30_000);
        }
      }
    }

    if (posted) {
      result.success++;
      consecutiveFailures = 0;
      recordSuccess(telegramId, sessionId, 'allstatus');
      result.details.push(`✅ ${group.subject}`);
    } else if (!result.details.at(-1)?.includes(group.subject)) {
      result.failed++;
      result.details.push(`❌ ${group.subject}: ${lastError.slice(0, 50)}`);
    }

    if (i % 10 === 0 && opts.onProgress) {
      await opts.onProgress(
        `📡 allstatus ${i + 1}/${groups.length} — ✅${result.success} ❌${result.failed} ⏭️${result.skipped} 🚦${result.rateLimited}`
      );
    }
    await allstatusDelay();
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
