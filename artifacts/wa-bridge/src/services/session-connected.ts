// ============================================================
// WA-Bridge — Robust Session Connected Notification Service
//
// Production-grade, fully awaited notification pipeline.
// Ensures reliable delivery of Telegram and WhatsApp notifications.
// ============================================================

import type { BridgeWASocket as WASocket } from '../whatsapp/baileys-types.js';
import { logger } from '../utils/logger.js';
import { findSessionOwner, updateSessionMeta, loadSessionMeta } from './workspace.js';

export interface ConnectedNotification {
  /** Telegram chat ID to notify */
  telegramChatId?: number;
  /** Telegram bot API reference for sending/editing messages */
  telegram?: {
    sendMessage(chatId: number, text: string, opts?: Record<string, unknown>): Promise<unknown>;
    editMessageText(chatId: number, msgId: number, opts: unknown, text: string, replyOpts?: Record<string, unknown>): Promise<unknown>;
    sendPhoto(chatId: number, photo: { source: Buffer }, opts?: Record<string, unknown>): Promise<unknown>;
  };
  /** WhatsApp socket to self-DM */
  socket?: WASocket;
  /** The session ID */
  sessionId: string;
  /** The phone number */
  phone: string;
  /** Display name (fallback to label) */
  label?: string;
  /** Connection method: 'QR Code', 'Pairing Code', 'Reinit', 'WhatsApp Pair' */
  method: string;
  /** Telegram reply markup (keyboard) */
  replyMarkup?: Record<string, unknown>;
  /** Telegram progress message ID to edit (optional) */
  progressMsgId?: number;
  /** Session owner Telegram ID (for fallback messaging) */
  ownerTelegramId?: string;
  /** Force notification even if already delivered (e.g. manual reinit) */
  force?: boolean;
}

// ── Fetch WA Profile ──────────────────────────────────────

async function fetchWAProfile(
  socket: WASocket,
  jid: string
): Promise<{ name: string; photoBuffer: Buffer | null }> {
  let name = 'Unknown';
  let photoBuffer: Buffer | null = null;
  try {
    // Baileys fetchBusinessProfile
    const info = await (socket as any).fetchBusinessProfile?.(jid).catch(() => null);
    if (info?.name) name = info.name;
    else {
      // Fallback to store contacts
      const contacts = (socket as any).store?.contacts;
      const contact = contacts?.[jid];
      if (contact?.name) name = contact.name;
      else if (contact?.notify) name = contact.notify;
    }
  } catch (err) {
    logger.debug(`[ConnectedNotify] Profile fetch error: ${String(err)}`);
  }
  
  try {
    const ppUrl = await (socket as any).profilePictureUrl?.(jid, 'image').catch(() => null);
    if (ppUrl) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000); // 10s timeout for photo
      try {
        const res = await fetch(ppUrl, { signal: controller.signal });
        if (res.ok) photoBuffer = Buffer.from(await res.arrayBuffer());
      } finally {
        clearTimeout(timeout);
      }
    }
  } catch (err) {
    logger.debug(`[ConnectedNotify] Photo fetch error: ${String(err)}`);
  }
  return { name, photoBuffer };
}

// ── Build Notification Content ────────────────────────────

