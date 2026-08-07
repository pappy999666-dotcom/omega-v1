// ============================================================
// WA-Bridge — Status & Target Broadcast Commands
// .gstatus / .tochat / .tochatx / .sstatus
//
// ALL preview operations now flow through the centralized
// PreviewManager — the single source of truth.
// ============================================================

import type { BridgeWASocket as WASocket, AnyMessageContent, IMessage } from '../baileys-types.js';
// ── SINGLE IMPORT: All preview operations via PreviewManager ──
import { PreviewManager } from '../../preview-engine/index.js';
import { UrlDetector } from '../../preview-engine/UrlDetector.js';
import type { PartialLinkMeta } from '../../preview-engine/types.js';
import { sendAsIs } from '../chat-as-is.js';
import { sleep, jitter } from '../../utils/delay.js';
import { logger } from '../../utils/logger.js';
import { asciiBox, bold, italic } from '../../utils/ascii-art.js';
import { isFrozen } from '../socket-manager.js';
import { sendGroupStatus } from '../groupStatus.js';
import { generateStatusCard } from '../../services/status-card-pipeline.js';

// Track active spam loops per session
const activeSpamLoops = new Set<string>();

// ── Helper: resolve JID from link or direct JID ──────────

export function resolveJid(target: string): string {
  // Direct JID (e.g., 1234567890@g.us)
  if (target.includes('@')) return target;

  // WhatsApp group invite link → extract code (join handled by lifecycle)
  // For status targeting, we just need the group JID
  const match = target.match(/chat\.whatsapp\.com\/([A-Za-z0-9_-]+)/);
  if (match) {
    // Return the invite code — caller must resolve to JID via groupGetInviteInfo
    return `invite:${match[1]}`;
  }

  // Assume it's a phone number for private chat
  const clean = target.replace(/\D/g, '');
  return `${clean}@s.whatsapp.net`;
}

// ── Group Status Posting ──────────────────────────────────

/**
 * .gstatus — Post text/media to the status of the current group.
 * WhatsApp status updates use the special 'status@broadcast' JID.
 */
export async function cmdGStatus(
  socket: WASocket,
  telegramId: string,
  sessionId: string,
  text: string,
  opts: { mediaBuffer?: Buffer; mediaType?: string; caption?: string; theme?: string } = {}
): Promise<void> {
  if (isFrozen(sessionId)) {
    await PreviewManager.send(socket as any, 'status@broadcast', '❄️ Session is frozen — status posting paused', {
      statusOptions: { statusJidList: undefined },
      sessionId,
      telegramId,
    });
    return;
  }

  const designedText = await generateStatusCard(text, opts.theme);
  await PreviewManager.send(socket as any, 'status@broadcast', designedText, {
    media: opts.mediaBuffer ? {
      buffer: opts.mediaBuffer,
      type: opts.mediaType as any ?? 'image',
      caption: opts.caption ?? designedText,
    } : undefined,
    statusOptions: { statusJidList: undefined },
    sessionId,
    telegramId,
  });

  logger.info(`[gstatus] ${sessionId} posted status`);
}

// ── Target Chat ───────────────────────────────────────────

/**
 * .tochat [JID/Link] [msg] — Send message to a specific target.
 */
