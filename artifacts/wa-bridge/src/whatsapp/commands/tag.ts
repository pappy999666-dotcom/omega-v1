// ============================================================
// WA-Bridge — Tagging Engine v2
// .tag   — Hidetag broadcast (silent mention ping, no visible @name)
// .mtag  — Visible mention broadcast (one @name per line)
//
// ALL preview operations flow through the centralized
// PreviewManager — the single source of truth.
// ============================================================

import type { BridgeWASocket as WASocket, AnyMessageContent, IMessage } from '../baileys-types.js';
import { PreviewManager } from '../../preview-engine/index.js';
import type { PartialLinkMeta } from '../../preview-engine/types.js';
import { sendAsIs } from '../chat-as-is.js';
import { logger } from '../../utils/logger.js';
import { isFrozen } from '../socket-manager.js';
import { bold } from '../../utils/ascii-art.js';
import { sanitizeMentionJids, syncMentionTokens, mentionToken } from '../utils/mention-engine.js';

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
 *
 * Behavior:
 *   • Text + mentions array → everyone gets notified but sees plain text
 *   • Media + mentions array → everyone gets notified on the media message
 *   • Quoted rich message → relayed as-is with mentions injected
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
    /** JIDs the user explicitly mentioned on the triggering message (contextInfo.mentionedJid). */
    incomingMentions?: string[];
  } = {}
): Promise<{ success: boolean; pinged: number; error?: string }> {
  if (isFrozen(sessionId)) {
    return { success: false, pinged: 0, error: 'Session frozen' };
  }
  if (!text.trim() && !opts.mediaBuffer && !opts.sourceExt) {
    return { success: false, pinged: 0, error: 'A real text or media payload is required' };
  }

  const participants = await getParticipants(socket, groupJid);

  if (participants.length === 0) {
    return { success: false, pinged: 0, error: 'Could not fetch participants' };
  }

  // Central Mention Engine: normalize participant JIDs (LID → real phone)
  // so hidetag pings + any @<phone> tokens stay in sync. Unresolvable LIDs
  // fall back to the raw ids so the silent ping still reaches everyone.
  // The user's OWN mentions (contextInfo.mentionedJid from .tag @John) are
  // unioned in — they are authoritative and guarantee the @token the user
  // typed is never left dangling without its JID in the mention array.
  const rawIds = [...participants, ...(opts.incomingMentions ?? [])];
  const sanitized = await sanitizeMentionJids(socket, rawIds).catch(() => []);
  const mentionJids = sanitized.length > 0 ? sanitized : rawIds;

  try {
    // Token/array sync guard: every @<digits> token the user typed (e.g.
    // the @John → @<phone> echo) must have its phone JID in the mentions
    // array, otherwise WhatsApp renders the raw number. Cheap passthrough
    // for phone JIDs; never fails the send.
    const synced = await syncMentionTokens(socket, text || '', mentionJids).catch(() => null);
    const finalText = synced?.text ?? text;
    const finalMentions = synced?.mentions ?? mentionJids;

    if (opts.mediaBuffer && opts.mediaType === 'sticker') {
      // Stickers must be sent via sendMessage directly — PreviewManager's media
      // pipeline does not support the sticker message type for mentions-tagged sends.
      await (socket as any).sendMessage(groupJid, {
        sticker: opts.mediaBuffer,
        mimetype: 'image/webp',
        mentions: finalMentions,
      });
    } else if (opts.mediaBuffer) {
      await PreviewManager.send(socket as any, groupJid, finalText, {
        media: {
          buffer: opts.mediaBuffer,
          type: opts.mediaType as any ?? 'image',
          caption: finalText || undefined,
        },
        extra: { mentions: finalMentions },
        forceMentions: true,
        sessionId,
        telegramId,
      });
    } else if (opts.sourceExt) {
      // As-is relay — WA-built preview relayed verbatim via likeThis
      const fullText = finalText || '';
      const sent = await sendAsIs(socket, groupJid, fullText, opts.sourceExt, { mentions: finalMentions });
      if (sent) return { success: true, pinged: finalMentions.length };
      // Fallback if likeThis failed
      await PreviewManager.send(socket as any, groupJid, fullText, {
        existingPreview: opts.existingPreview,
        extra: { mentions: finalMentions },
        forceMentions: true,
        sessionId,
        telegramId,
      });
    } else {
      // Plain text hidetag — text only, mentions in array
      await PreviewManager.send(socket as any, groupJid, finalText, {
        existingPreview: opts.existingPreview,
        extra: { mentions: finalMentions },
        forceMentions: true,
        sessionId,
        telegramId,
      });
    }

    logger.info(`[Tag] Hidetag sent to ${groupJid} — ${mentionJids.length} pinged`);
    return { success: true, pinged: mentionJids.length };
  } catch (err) {
    return { success: false, pinged: 0, error: String(err) };
  }
}

