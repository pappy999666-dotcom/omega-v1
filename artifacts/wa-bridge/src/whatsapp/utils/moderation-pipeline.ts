// ============================================================
// WA-Bridge — Shared Moderation Pipeline
// Single source of truth for kick/ban permission, resolution,
// validation, participant updates, retries, and logging.
// ============================================================

import type { BridgeWASocket as WASocket, WebMessageInfo } from '../baileys-types.js';
import { logger } from '../../utils/logger.js';
import { errorCard, warningCard } from '../../utils/ascii-art.js';
import { renderTemplate } from '../../utils/response-engine.js';
import { resolveTarget } from './resolve-target.js';
import { BOT_NOT_ADMIN_MSG, fetchGroupMeta, isAdminJid, numericId, stripDeviceSuffix, type GroupParticipant } from './group-permissions.js';

export type ModerationAction = 'kick' | 'ban';

interface ModerationPipelineOptions {
  action: ModerationAction;
  args: string[];
  msg: WebMessageInfo;
  socket: WASocket;
  groupJid: string;
  prefix: string;
  template?: string;
  onSuccess?: (targetNumber: string) => void;
}

export interface ModerationPipelineSuccess {
  ok: true;
  targetJid: string;
  targetNumber: string;
  groupName: string;
  reply: string;
}

export interface ModerationPipelineFailure {
  ok: false;
  reply: string;
}

export type ModerationPipelineResult = ModerationPipelineSuccess | ModerationPipelineFailure;

function title(action: ModerationAction): string {
  return action === 'ban' ? 'Ban' : 'Kick';
}

function findParticipant(participants: GroupParticipant[], jid: string, number: string): GroupParticipant | null {
  const targetNum = number || numericId(jid);
  return participants.find((p) => {
    const pNum = numericId(p.id);
    const pPhone = (p.phoneNumber ?? '').replace(/\D/g, '');
    return stripDeviceSuffix(p.id) === stripDeviceSuffix(jid) || (!!targetNum && (pNum === targetNum || pPhone === targetNum));
  }) ?? null;
}

function isTransientParticipantError(err: unknown): boolean {
  const text = String(err instanceof Error ? err.message : err).toLowerCase();
  return /timed?\s*out|timeout|rate|too many|temporar|again|unavailable|internal-server-error|500|503|429/.test(text);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function removeParticipantWithRetry(socket: WASocket, groupJid: string, participantJid: string): Promise<void> {
  const sock = socket as unknown as {
    groupParticipantsUpdate(jid: string, participants: string[], action: 'remove'): Promise<unknown>;
  };
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await sock.groupParticipantsUpdate(groupJid, [participantJid], 'remove');
      return;
    } catch (err) {
      lastErr = err;
      logger.warn('[Moderation] participant remove failed', { groupJid, participantJid, attempt, err });
      if (attempt === 3 || !isTransientParticipantError(err)) break;
      await sleep(300 * attempt);
    }
  }
  throw lastErr;
}

export async function runRemoveModerationPipeline(options: ModerationPipelineOptions): Promise<ModerationPipelineResult> {
  const { action, args, msg, socket, groupJid, prefix, template, onSuccess } = options;
  const label = title(action);

  if (!groupJid.endsWith('@g.us')) {
    return { ok: false, reply: errorCard(label, 'This command must be used inside a WhatsApp group.') };
  }

  const meta = await fetchGroupMeta(socket, groupJid, true);
  if (!meta) {
    logger.error('[Moderation] could not fetch group metadata', { action, groupJid });
    return { ok: false, reply: errorCard(label, 'Could not verify group permissions. Please try again.') };
  }
  if (!meta.botIsAdmin) {
    logger.warn('[Moderation] bot is not admin', { action, groupJid, botJid: meta.botJid });
    return { ok: false, reply: errorCard(label, BOT_NOT_ADMIN_MSG) };
  }

  const target = await resolveTarget(args, msg, socket, groupJid, meta);
  if (!target?.participant) {
    logger.warn('[Moderation] target not in group or unresolved', { action, groupJid, args, resolved: target });
    return { ok: false, reply: warningCard(label, `Provide a group member phone number, reply to a message, or @mention someone.\nUsage: ${prefix}${action} @user`) };
  }

  const participant = findParticipant(meta.participants, target.jid, target.number);
  if (!participant) {
    logger.warn('[Moderation] target not present in participants', { action, groupJid, target });
    return { ok: false, reply: warningCard(label, `@${target.number} is not in this group (they may have already left).`) };
  }

  if (isAdminJid(meta.participants, participant.id)) {
    logger.warn('[Moderation] refused to remove admin/owner', { action, groupJid, targetJid: participant.id });
    return { ok: false, reply: warningCard(label, `@${target.number} is a group admin and cannot be ${action === 'ban' ? 'banned' : 'kicked'} directly.\nUse ${prefix}dnkick to demote then remove them.`) };
  }

  const targetJid = stripDeviceSuffix(participant.id);
  try {
    await removeParticipantWithRetry(socket, groupJid, targetJid);
  } catch (err) {
    logger.error('[Moderation] participant remove permanently failed', { action, groupJid, targetJid, targetNumber: target.number, err });
    return { ok: false, reply: errorCard(`${label} Failed`, `Could not ${action === 'ban' ? 'ban' : 'remove'} @${target.number}. Please try again or check my admin permissions.`) };
  }

  onSuccess?.(target.number);
  const defaultText = action === 'ban'
    ? `🔨 @${target.number} has been banned from *${meta.subject}*.`
    : `🚫 @${target.number} has been kicked from *${meta.subject}*.`;
  const rendered = await renderTemplate(template ?? defaultText, { senderJid: targetJid, gcName: meta.subject, socket, groupJid });
  await socket.sendMessage(groupJid, { text: rendered, mentions: [targetJid] });
  logger.info('[Moderation] participant removed', { action, groupJid, targetJid, targetNumber: target.number });
  return { ok: true, targetJid, targetNumber: target.number, groupName: meta.subject, reply: '' };
}