function escapeHtml(s: string): string {
  return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function buildTelegramText(opts: {
  name: string;
  phone: string;
  sessionId: string;
  method: string;
}): string {
  const { name, phone, sessionId, method } = opts;
  return [
    `🟢 <b>Session Connected!</b>`,
    ``,
    `👤 <b>Name:</b> ${escapeHtml(name)}`,
    `📱 <b>Number:</b> <code>${escapeHtml(phone)}</code>`,
    `🔑 <b>Session ID:</b> <code>${escapeHtml(sessionId)}</code>`,
    `🔗 <b>Method:</b> ${escapeHtml(method)}`,
    `⏰ <b>Time:</b> ${new Date().toLocaleString()}`,
    `⚡ <b>Status:</b> ACTIVE`,
    `🤖 <b>Engine:</b> OMEGA CORE`,
    ``,
    `<blockquote>Ready for WhatsApp commands. Use the menu below to manage this session.</blockquote>`,
  ].join('\n');
}

function buildWhatsAppText(opts: {
  name: string;
  phone: string;
  sessionName: string;
}): string {
  return [
    `━━━━━━━━━━━━━━━━━━`,
    `✅ SESSION CONNECTED`,
    ``,
    `Your WhatsApp has been connected successfully.`,
    ``,
    `Session:`,
    opts.sessionName,
    ``,
    `Status:`,
    `🟢 ACTIVE`,
    ``,
    `Commands:`,
    `.prefix menu`,
    ``,
    `Engine:`,
    `OMEGA CORE`,
    `━━━━━━━━━━━━━━━━━━`,
  ].join('\n');
}

// ── Notification Delivery Pipeline ─────────────────────────

/**
 * Robust, fully awaited notification pipeline.
 * Ensures delivery of both Telegram and WhatsApp notifications.
 */
export async function notifySessionConnected(opts: ConnectedNotification): Promise<void> {
  const { sessionId, method, telegramId: userIdParam } = opts as any;
  const telegramId = opts.ownerTelegramId || userIdParam || findSessionOwner(sessionId);
  
  if (!telegramId) {
    logger.warn('[ConnectedNotify] Could not find owner for session', { sessionId });
    return;
  }

  // 1. Delivery Tracking
  const meta = loadSessionMeta(telegramId, sessionId);
  if (meta?.notificationDelivered && !opts.force) {
    logger.info('[ConnectedNotify] Already delivered. Skipping.', { sessionId });
    return;
  }

  try {
    logger.info('[ConnectedNotify] Starting notification delivery...', { sessionId });

    // A. Prepare Data
    let name = opts.label || opts.phone;
    let photoBuffer: Buffer | null = null;
    let sessionName = meta?.sessionName || opts.label || 'Main';

    if (opts.socket) {
      const ownJid = (opts.socket as any).user?.id;
      if (ownJid) {
        // Await profile fetch
        const profile = await fetchWAProfile(opts.socket, ownJid);
        name = profile.name !== 'Unknown' ? profile.name : name;
        photoBuffer = profile.photoBuffer;
      }
    }

    // B. WhatsApp Notification (Self-DM)
    // Baileys sets socket.user after the 'open' event but the assignment is
    // synchronous — a brief wait ensures it is populated before we read it,
    // especially when the IIFE fires right at the moment connection opens.
    if (opts.socket) {
      try {
        // Retry up to 5 times (3s apart) waiting for socket.user to be set.
        let ownJid: string | undefined;
        for (let attempt = 0; attempt < 5; attempt++) {
          ownJid = (opts.socket as any).user?.id;
          if (ownJid) break;
          await new Promise<void>((r) => setTimeout(r, 3_000));
        }

        if (ownJid) {
          const waText = buildWhatsAppText({ name, phone: opts.phone, sessionName });
          await opts.socket.sendMessage(ownJid, { text: waText });
          logger.info('[ConnectedNotify] WhatsApp DM delivered', { sessionId });
        } else {
          logger.warn('[ConnectedNotify] socket.user.id not available after retries — WhatsApp DM skipped', { sessionId });
        }
      } catch (err) {
        logger.warn('[ConnectedNotify] WhatsApp DM failed', { err: String(err), sessionId });
      }
    }

    // C. Telegram Notification
    // We await this to ensure it's sent
    if (opts.telegram && opts.telegramChatId) {
      try {
        const tgText = buildTelegramText({ name, phone: opts.phone, sessionId, method });
        const tg = opts.telegram;
        const chatId = opts.telegramChatId;

        if (opts.progressMsgId) {
          // Edit progress message
          await tg.editMessageText(chatId, opts.progressMsgId, undefined, tgText, {
            parse_mode: 'HTML',
            reply_markup: opts.replyMarkup,
          } as any).catch(async (editErr) => {
            logger.debug(`[ConnectedNotify] TG Edit failed, sending new message: ${String(editErr)}`);
            // Fallback to new message
            return tg.sendMessage(chatId, tgText, {
              parse_mode: 'HTML',
              reply_markup: opts.replyMarkup,
            });
          });
        } else {
          // Send new message
          if (photoBuffer) {
            await tg.sendPhoto(chatId, { source: photoBuffer }, {
              caption: tgText,
              parse_mode: 'HTML',
              reply_markup: opts.replyMarkup,
            });
          } else {
            await tg.sendMessage(chatId, tgText, {
              parse_mode: 'HTML',
              reply_markup: opts.replyMarkup,
            });
          }
        }
        logger.info('[ConnectedNotify] Telegram notification delivered', { sessionId });
      } catch (err) {
        logger.warn('[ConnectedNotify] Telegram notification failed', { err: String(err), sessionId });
      }
    }

    // D. Mark as Delivered
    updateSessionMeta(telegramId, sessionId, { notificationDelivered: true });
    logger.info('[ConnectedNotify] Delivery pipeline finished successfully.', { sessionId });

  } catch (err) {
    logger.error('[ConnectedNotify] Fatal delivery error', { 
      err: err instanceof Error ? err.message : String(err),
      sessionId 
    });
  }
}
