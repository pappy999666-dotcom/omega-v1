// ============================================================
// Anti System — Action Executor
// Handles: kick, warn, delete for any violation
// ============================================================

import type { BridgeWASocket as WASocket, WebMessageInfo } from '../baileys-types.js';
import { logger } from '../../utils/logger.js';
import { PreviewManager } from '../../preview-engine/index.js';
import { bold, italic, successCard, warningCard } from '../../utils/ascii-art.js';
import { incrementWarn, resetWarn, getWarnCount } from './config.js';
import { renderResponse } from './response.js';
import type { ViolationContext, AntiAction } from './types.js';
import { resolveMention } from '../utils/mention-engine.js';

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
  const { groupJid, senderJid, senderNumber, moduleKey, moduleName, moduleConfig, sessionId, telegramId } = ctx;
  const { action, warnThreshold, customMessage } = moduleConfig;

  // Resolve group name + participant list (participants enable LID → phone
  // resolution in the Central Mention Engine below).
  let gcName = groupJid.split('@')[0] ?? 'Group';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let groupParticipants: { id: string; phoneNumber?: string }[] | null = null;
  try {
    const meta = await (socket as unknown as {
      groupMetadata(jid: string): Promise<{ subject?: string; participants?: { id: string; phoneNumber?: string }[] }>;
    }).groupMetadata(groupJid);
    gcName = meta?.subject ?? gcName;
    groupParticipants = meta?.participants ?? null;
  } catch { /* non-critical */ }

  // ── Central Mention Engine ────────────────────────────────
  // The mention token (@<phone>) and the mentionedJid array are built from
  // ONE resolved identity — never "@" + digits assembled by hand. LID senders
  // are mapped to their real phone JID; when unresolvable, no token is emitted
  // and no LID digits can leak into the response.
  const mention = await resolveMention(socket, {
    jid: senderJid,
    participants: groupParticipants,
  });
  const mentionList = mention.jid ? [mention.jid] : undefined;
  const renderCtx = {
    senderJid: mention.jid || senderJid,
    mentionNumber: mention.number,
    gcName,
    socket,
    groupJid,
  };

  // Build response text
  const responseText = await renderResponse(
    customMessage ?? getDefaultMessage(moduleName, action),
    renderCtx
  );

  // Always delete the message immediately (concurrent with action)
  const ops: Promise<unknown>[] = [deleteMessage(socket, msg)];

  if (action === 'kick') {
    // Kick + notify concurrently
    ops.push(kickParticipant(socket, groupJid, senderJid));
    ops.push(
      PreviewManager.send(socket as any, groupJid, responseText, {
        ...(mentionList ? { extra: { mentions: mentionList } } : {}),
        forceMentions: true,
        sessionId,
        telegramId,
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
      const kickMsg = await renderResponse(
        `⚠️ @mention has been kicked after ${warnThreshold} warnings (${moduleName}).`,
        renderCtx
      );
      ops.push(
        PreviewManager.send(socket as any, groupJid, kickMsg, {
          ...(mentionList ? { extra: { mentions: mentionList } } : {}),
          forceMentions: true,
          sessionId,
          telegramId,
        })
      );
      logger.info(`[AntiSystem] WARN→KICK — ${moduleName}`, { sessionId, groupJid, senderNumber, count });
    } else {
      // Still within warn window
      const warnMsg = `${responseText}\n\n${italic(`Warning ${count}/${warnThreshold}. ${remaining} more will result in a kick.`)}`;
      ops.push(
        PreviewManager.send(socket as any, groupJid, warnMsg, {
          ...(mentionList ? { extra: { mentions: mentionList } } : {}),
          forceMentions: true,
          sessionId,
          telegramId,
        })
      );
      logger.info(`[AntiSystem] WARN ${count}/${warnThreshold} — ${moduleName}`, { sessionId, groupJid, senderNumber });
    }

  } else if (action === 'delete') {
    // Delete only — still notify
    ops.push(
      PreviewManager.send(socket as any, groupJid, responseText, {
        ...(mentionList ? { extra: { mentions: mentionList } } : {}),
        forceMentions: true,
        sessionId,
        telegramId,
      })
    );
    logger.info(`[AntiSystem] DELETE — ${moduleName}`, { sessionId, groupJid, senderNumber });
  }

  await Promise.allSettled(ops);
}

// ── Default Messages ──────────────────────────────────────
// Built with the @mention template token — the Mention Engine (via
// renderResponse) substitutes the real phone token, so the text and the
// mentionedJid array can never disagree.

function getDefaultMessage(moduleName: string, action: AntiAction): string {
  switch (action) {
    case 'kick':
      return `🚫 @mention violated *${moduleName}* and has been removed from this group.`;
    case 'warn':
      return `⚠️ @mention violated *${moduleName}*. Please follow group rules.`;
    case 'delete':
    default:
      return `🗑️ @mention — Your message was removed. *${moduleName}* is active in this group.`;
  }
}
