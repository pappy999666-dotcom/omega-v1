// ============================================================
// WA-Bridge — All Status Command
// Posts to the status ring of every joined group.
//
// Preview routing mirrors verbose godcast PATH 0 / PATH B:
//
//   PATH 0  AS_IS  — source msg has WA-built extendedTextMessage
//                    (link preview OR styled text). Resolved ONCE
//                    before the loop. Every group gets likeThis relay.
//
//   PATH B  RICH   — URL found, no WA preview. resolvedPreview
//                    fetched ONCE. Every group gets HQ build path.
//
//   PATH C  PLAIN  — no URL, no preview. Plain text status.
// ============================================================

import type { BridgeWASocket as WASocket, IMessage } from '../baileys-types.js';
import type { JobResult } from '../../types/index.js';
import type { PartialLinkMeta } from '../../preview-engine/types.js';
import { PreviewManager } from '../../preview-engine/index.js';
import { sendStatusAsIs } from '../status-as-is.js';
import { sendGroupStatus } from '../groupStatus.js';
import { allstatusDelay, exponentialBackoff } from '../../utils/delay.js';
import { logger } from '../../utils/logger.js';
import { isFrozen } from '../socket-manager.js';
import { isCircuitOpen, recordFailure, recordSuccess } from '../../services/circuit-breaker.js';
import { resultBox } from '../../utils/ascii-art.js';
import { humanDuration } from '../../utils/delay.js';
import { loadSessionConfig } from '../../services/workspace.js';
import { statusDesignEngine, type StatusTheme } from '../../services/StatusDesignEngine.js';
import { gcDesignAllocator } from '../../services/GCDesignAllocator.js';
import { generateStatusCard } from '../../services/status-card-pipeline.js';

const activeRuns = new Map<string, boolean>();

export function stopAllStatus(sessionId: string): void {
  activeRuns.set(sessionId, false);
}

export function isAllStatusRunning(sessionId: string): boolean {
  return activeRuns.get(sessionId) === true;
}

async function getJoinedGroups(socket: WASocket): Promise<{ id: string; subject: string }[]> {
  try {
    const groups = await socket.groupFetchAllParticipating();
    return Object.values(groups).map((g) => ({ id: g.id, subject: g.subject }));
  } catch (err) {
    logger.error('[AllStatus] Failed to fetch groups', { err: String(err) });
    return [];
  }
}

