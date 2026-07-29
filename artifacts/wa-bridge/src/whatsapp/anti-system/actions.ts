// ============================================================
// Anti System — Action Executor
// Handles: kick, warn, delete for any violation
// ============================================================

import type { BridgeWASocket as WASocket, WebMessageInfo } from '../baileys-types.js';
import { logger } from '../../utils/logger.js';
import { bold, italic, successCard, warningCard } from '../../utils/ascii-art.js';
import { incrementWarn, resetWarn, getWarnCount } from './config.js';
import { renderResponse } from './response.js';
import type { ViolationContext, AntiAction } from './types.js';

// ── Low-level Primitives ──────────────────────────────────

/** Delete a message immediately. Non-throwing. */
export async function deleteMessage(
  socket: WASocket,
  msg: WebMessageInfo
): Promise<void> {
  try {
    const key = msg.key;
    if (!key.remoteJid) return;
    await (socket as unknown as {
      sendMessage(jid: string, content: Record<string, unknown>): Promise<unknown>;
    }).sendMessage(key.remoteJid, { delete: key });
  } catch (err) {
    logger.warn('[AntiSystem] deleteMessage failed', { err: String(err) });
  }
}

/** Kick a participant from a group. Non-throwing. */
export async function kickParticipant(
  socket: WASocket,
  groupJid: string,
  participantJid: string
): Promise<boolean> {
  try {
    await (socket as unknown as {
      groupParticipantsUpdate(jid: string, participants: string[], action: string): Promise<unknown>;
    }).groupParticipantsUpdate(groupJid, [participantJid], 'remove');
    return true;
  } catch (err) {
    logger.warn('[AntiSystem] kickParticipant failed', { err: String(err), participantJid });
    return false;
  }
}

/** Demote a participant. Non-throwing. */
export async function demoteParticipant(
  socket: WASocket,
  groupJid: string,
  participantJid: string
): Promise<boolean> {
  try {
    await (socket as unknown as {
      groupParticipantsUpdate(jid: string, participants: string[], action: string): Promise<unknown>;
    }).groupParticipantsUpdate(groupJid, [participantJid], 'demote');
    return true;
  } catch (err) {
    logger.warn('[AntiSystem] demoteParticipant failed', { err: String(err), participantJid });
    return false;
  }
}

/** Promote a participant. Non-throwing. */
export async function promoteParticipant(
  socket: WASocket,
  groupJid: string,
  participantJid: string
): Promise<boolean> {
  try {
    await (socket as unknown as {
      groupParticipantsUpdate(jid: string, participants: string[], action: string): Promise<unknown>;
    }).groupParticipantsUpdate(groupJid, [participantJid], 'promote');
    return true;
  } catch (err) {
    logger.warn('[AntiSystem] promoteParticipant failed', { err: String(err), participantJid });
    return false;
  }
}

// ── Main Action Dispatcher ────────────────────────────────

/**
 * Execute the configured action for a violation.
 * - Deletes the violating message concurrently in all cases.
 * - Sends a response notification to the group.
 * Returns true if the action was taken (not ignored/exempt).
 */
export async function executeAction(
  socket: WASocket,
  msg: WebMessageInfo,
  ctx: ViolationContext
): Promise<void> {
  const { groupJid, senderJid, senderNumber, moduleKey, moduleName, moduleConfig, sessionId } = ctx;
  const { action, warnThreshold, customMessage } = moduleConfig;

  // Resolve display name / group name for response
  let gcName = groupJid.split('@')[0] ?? 'Group';
  try {
    const meta = await (socket as unknown as {
      groupMetadata(jid: string): Promise<{ subject?: string }>;
    }).groupMetadata(groupJid);
    gcName = meta?.subject ?? gcName;
  } catch { /* non-critical */ }

  // Build response text
  const responseText = await renderResponse(
    customMessage ?? getDefaultMessage(moduleName, action, senderJid),
    {
      senderJid,
      gcName,
      socket,
      groupJid,
    }
  );

  // Always delete the message immediately (concurrent with action)
  const ops: Promise<unknown>[] = [deleteMessage(socket, msg)];

  if (action === 'kick') {
    // Kick + notify concurrently
    ops.push(kickParticipant(socket, groupJid, senderJid));
    ops.push(
      socket.sendMessage(groupJid, {
        text: responseText,
        mentions: [senderJid],
      })
    );
    logger.info(`[AntiSystem] KICK — ${moduleName}`, { sessionId, groupJid, senderNumber });

  } else if (action === 'warn') {
    const count = incrementWarn(sessionId, groupJid, senderNumber, moduleKey);
    const remaining = warnThreshold - count;

    if (count >= warnThreshold) {
      // Threshold reached — kick and reset
      resetWarn(sessionId, groupJid, senderNumber, moduleKey);
      ops.push(kickParticipant(socket, groupJid, senderJid));
      const kickMsg = `⚠️ @${senderNumber} has been kicked after ${warnThreshold} warnings (${moduleName}).`;
      ops.push(socket.sendMessage(groupJid, { text: kickMsg, mentions: [senderJid] }));
      logger.info(`[AntiSystem] WARN→KICK — ${moduleName}`, { sessionId, groupJid, senderNumber, count });
    } else {
      // Still within warn window
      const warnMsg = `${responseText}\n\n${italic(`Warning ${count}/${warnThreshold}. ${remaining} more will result in a kick.`)}`;
      ops.push(socket.sendMessage(groupJid, { text: warnMsg, mentions: [senderJid] }));
      logger.info(`[AntiSystem] WARN ${count}/${warnThreshold} — ${moduleName}`, { sessionId, groupJid, senderNumber });
    }

  } else if (action === 'delete') {
    // Delete only — still notify
    ops.push(
      socket.sendMessage(groupJid, {
        text: responseText,
        mentions: [senderJid],
      })
    );
    logger.info(`[AntiSystem] DELETE — ${moduleName}`, { sessionId, groupJid, senderNumber });
  }

  await Promise.allSettled(ops);
}

// ── Default Messages ──────────────────────────────────────

function getDefaultMessage(moduleName: string, action: AntiAction, senderJid: string): string {
  const num = senderJid.split('@')[0]?.split(':')[0] ?? 'User';
  switch (action) {
    case 'kick':
      return `🚫 @${num} violated *${moduleName}* and has been removed from this group.`;
    case 'warn':
      return `⚠️ @${num} violated *${moduleName}*. Please follow group rules.`;
    case 'delete':
    default:
      return `🗑️ @${num} — Your message was removed. *${moduleName}* is active in this group.`;
  }
}
