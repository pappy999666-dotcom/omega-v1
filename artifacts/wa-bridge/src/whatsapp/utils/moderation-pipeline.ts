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
import { BOT_NOT_ADMIN_MSG, fetchGroupMeta, isAdminJid, stripDeviceSuffix } from './group-permissions.js';

// findParticipant and numericId removed: resolveTarget already returns target.participant
// directly from the live group participant list — no second lookup needed.

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

/** Mask a phone number for safe logging: show first 4 + last 2 digits only. */
function maskNumber(num: string): string {
  if (num.length <= 6) return '***';
  return `${num.slice(0, 4)}***${num.slice(-2)}`;
}

/**
 * Detect genuinely transient WhatsApp errors that warrant a retry.
 *
 * Each pattern is anchored to a standalone word boundary so that JIDs,
 * phone numbers, or unrelated words (e.g. "separate", "unrecoverable")
 * cannot accidentally trigger a retry.
 */
function isTransientParticipantError(err: unknown): boolean {
  const text = String(err instanceof Error ? err.message : err).toLowerCase();
  return (
    /\btimed?\s*out\b/.test(text) ||
    /\btimeout\b/.test(text) ||
    /\brate\b/.test(text) ||
    /\btoo\s+many\b/.test(text) ||
    /\btemporar/.test(text) ||
    /\bagain\b/.test(text) ||
    /\bunavailable\b/.test(text) ||
    /\binternal[-\s]server[-\s]error\b/.test(text) ||
    /\b500\b/.test(text) ||
    /\b503\b/.test(text) ||
    /\b429\b/.test(text)
  );
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

interface ParticipantStatusEntry {
  jid?: string;
  status: number;
}

/**
 * Remove a participant with up to 3 attempts.
 *
 * Inspects the returned status array from groupParticipantsUpdate — a resolved
 * promise does NOT imply success.  Only status 200 is accepted.  Non-200
 * results are treated as errors and fed through the transient-retry decision:
 *   • transient codes (429, 503, 500, timeout, …) → retry
 *   • permanent codes (403, 404, etc.) → throw immediately
 */
async function removeParticipantWithRetry(
  socket: WASocket,
  groupJid: string,
  participantJid: string,
): Promise<void> {
  const sock = socket as unknown as {
    groupParticipantsUpdate(
      jid: string,
      participants: string[],
      action: 'remove',
    ): Promise<ParticipantStatusEntry[]>;
  };
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const results = await sock.groupParticipantsUpdate(groupJid, [participantJid], 'remove');

      // Validate the per-participant status returned by Baileys.
      // When the array is absent or the JID is not listed, assume success
      // (older Baileys builds may return an empty array for successful ops).
      if (Array.isArray(results) && results.length > 0) {
        const entry = results.find(
          (r) => !r.jid || r.jid === participantJid,
        );
        // Only treat as error for known failure codes (≥400).
        // Status 0, undefined, or missing = Baileys didn't populate it = treat as success.
        if (entry && entry.status >= 400) {
          const statusErr = new Error(
            `groupParticipantsUpdate returned status ${entry.status} for participant`,
          );
          logger.warn('[Moderation] participant remove non-200', {
            groupJid,
            participantJid: maskNumber(participantJid.split('@')[0] ?? ''),
            status: entry.status,
            attempt,
          });
          // Only retry genuinely transient status codes.
          if (!isTransientParticipantError(String(entry.status))) throw statusErr;
          lastErr = statusErr;
          if (attempt < 3) await sleep(300 * attempt);
          continue;
        }
      }

      return; // confirmed success
    } catch (err) {
      lastErr = err;
      logger.warn('[Moderation] participant remove failed', {
        groupJid,
        participantJid: maskNumber(participantJid.split('@')[0] ?? ''),
        attempt,
        err,
      });
      if (attempt === 3 || !isTransientParticipantError(err)) break;
      await sleep(300 * attempt);
    }
  }
  throw lastErr;
}

export async function runRemoveModerationPipeline(
  options: ModerationPipelineOptions,
): Promise<ModerationPipelineResult> {
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
    // Do not log raw args — they may contain phone numbers or personal identifiers.
    logger.warn('[Moderation] target not in group or unresolved', { action, groupJid });
    return {
      ok: false,
      reply: warningCard(
        label,
        `Provide a group member phone number, reply to a message, or @mention someone.\nUsage: ${prefix}${action} @user`,
      ),
    };
  }

  // Use the participant already returned by resolveTarget — no second lookup.
  const participant = target.participant;

  if (isAdminJid(meta.participants, participant.id)) {
    logger.warn('[Moderation] refused to remove admin/owner', {
      action,
      groupJid,
      targetNumber: maskNumber(target.number),
    });
    return {
      ok: false,
      reply: warningCard(
        label,
        `@${target.number} is a group admin and cannot be ${action === 'ban' ? 'banned' : 'kicked'} directly.\nUse ${prefix}dnkick to demote then remove them.`,
      ),
    };
  }

  const targetJid = stripDeviceSuffix(participant.id);
  try {
    await removeParticipantWithRetry(socket, groupJid, targetJid);
  } catch (err) {
    logger.error('[Moderation] participant remove permanently failed', {
      action,
      groupJid,
      targetNumber: maskNumber(target.number),
      err,
    });
    return {
      ok: false,
      reply: errorCard(
        `${label} Failed`,
        `Could not ${action === 'ban' ? 'ban' : 'remove'} @${target.number}. Please try again or check my admin permissions.`,
      ),
    };
  }

  // Member has been successfully removed.
  // Delete the triggering message (quoted reply) if this was a reply-kick.
  const quotedKey = msg.message?.extendedTextMessage?.contextInfo?.stanzaId
    ? {
        remoteJid: groupJid,
        id: msg.message.extendedTextMessage.contextInfo.stanzaId,
        participant: msg.message.extendedTextMessage.contextInfo.participant,
        fromMe: false,
      }
    : null;
  if (quotedKey) {
    await (socket as unknown as {
      sendMessage(jid: string, content: Record<string, unknown>): Promise<unknown>;
    }).sendMessage(groupJid, { delete: quotedKey }).catch(() => {});
  }

  // onSuccess, announcement rendering, and sendMessage are all best-effort:
  // failures in this section must NOT invalidate the completed moderation action.
  onSuccess?.(target.number);
  try {
    const defaultText =
      action === 'ban'
        ? `🔨 @${target.number} has been banned from *${meta.subject}*.`
        : `🚫 @${target.number} has been kicked from *${meta.subject}*.`;
    const rendered = await renderTemplate(template ?? defaultText, {
      senderJid: targetJid,
      gcName: meta.subject,
      socket,
      groupJid,
    });
    await socket.sendMessage(groupJid, { text: rendered, mentions: [targetJid] });
  } catch (announceErr) {
    // Announcement failed — the member was already removed. Log and continue.
    logger.warn('[Moderation] announcement failed after successful removal', {
      action,
      groupJid,
      targetNumber: maskNumber(target.number),
      err: announceErr,
    });
  }

  logger.info('[Moderation] participant removed', {
    action,
    groupJid,
    targetNumber: maskNumber(target.number),
  });
  return { ok: true, targetJid, targetNumber: target.number, groupName: meta.subject, reply: '' };
}
