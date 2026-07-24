// ============================================================
// WA-Bridge — Tagging Engine
// .tag (hidetag) / .mtag (visible @mention)
// ============================================================

import type { BridgeWASocket as WASocket, AnyMessageContent } from '../baileys-types.js';
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
  sessionId: string,
  groupJid: string,
  text: string,
  opts: {
    mediaBuffer?: Buffer;
    mediaType?: string;
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
      if (opts.mediaType === 'video') {
        content = { video: opts.mediaBuffer, caption: text, mentions: participants };
      } else if (opts.mediaType === 'audio') {
        content = { audio: opts.mediaBuffer, mimetype: 'audio/mp4', mentions: participants };
      } else {
        content = { image: opts.mediaBuffer, caption: text, mentions: participants };
      }
    } else {
      // Invisible hidetag: include mentions array but no @name in text
      content = { text, mentions: participants };
    }

    await socket.sendMessage(groupJid, content);
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
  sessionId: string,
  groupJid: string,
  text: string,
  opts: {
    chunkSize?: number; // mentions per message (default: 100)
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
      // Build visible @mention string
      const mentionText = chunk.map((jid) => `@${jid.split('@')[0]}`).join(' ');
      const fullText = `${text}\n\n${mentionText}`;

      await socket.sendMessage(groupJid, {
        text: fullText,
        mentions: chunk,
      });

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

// ── Tag Summary (for WA reply) ────────────────────────────

export function tagSummary(pinged: number, mode: 'tag' | 'mtag'): string {
  const label = mode === 'tag' ? 'Hidetag' : 'Visible Mention';
  return [
    bold(`📢 ${label} Complete`),
    `Tagged: ${pinged} members`,
  ].join('\n');
}