export async function cmdToChat(
  socket: WASocket,
  telegramId: string,
  sessionId: string,
  target: string,
  text: string,
  opts: { mediaBuffer?: Buffer; mediaType?: string; existingPreview?: PartialLinkMeta; sourceExt?: NonNullable<IMessage['extendedTextMessage']> } = {}
): Promise<{ success: boolean; error?: string }> {
  if (isFrozen(sessionId)) {
    return { success: false, error: 'Session frozen' };
  }

  try {
    const jid = await resolveTargetJid(socket, target);
    if (opts.mediaBuffer) {
      await PreviewManager.send(socket as any, jid, text, {
        media: {
          buffer: opts.mediaBuffer,
          type: opts.mediaType as any ?? 'image',
          caption: text,
        },
        sessionId,
        telegramId,
      });
    } else if (opts.sourceExt) {
      const sent = await sendAsIs(socket, jid, text, opts.sourceExt);
      if (!sent) {
        await PreviewManager.send(socket as any, jid, text, {
          existingPreview: opts.existingPreview,
          sessionId,
          telegramId,
        });
      }
    } else {
      await PreviewManager.send(socket as any, jid, text, {
        existingPreview: opts.existingPreview,
        sessionId,
        telegramId,
      });
    }
    logger.info(`[tochat] ${sessionId} → ${jid}`);
    return { success: true };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

/**
 * .tochatx [JID/Link] [count] [msg] — Deliver `count` times with jitter.
 */
export async function cmdToChatX(
  socket: WASocket,
  telegramId: string,
  sessionId: string,
  target: string,
  count: number,
  text: string,
  opts: { existingPreview?: PartialLinkMeta; sourceExt?: NonNullable<IMessage['extendedTextMessage']> } = {}
): Promise<{ sent: number; failed: number }> {
  if (isFrozen(sessionId)) return { sent: 0, failed: count };

  let sent = 0;
  let failed = 0;

  try {
    const jid = await resolveTargetJid(socket, target);

    for (let i = 0; i < count; i++) {
      if (isFrozen(sessionId)) break;
      try {
        if (opts.sourceExt) {
          const sent = await sendAsIs(socket, jid, text, opts.sourceExt);
          if (!sent) {
            await PreviewManager.send(socket as any, jid, text, {
              existingPreview: opts.existingPreview,
              sessionId,
              telegramId,
            });
          }
        } else {
          await PreviewManager.send(socket as any, jid, text, {
            existingPreview: opts.existingPreview,
            sessionId,
            telegramId,
          });
        }
        sent++;
      } catch {
        failed++;
      }
      if (i < count - 1) await jitter(1500, 3500);
    }
  } catch (err) {
    logger.error(`[tochatx] Error: ${err}`);
    failed = count - sent;
  }

  return { sent, failed };
}

/**
 * .sstatus — Infinite rapid-posting loop to status.
 * Kill with .stop spam
 */
export async function cmdSStatus(
  socket: WASocket,
  telegramId: string,
  sessionId: string,
  text: string,
  opts: { theme?: string; existingPreview?: PartialLinkMeta } = {}
): Promise<void> {
  if (activeSpamLoops.has(sessionId)) {
    logger.warn(`[sstatus] Loop already running for ${sessionId}`);
    return;
  }

  activeSpamLoops.add(sessionId);
  logger.info(`[sstatus] Starting infinite loop for ${sessionId}`);

  try {
    while (activeSpamLoops.has(sessionId) && !isFrozen(sessionId)) {
      try {
        const designedText = await generateStatusCard(text, opts.theme);
        await PreviewManager.send(socket as any, 'status@broadcast', designedText, {
          existingPreview: opts.existingPreview,
          statusOptions: { statusJidList: undefined },
          sessionId,
          telegramId,
        });
      } catch (err) {
        logger.warn(`[sstatus] Post error: ${err}`);
      }
      await jitter(500, 1500);
    }
  } finally {
    activeSpamLoops.delete(sessionId);
    logger.info(`[sstatus] Loop stopped for ${sessionId}`);
  }
}

/**
 * Stop all active loops for a session (.stop spam).
 */
export function stopSpamLoop(sessionId: string): boolean {
  const had = activeSpamLoops.has(sessionId);
  activeSpamLoops.delete(sessionId);
  return had;
}

export function isSpamLoopActive(sessionId: string): boolean {
  return activeSpamLoops.has(sessionId);
}

// ── Helpers ───────────────────────────────────────────────

async function resolveTargetJid(socket: WASocket, target: string): Promise<string> {
  const jid = resolveJid(target);

  if (jid.startsWith('invite:')) {
    const code = jid.replace('invite:', '');
    const info = await socket.groupGetInviteInfo(code);
    return info.id;
  }

  return jid;
}

function buildMediaContent(
  buffer: Buffer,
  type: string,
  caption: string,
  opts: { mimeType?: string; ptt?: boolean } = {}
): AnyMessageContent {
  if (type === 'video') {
    return { video: buffer, caption, mimetype: opts.mimeType ?? 'video/mp4', gifPlayback: false };
  }
  if (type === 'audio') {
    // Preserve the original codec mimetype (audio/ogg; codecs=opus for voice
    // notes) and the ptt flag — never force audio/mp4 which breaks playback.
    return { audio: buffer, mimetype: opts.mimeType ?? 'audio/ogg; codecs=opus', ptt: Boolean(opts.ptt) };
  }
  if (type === 'document') {
    return { document: buffer, mimetype: opts.mimeType ?? 'application/octet-stream', caption: caption || undefined };
  }
  // Default: image
  return { image: buffer, caption, mimetype: opts.mimeType ?? 'image/jpeg' };
}

// ── Status Group Posting ──────────────────────────────────

/**
 * Post to status of a specific group (group status feature in Baileys).
 * Uses sendMessage with the group JID targeting status channel.
 */
export async function cmdGroupStatus(
  socket: WASocket,
  telegramId: string,
  sessionId: string,
  groupJid: string,
  text: string,
  opts: { mediaBuffer?: Buffer; mediaType?: string; caption?: string; mimeType?: string; ptt?: boolean; fileName?: string; theme?: string; skipDesign?: boolean; existingPreview?: PartialLinkMeta; sourceMsg?: { message?: import('../baileys-types.js').IMessage | null }; groupTitle?: string } = {}
): Promise<boolean> {
  if (isFrozen(sessionId)) return false;

  try {
    // When sourceMsg is set the caller is relaying an existing WA message (PATH 0 AS_IS).
    // Do NOT apply the design engine — changing the text corrupts the matchedText byte
    // offsets that WhatsApp uses to render the inline preview card.
    // Also skip design when skipDesign is explicitly requested.
    const shouldDesign = !opts.skipDesign && !opts.sourceMsg && !opts.mediaBuffer;
    const designedText = shouldDesign
      ? await generateStatusCard(text, opts.theme)
      : text;

    await sendGroupStatus(socket, sessionId, groupJid, designedText, {
      mediaBuffer: opts.mediaBuffer,
      mediaType: opts.mediaType as 'image' | 'video' | 'audio' | 'document' | undefined,
      caption: opts.caption ?? designedText,
      mimeType: opts.mimeType,
      ptt: opts.ptt,
      fileName: opts.fileName,
      existingPreview: opts.existingPreview,
      sourceMsg: opts.sourceMsg,
    });
    return true;
  } catch (err) {
    logger.error('[cmdGroupStatus] failed', { groupJid, err: String(err) });
    return false;
  }
}
