// ============================================================
// WA-Bridge — Mass Outreach Commands
// .allstatus / .allchat — with exponential backoff & jitter
//
// ALL preview operations now flow through the centralized
// PreviewManager — the single source of truth.
// ============================================================

import type { BridgeWASocket as WASocket, AnyMessageContent, IMessage } from '../baileys-types.js';
import type { JobResult } from '../../types/index.js';
import { PreviewManager } from '../../preview-engine/index.js';
import { sendAsIs } from '../chat-as-is.js';
import { allstatusDelay, exponentialBackoff } from '../../utils/delay.js';
import { logger } from '../../utils/logger.js';
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
    existingPreview?: PartialLinkMeta;
    sourceExt?: NonNullable<IMessage['extendedTextMessage']>;
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

  // ── Route decided ONCE before the loop ─────────────────
  const sourceExt = opts.sourceExt;
  let resolvedPreview: PartialLinkMeta | undefined = opts.existingPreview;
  const rawUrl = text.match(/https?:\/\/[^\s]+/u)?.[0];

  if (!sourceExt && !resolvedPreview && rawUrl) {
    resolvedPreview = await PreviewManager.resolvePreviewOnce(rawUrl, socket as never);
  }

  await opts.onProgress?.(`📣 Starting allchat for ${groups.length} groups…`);

  for (let i = 0; i < groups.length; i++) {
    const group = groups[i]!;

    if (!activeRuns.get(sessionId)) break;
    if (isCircuitOpen(telegramId, sessionId, 'allchat')) {
      result.rateLimited++;
      result.details.push(`🚦 Circuit open — backing off before ${group.subject}`);
      await opts.onProgress?.(`🚦 allchat backoff before ${i + 1}/${groups.length}; queue preserved.`);
      await exponentialBackoff(Math.max(result.rateLimited, 1), 30_000, 300_000);
    }

    try {
      const participants = await getGroupParticipants(socket, group.id);
      const mentions = participants.map((p) => p.id);

      if (opts.mediaBuffer) {
        const content = buildContent(text, {
          mediaBuffer: opts.mediaBuffer,
          mediaType: opts.mediaType,
        });
        await socket.sendMessage(group.id, { ...content, mentions });
      } else if (sourceExt) {
        // AS_IS — relay quoted/own WA-built preview verbatim
        const sent = await sendAsIs(socket, group.id, text, sourceExt, { mentions });
        if (!sent) {
          // fallback to RICH via PreviewManager.send
          await PreviewManager.send(socket as any, group.id, text, {
            existingPreview: resolvedPreview,
            extra: { mentions },
          });
        }
      } else {
        await PreviewManager.send(socket as any, group.id, text, {
          existingPreview: resolvedPreview,
          extra: { mentions },
        });
      }
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
        recordFailure(telegramId, sessionId, 'allchat');
        await exponentialBackoff(result.rateLimited, 5000, 120_000);
      } else {
        result.failed++;
        result.details.push(`❌ ${group.subject}: ${msg.slice(0, 50)}`);
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
