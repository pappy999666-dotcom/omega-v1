// ============================================================
// WA-Bridge — Lifecycle Commands
// .join / .leave / .joinall / .leaveall
// ============================================================

import type { BridgeWASocket as WASocket } from '../baileys-types.js';
import type { JobResult } from '../../types/index.js';
import { joinDelay, leaveDelay, exponentialBackoff } from '../../utils/delay.js';
import { logger } from '../../utils/logger.js';
import { isDeadLinkError, isGroupFullError } from '../../utils/error-recovery.js';
import {
  isCircuitOpen,
  recordFailure,
  recordSuccess,
} from '../../services/circuit-breaker.js';
import {
  loadBucket,
  moveToDeadBucket,
  loadSessionMeta,
  updateSessionMeta,
} from '../../services/workspace.js';
import { extractInviteCode } from '../../services/tri-bucket.js';
import { resultBox } from '../../utils/ascii-art.js';
import { humanDuration } from '../../utils/delay.js';
import { hydratedMessage } from '../preview-generator.js';


async function maybeAutoPromote(socket: WASocket, telegramId: string, sessionId: string, groupJid?: string): Promise<void> {
  if (!groupJid?.endsWith('@g.us')) return;
  const meta = loadSessionMeta(telegramId, sessionId);
  const settings = meta?.autoPromote;
  if (!settings?.enabled || !settings.postOnJoin || !settings.message.trim()) return;
  const now = Date.now();
  const intervalMs = Math.max(0, settings.intervalMinutes ?? 0) * 60_000;
  if (settings.lastPostedAt && intervalMs > 0 && now - settings.lastPostedAt < intervalMs) return;
  await socket.sendMessage(groupJid, await hydratedMessage(settings.message));
  updateSessionMeta(telegramId, sessionId, { autoPromote: { ...settings, lastPostedAt: now } });
}

// ── Single Target ─────────────────────────────────────────

/**
 * .join [link|JID] — Join a single WhatsApp group.
 */
export async function cmdJoin(
  socket: WASocket,
  target: string
): Promise<{ success: boolean; jid?: string; title?: string; error?: string }> {
  try {
    if (target.includes('@g.us')) {
      // Direct JID — try to join via accepting invite from group
      await socket.groupAcceptInvite(target);
      return { success: true, jid: target };
    }

    const code = extractInviteCode(target);
    if (!code) {
      return { success: false, error: 'Invalid group link format' };
    }

    // Get group info before joining
    const info = await socket.groupGetInviteInfo(code);
    const jid = await socket.groupAcceptInvite(code);

    return {
      success: true,
      jid: typeof jid === 'string' ? jid : info.id,
      title: info.subject,
    };
  } catch (err) {
    if (isDeadLinkError(err)) {
      return { success: false, error: 'Link revoked or expired' };
    }
    if (isGroupFullError(err)) {
      return { success: false, error: 'Group is full' };
    }
    return { success: false, error: String(err) };
  }
}

/**
 * .leave [link|JID] — Leave a single WhatsApp group.
 */
