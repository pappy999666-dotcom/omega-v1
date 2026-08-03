// ============================================================
// WA-Bridge — Tagging Engine
// .tag (hidetag) / .mtag (visible @mention)
//
// ALL preview operations now flow through the centralized
// PreviewManager — the single source of truth.
// ============================================================

import type { BridgeWASocket as WASocket, AnyMessageContent, IMessage } from '../baileys-types.js';
// ── SINGLE IMPORT: All preview operations via PreviewManager ──
import { PreviewManager } from '../../preview-engine/index.js';
import type { PartialLinkMeta } from '../../preview-engine/types.js';
import { sendAsIs } from '../chat-as-is.js';
import { logger } from '../../utils/logger.js';
import { isFrozen } from '../socket-manager.js';
import { bold } from '../../utils/ascii-art.js';

// ── Participant Fetcher ───────────────────────────────────

async function getParticipants(
  socket: WASocket,
  groupJid: string
): Promise<string[]> {
  try {
    const meta = await socket.groupMetadata(groupJid);
    return meta.participants.map((p) => p.id);
  } catch (err) {
    logger.warn(`[Tag] Failed to fetch participants for ${groupJid}`, {
      err: String(err),
    });
    return [];
  }
}

// ── .tag — Hidetag Broadcast ──────────────────────────────

/**
 * .tag [msg] — Send a message that mentions ALL participants invisibly.
 * WhatsApp will ping everyone even though no @name appears in the text.
 * Uses the `mentions` array on the message for the silent ping effect.
 */
export async function cmdTag(
  socket: WASocket,
  telegramId: string,
  sessionId: string,
  groupJid: string,
  text: string,
  opts: {
    mediaBuffer?: Buffer;
    mediaType?: string;
    existingPreview?: PartialLinkMeta;
    sourceExt?: NonNullable<IMessage['extendedTextMessage']>;
  } = {}
): Promise<{ success: boolean; pinged: number; error?: string }> {
  if (isFrozen(sessionId)) {
    return { success: false, pinged: 0, error: 'Session frozen' };
  }

  const participants = await getParticipants(socket, groupJid);

  if (participants.length === 0) {
    return { success: false, pinged: 0, error: 'Could not fetch participants' };
  }

  try {
    let content: AnyMessageContent;

    if (opts.mediaBuffer) {
      await PreviewManager.send(socket as any, groupJid, text, {
        media: {
          buffer: opts.mediaBuffer,
          type: opts.mediaType as any ?? 'image',
          caption: text,
        },
        extra: { mentions: participants },
        forceMentions: true,
        sessionId,
        telegramId,
      });
    } else if (opts.sourceExt) {
      // As-is relay — WA-built preview relayed verbatim via likeThis
      const sent = await sendAsIs(socket, groupJid, text, opts.sourceExt, { mentions: participants });
      if (sent) return { success: true, pinged: participants.length };
      // fallthrough if likeThis failed
      await PreviewManager.send(socket as any, groupJid, text, {
        existingPreview: opts.existingPreview,
        extra: { mentions: participants },
        forceMentions: true,
        sessionId,
        telegramId,
      });
    } else {
      await PreviewManager.send(socket as any, groupJid, text, {
        existingPreview: opts.existingPreview,
        extra: { mentions: participants },
        forceMentions: true,
        sessionId,
        telegramId,
      });
    }
    logger.info(`[Tag] Hidetag sent to ${groupJid} — ${participants.length} pinged`);

    return { success: true, pinged: participants.length };
  } catch (err) {
    return { success: false, pinged: 0, error: String(err) };
  }
}

// ── .mtag — Visible @mention Broadcast ───────────────────

/**
 * .mtag [msg] — Explicitly @mention each participant by name.
 * Renders visible @name tags in the WhatsApp message.
 * Uses chunked batches to avoid message size limits.
 */
export async function cmdMTag(
  socket: WASocket,
  telegramId: string,
  sessionId: string,
  groupJid: string,
  text: string,
  opts: {
    chunkSize?: number;
    existingPreview?: PartialLinkMeta;
    sourceExt?: NonNullable<IMessage['extendedTextMessage']>;
    mediaBuffer?: Buffer;
    mediaType?: string;
  } = {}
): Promise<{ success: boolean; pinged: number; messages: number; error?: string }> {
  if (isFrozen(sessionId)) {
    return { success: false, pinged: 0, messages: 0, error: 'Session frozen' };
  }

  const participants = await getParticipants(socket, groupJid);

  if (participants.length === 0) {
    return { success: false, pinged: 0, messages: 0, error: 'Could not fetch participants' };
  }

  const chunkSize = opts.chunkSize ?? 100;
  const chunks: string[][] = [];

  for (let i = 0; i < participants.length; i += chunkSize) {
    chunks.push(participants.slice(i, i + chunkSize));
  }

  let pinged = 0;
  let messages = 0;

  try {
    for (const chunk of chunks) {
      // Build visible @mention string - VERTICAL layout as per audit requirements
      const mentionText = chunk.map((jid) => `┃ ✦ @${jid.split('@')[0]}`).join('\n');
      const fullText = `${text}\n\n${mentionText}`;

      if (opts.mediaBuffer) {
        await PreviewManager.send(socket as any, groupJid, fullText, {
          media: {
            buffer: opts.mediaBuffer,
            type: opts.mediaType as any ?? 'image',
            caption: fullText,
          },
          extra: { mentions: chunk },
          forceMentions: true,
          sessionId,
          telegramId,
        });
      } else if (opts.sourceExt) {
        const sent = await sendAsIs(socket, groupJid, fullText, opts.sourceExt, { mentions: chunk });
        if (!sent) {
          await PreviewManager.send(socket as any, groupJid, fullText, {
            existingPreview: opts.existingPreview,
            extra: { mentions: chunk },
            forceMentions: true,
            sessionId,
            telegramId,
          });
        }
      } else {
        await PreviewManager.send(socket as any, groupJid, fullText, {
          existingPreview: opts.existingPreview,
          extra: { mentions: chunk },
          forceMentions: true,
          sessionId,
          telegramId,
        });
      }

      pinged += chunk.length;
      messages++;
    }

    logger.info(
      `[MTag] Sent ${messages} message(s) mentioning ${pinged} participants in ${groupJid}`
    );

    return { success: true, pinged, messages };
  } catch (err) {
    return { success: false, pinged, messages, error: String(err) };
  }
}

// ── Tag Summary (for .mtag WA reply) ─────────────────────

export function tagSummary(pinged: number, mode: 'tag' | 'mtag'): string {
  const label = mode === 'tag' ? 'Hidetag' : 'Visible Mention';
  return [
    bold(`📢 ${label} Complete`),
    `Tagged: ${pinged} members`,
  ].join('\n');
}