export async function cmdAllStatus(
  socket: WASocket,
  sessionId: string,
  telegramId: string,
  text: string,
  opts: {
    mediaBuffer?: Buffer;
    mediaType?: string;
    caption?: string;
    mimeType?: string;
    ptt?: boolean;
    onProgress?: (msg: string) => Promise<void>;
    existingPreview?: PartialLinkMeta;
    sourceExt?: NonNullable<IMessage['extendedTextMessage']>;
  } = {}
): Promise<JobResult> {
  const start = Date.now();
  const result: JobResult = { success: 0, failed: 0, skipped: 0, rateLimited: 0, details: [], duration: 0 };

  if (isFrozen(sessionId)) {
    result.details.push('Session frozen — aborted');
    result.duration = Date.now() - start;
    return result;
  }

  activeRuns.set(sessionId, true);

  const groups = await getJoinedGroups(socket);
  const config = loadSessionConfig(telegramId, sessionId);
  const stickyThemes = Object.fromEntries(
    Object.entries(config.statusDesignStickyThemes ?? {}).filter(
      (entry): entry is [string, StatusTheme] => statusDesignEngine.themes.includes(entry[1] as StatusTheme)
    )
  );
  const campaign = gcDesignAllocator.createCampaign(groups.map((g) => g.id), stickyThemes);
  const rawUrl = text.match(/https?:\/\/[^\s]+/u)?.[0];

  // ── Route decided ONCE before the loop ─────────────────
  const sourceExt = opts.sourceExt;
  let resolvedPreview: PartialLinkMeta | undefined = opts.existingPreview;
  if (!sourceExt && !resolvedPreview && rawUrl) {
    resolvedPreview = await PreviewManager.resolvePreviewOnce(rawUrl, socket as never);
  }

  await opts.onProgress?.(`📡 Starting allstatus for ${groups.length} groups…`);

  let consecutiveFailures = 0;

  for (let i = 0; i < groups.length; i++) {
    const group = groups[i]!;

    if (!activeRuns.get(sessionId)) {
      result.details.push(`⛔ Stopped at ${i}/${groups.length}`);
      break;
    }

    if (isCircuitOpen(telegramId, sessionId, 'allstatus')) {
      result.rateLimited++;
      result.details.push(`🚦 Circuit open — backing off before ${group.subject}`);
      await opts.onProgress?.(`🚦 allstatus backoff before ${i + 1}/${groups.length}; queue preserved.`);
      await exponentialBackoff(Math.max(consecutiveFailures, 1), 30_000, 300_000);
    }

    if (isFrozen(sessionId)) {
      result.skipped += groups.length - i;
      result.details.push(`❄️ Frozen at ${i}/${groups.length}`);
      break;
    }

    let posted = false;
    let lastError = '';

    for (let attempt = 1; attempt <= 5 && !posted; attempt++) {
      try {
        // ── Media path — same for all routes ──────────────
        if (opts.mediaBuffer) {
          await sendGroupStatus(socket, sessionId, group.id, text, {
            mediaBuffer: opts.mediaBuffer,
            mediaType: opts.mediaType as 'image' | 'video' | 'audio' | undefined,
            caption: opts.caption ?? text,
            mimeType: opts.mimeType,
            ptt: opts.ptt,
          });
          posted = true;
          break;
        }

        // ── PATH 0: AS_IS — relay WA-built preview verbatim ─
        // Do NOT apply the design engine here — the source message already has a
        // WA-generated preview. Wrapping with the design engine changes the text,
        // which can misalign the matchedText byte offsets and corrupt the preview.
        if (sourceExt) {
          const sent = await sendStatusAsIs(socket, group.id, text, sourceExt);
          if (sent) { posted = true; break; }
          // likeThis failed — fall through to RICH with design
          logger.warn('[AllStatus] AS_IS fallback to RICH', { groupJid: group.id });
        }

        // ── Design engine — only for RICH / PLAIN paths ───
        // Pass resolvedPreview so WA invite links use the socket-fetched group name
        // instead of the generic "Community" hostname fallback.
        const designedText =
          config.statusDesignEnabled !== false && rawUrl
            ? await generateStatusCard(text, campaign.themeFor(group.id), resolvedPreview)
            : text;

        // ── PATH B / C: RICH or PLAIN via sendGroupStatus ─
        await sendGroupStatus(socket, sessionId, group.id, designedText, {
          existingPreview: resolvedPreview,
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

/**
 * allgstatus — posts raw text + link to every group status.
 * No StatusDesignEngine, no theme wrapping. The text is sent exactly as-is
 * so the user controls the full format. Link preview is preserved naturally.
 */
export async function cmdAllGStatus(
  socket: WASocket,
  sessionId: string,
  telegramId: string,
  text: string,
  opts: {
    onProgress?: (msg: string) => Promise<void>;
    existingPreview?: PartialLinkMeta;
    sourceExt?: NonNullable<IMessage['extendedTextMessage']>;
  } = {}
): Promise<JobResult> {
  const start = Date.now();
  const result: JobResult = { success: 0, failed: 0, skipped: 0, rateLimited: 0, details: [], duration: 0 };

  if (isFrozen(sessionId)) {
    result.details.push('Session frozen — aborted');
    result.duration = Date.now() - start;
    return result;
  }

  activeRuns.set(sessionId, true);
  const groups = await getJoinedGroups(socket);

  // Resolve preview once — no design engine involved
  const rawUrl = text.match(/https?:\/\/[^\s]+/u)?.[0];
  let resolvedPreview: PartialLinkMeta | undefined = opts.existingPreview;
  if (!opts.sourceExt && !resolvedPreview && rawUrl) {
    resolvedPreview = await PreviewManager.resolvePreviewOnce(rawUrl, socket as never);
  }

  await opts.onProgress?.(`📡 Starting allgstatus for ${groups.length} groups…`);

  for (let i = 0; i < groups.length; i++) {
    const group = groups[i]!;

    if (!activeRuns.get(sessionId)) {
      result.details.push(`⛔ Stopped at ${i}/${groups.length}`);
      break;
    }

    if (isFrozen(sessionId)) { result.skipped += groups.length - i; break; }

    let posted = false;
    let lastError = '';

    for (let attempt = 1; attempt <= 3 && !posted; attempt++) {
      try {
        if (opts.sourceExt) {
          const sent = await sendStatusAsIs(socket, group.id, text, opts.sourceExt);
          if (sent) { posted = true; break; }
        }
        // Send raw — no design wrapping
        await sendGroupStatus(socket, sessionId, group.id, text, { existingPreview: resolvedPreview });
        posted = true;
      } catch (err) {
        lastError = String(err);
        if (/rate|429|spam/i.test(lastError)) {
          result.rateLimited++;
          recordFailure(telegramId, sessionId, 'allstatus');
          await exponentialBackoff(attempt, 5000, 60_000);
        } else if (/not-authorized|forbidden|not in group|404/i.test(lastError)) {
          result.skipped++;
          break;
        } else {
          await exponentialBackoff(attempt, 2000, 15_000);
        }
      }
    }

    if (posted) {
      result.success++;
      recordSuccess(telegramId, sessionId, 'allstatus');
    } else if (!result.details.at(-1)?.includes(group.subject)) {
      result.failed++;
      result.details.push(`❌ ${group.subject}: ${lastError.slice(0, 50)}`);
    }

    if (i % 10 === 0 && opts.onProgress) {
      await opts.onProgress(`📡 allgstatus ${i + 1}/${groups.length} — ✅${result.success} ❌${result.failed}`);
    }

    await allstatusDelay();
  }

  activeRuns.delete(sessionId);
  result.duration = Date.now() - start;
  return result;
}