export async function cmdLeave(
  socket: WASocket,
  target: string
): Promise<{ success: boolean; error?: string }> {
  try {
    let jid = target;

    if (!target.includes('@g.us')) {
      const code = extractInviteCode(target);
      if (!code) {
        return { success: false, error: 'Invalid target format' };
      }
      const info = await socket.groupGetInviteInfo(code);
      jid = info.id;
    }

    await socket.groupLeave(jid);
    return { success: true };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

// ── Bulk Operations ───────────────────────────────────────

/**
 * .joinall — Bulk join all links in the active bucket.
 * Smart throttling to avoid "Rate-Over-Limit" WhatsApp restrictions.
 */
export async function cmdJoinAll(
  socket: WASocket,
  sessionId: string,
  telegramId: string,
  links: string[],
  opts: {
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

  const deadLinks: string[] = [];

  for (let i = 0; i < links.length; i++) {
    const link = links[i]!;

    // Circuit breaker
    if (isCircuitOpen(telegramId, sessionId, 'lifecycle')) {
      result.rateLimited += links.length - i;
      await opts.onProgress?.(
        `🚦 Circuit open — pausing joins. ${links.length - i} links skipped.`
      );
      break;
    }

    try {
      const res = await cmdJoin(socket, link);

      if (res.success) {
        result.success++;
        await maybeAutoPromote(socket, telegramId, sessionId, res.jid);
        recordSuccess(telegramId, sessionId, 'lifecycle');
        result.details.push(`✅ Joined: ${res.title ?? res.jid}`);
      } else {
        if (
          res.error?.includes('revoked') ||
          res.error?.includes('expired') ||
          res.error?.includes('invalid')
        ) {
          result.failed++;
          deadLinks.push(link);
          result.details.push(`💀 Dead: ${link}`);
        } else if (res.error?.includes('full')) {
          result.skipped++;
          result.details.push(`⏭ Full: ${link}`);
        } else {
          result.failed++;
          result.details.push(`❌ Failed: ${link} — ${res.error}`);
        }
      }

      if (i % 5 === 0 && opts.onProgress) {
        await opts.onProgress(
          `🔗 joinall ${i + 1}/${links.length} — ✅${result.success} ❌${result.failed} ⏭${result.skipped}`
        );
      }

      await joinDelay();
    } catch (err) {
      const msg = String(err);

      if (msg.includes('rate') || msg.includes('Rate-over-limit') || msg.includes('429')) {
        result.rateLimited++;
        const tripped = recordFailure(telegramId, sessionId, 'lifecycle');

        if (tripped) {
          await opts.onProgress?.(`🚦 Rate limit — pausing joinall`);
          break;
        }

        await exponentialBackoff(result.rateLimited, 10_000, 300_000);
      } else {
        result.failed++;
        result.details.push(`❌ Error on ${link}: ${msg.slice(0, 50)}`);
      }
    }
  }

  // Auto-move dead links to dead bucket
  if (deadLinks.length > 0) {
    const deadEntries = loadBucket(telegramId, 'main').filter((e) =>
      deadLinks.includes(e.link)
    );
    if (deadEntries.length > 0) {
      moveToDeadBucket(telegramId, deadEntries);
    }
  }

  result.duration = Date.now() - start;

  await opts.onProgress?.(
    resultBox({
      op: 'JOINALL',
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
 * .leaveall — Leave all currently joined groups.
 */
export async function cmdLeaveAll(
  socket: WASocket,
  sessionId: string,
  telegramId: string,
  opts: {
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

  let groups: { id: string; subject: string }[] = [];

  try {
    const all = await socket.groupFetchAllParticipating();
    groups = Object.values(all).map((g) => ({ id: g.id, subject: g.subject }));
  } catch (err) {
    result.details.push(`Failed to fetch groups: ${err}`);
    result.duration = Date.now() - start;
    return result;
  }

  await opts.onProgress?.(`🚪 Leaving ${groups.length} groups…`);

  for (let i = 0; i < groups.length; i++) {
    const group = groups[i]!;

    try {
      await socket.groupLeave(group.id);
      result.success++;
      result.details.push(`✅ Left: ${group.subject}`);
      recordSuccess(telegramId, sessionId, 'lifecycle');
    } catch (err) {
      const msg = String(err);
      if (msg.includes('rate') || msg.includes('429')) {
        result.rateLimited++;
        const tripped = recordFailure(telegramId, sessionId, 'lifecycle');
        if (tripped) break;
        await exponentialBackoff(result.rateLimited, 5000, 60_000);
      } else {
        result.failed++;
        result.details.push(`❌ ${group.subject}: ${msg.slice(0, 40)}`);
      }
    }

    if (i % 5 === 0 && opts.onProgress) {
      await opts.onProgress(
        `🚪 leaveall ${i + 1}/${groups.length} — ✅${result.success} ❌${result.failed}`
      );
    }

    await leaveDelay();
  }

  result.duration = Date.now() - start;
  await opts.onProgress?.(
    resultBox({
      op: 'LEAVEALL',
      success: result.success,
      failed: result.failed,
      skipped: result.skipped,
      rateLimited: result.rateLimited,
      duration: humanDuration(result.duration),
    })
  );

  return result;
}

// ── JID Resolver (for /jid Telegram command) ──────────────

export async function resolveGroupJid(
  socket: WASocket,
  linkOrCode: string
): Promise<{ jid: string; title: string; members: number } | null> {
  try {
    const code = extractInviteCode(linkOrCode) ?? linkOrCode;
    const info = await socket.groupGetInviteInfo(code);
    return {
      jid: info.id,
      title: info.subject ?? 'Unknown group',
      members: info.size ?? 0,
    };
  } catch {
    return null;
  }
}
