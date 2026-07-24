// ============================================================
// WA-Bridge — Status & Target Broadcast Commands
// .gstatus / .tochat / .tochatx / .sstatus
// ============================================================

import type { BridgeWASocket as WASocket, AnyMessageContent } from '../baileys-types.js';
import { hydratedMessage } from '../preview-generator.js';
import { sleep, jitter } from '../../utils/delay.js';
import { logger } from '../../utils/logger.js';
import { asciiBox, bold, italic } from '../../utils/ascii-art.js';
import { isFrozen } from '../socket-manager.js';
import { sendGroupStatus } from '../groupStatus.js';

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
  sessionId: string,
  text: string,
  opts: { mediaBuffer?: Buffer; mediaType?: string; caption?: string } = {}
): Promise<void> {
  if (isFrozen(sessionId)) {
    await socket.sendMessage('status@broadcast', {
      text: '❄️ Session is frozen — status posting paused',
    });
    return;
  }

  const content: AnyMessageContent = opts.mediaBuffer
    ? buildMediaContent(opts.mediaBuffer, opts.mediaType ?? 'image', opts.caption ?? text)
    : await hydratedMessage(text);

  await socket.sendMessage('status@broadcast', content, {
    statusJidList: undefined, // Post to all contacts
  });

  logger.info(`[gstatus] ${sessionId} posted status`);
}

// ── Target Chat ───────────────────────────────────────────

/**
 * .tochat [JID/Link] [msg] — Send message to a specific target.
 */
export async function cmdToChat(
  socket: WASocket,
  sessionId: string,
  target: string,
  text: string,
  opts: { mediaBuffer?: Buffer; mediaType?: string } = {}
): Promise<{ success: boolean; error?: string }> {
  if (isFrozen(sessionId)) {
    return { success: false, error: 'Session frozen' };
  }

  try {
    const jid = await resolveTargetJid(socket, target);
    const content: AnyMessageContent = opts.mediaBuffer
      ? buildMediaContent(opts.mediaBuffer, opts.mediaType ?? 'image', text)
      : await hydratedMessage(text);

    await socket.sendMessage(jid, content);
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
  sessionId: string,
  target: string,
  count: number,
  text: string
): Promise<{ sent: number; failed: number }> {
  if (isFrozen(sessionId)) return { sent: 0, failed: count };

  let sent = 0;
  let failed = 0;

  try {
    const jid = await resolveTargetJid(socket, target);

    for (let i = 0; i < count; i++) {
      if (isFrozen(sessionId)) break;
      try {
        const content = await hydratedMessage(text);
        await socket.sendMessage(jid, content);
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
  sessionId: string,
  text: string
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
        const content = await hydratedMessage(text);
        await socket.sendMessage('status@broadcast', content);
      } catch (err) {
        logger.warn(`[sstatus] Post error: ${err}`);
      }
      await jitter(500, 1500); // Rapid but jittered
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
  caption: string
): AnyMessageContent {
  if (type === 'video') {
    return { video: buffer, caption, gifPlayback: false };
  }
  if (type === 'audio') {
    return { audio: buffer, mimetype: 'audio/mp4', ptt: false };
  }
  // Default: image
  return { image: buffer, caption };
}

// ── Status Group Posting ──────────────────────────────────

/**
 * Post to status of a specific group (group status feature in Baileys).
 * Uses sendMessage with the group JID targeting status channel.
 */
export async function cmdGroupStatus(
  socket: WASocket,
  sessionId: string,
  groupJid: string,
  text: string,
  opts: { mediaBuffer?: Buffer; mediaType?: string; caption?: string } = {}
): Promise<boolean> {
  if (isFrozen(sessionId)) return false;

  try {
    await sendGroupStatus(socket, sessionId, groupJid, text, {
      mediaBuffer: opts.mediaBuffer,
      mediaType: opts.mediaType as 'image' | 'video' | 'audio' | undefined,
      caption: opts.caption,
    });
    return true;
  } catch {
    return false;
  }
}