// ── .mtag — Visible @mention Broadcast (one per line) ────

/**
 * .mtag [msg] — Explicitly @mention each participant by name.
 * Renders visible @name tags in the WhatsApp message.
 *
 * Format: One mention per line for readability.
 *   @name1
 *   @name2
 *   @name3
 *
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
    /** JIDs the user explicitly mentioned on the triggering message. */
    incomingMentions?: string[];
  } = {}
): Promise<{ success: boolean; pinged: number; messages: number; error?: string }> {
  if (isFrozen(sessionId)) {
    return { success: false, pinged: 0, messages: 0, error: 'Session frozen' };
  }
  if (!text.trim() && !opts.mediaBuffer && !opts.sourceExt) {
    return { success: false, pinged: 0, messages: 0, error: 'A real text or media payload is required' };
  }

  const participants = await getParticipants(socket, groupJid);

  if (participants.length === 0) {
    return { success: false, pinged: 0, messages: 0, error: 'Could not fetch participants' };
  }

  // Central Mention Engine: resolve every participant to a REAL phone JID.
  // Visible mentions require the @<phone> token AND the phone JID in
  // mentionedJid to match — LID ids would render as plain text, so only
  // phone-resolvable participants are listed. The user's own mentions
  // (contextInfo.mentionedJid) are unioned in so a targeted .mtag @John
  // always renders John as a native mention even if the participant scan
  // could not resolve his LID.
  const rawIds = [...participants, ...(opts.incomingMentions ?? [])];
  const sanitized = await sanitizeMentionJids(socket, rawIds).catch(() => []);
  if (sanitized.length === 0) {
    return { success: false, pinged: 0, messages: 0, error: 'Could not resolve participants to phone JIDs' };
  }

  const chunkSize = opts.chunkSize ?? 100;
  const chunks: string[][] = [];

  for (let i = 0; i < sanitized.length; i += chunkSize) {
    chunks.push(sanitized.slice(i, i + chunkSize));
  }

  let pinged = 0;
  let messages = 0;

  try {
    for (const chunk of chunks) {
      // Build visible @mention string — ONE per line with icon.
      // Tokens come from the SAME sanitized phone JIDs as the mentions array,
      // so every rendered @name is a native tappable mention.
      const mentionText = chunk
        .map((jid) => `├ 👤 ${mentionToken(jid)}`)
        .join('\n');

      // Prepend header and optional custom text
      const header = '📢 *GROUP MENTION*';
      const fullText = text 
        ? `${header}\n\n${text}\n\n${mentionText}` 
        : `${header}\n\n${mentionText}`;

      if (opts.mediaBuffer && opts.mediaType === 'sticker') {
        await (socket as any).sendMessage(groupJid, {
          sticker: opts.mediaBuffer,
          mimetype: 'image/webp',
          mentions: chunk,
        });
      } else if (opts.mediaBuffer) {
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
