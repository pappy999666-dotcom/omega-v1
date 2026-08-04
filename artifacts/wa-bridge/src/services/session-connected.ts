// ============================================================
// WA-Bridge — Robust Session Connected Notification Service
//
// Production-grade, non-blocking notification pipeline.
// Replaces fragile implementations with asynchronous background delivery.
// ============================================================

import type { BridgeWASocket as WASocket } from '../whatsapp/baileys-types.js';
import { connectedCard } from '../utils/ascii-art.js';
import { logger } from '../utils/logger.js';
import { PreviewManager } from '../preview-engine/index.js';
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
    const info = await (socket as any).fetchBusinessProfile?.(jid).catch(() => null);
    if (info?.name) name = info.name;
    else {
      const contacts = (socket as any).store?.contacts;
      const contact = contacts?.[jid];
      if (contact?.name) name = contact.name;
      else if (contact?.notify) name = contact.notify;
    }
  } catch { /* ignore */ }
  
  try {
    const ppUrl = await (socket as any).profilePictureUrl?.(jid, 'image').catch(() => null);
    if (ppUrl) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      try {
        const res = await fetch(ppUrl, { signal: controller.signal });
        if (res.ok) photoBuffer = Buffer.from(await res.arrayBuffer());
      } finally {
        clearTimeout(timeout);
      }
    }
  } catch { /* ignore */ }
  return { name, photoBuffer };
}

// ── Build Notification Content ────────────────────────────

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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
    `╭━━━〔 ✅ SESSION CONNECTED 〕━━━╮`,
    `┃`,
    `┃ 🎉 Your session is now online.`,
    `┃`,
    `┃ 📱 Number:`,
    `┃ ${opts.phone}`,
    `┃`,
    `┃ 🆔 Session:`,
    `┃ ${opts.sessionName}`,
    `┃`,
    `┃ ⚡ Status:`,
    `┃ ACTIVE`,
    `┃`,
    `┃ 🤖 Engine:`,
    `┃ OMEGA CORE`,
    `┃`,
    `┃ You can now use all WhatsApp commands.`,
    `┃`,
    `╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╯`
  ].join('\n');
}

// ── Notification Delivery Pipeline ─────────────────────────

/**
 * Robust, non-blocking notification pipeline.
 * Implements the "Session Connected" redesign requirements.
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

  // 2. Async Execution (Non-blocking)
  // We don't 'await' the delivery so it doesn't block the caller (authentication flow)
  (async () => {
    try {
      logger.info('[ConnectedNotify] Starting delivery pipeline...', { sessionId });

      // A. Prepare Data
      let name = opts.label || opts.phone;
      let photoBuffer: Buffer | null = null;
      let sessionName = meta?.sessionName || opts.label || 'Main';

      if (opts.socket) {
        const ownJid = (opts.socket as any).user?.id;
        if (ownJid) {
          const profile = await fetchWAProfile(opts.socket, ownJid);
          name = profile.name !== 'Unknown' ? profile.name : name;
          photoBuffer = profile.photoBuffer;
        }
      }

      // B. WhatsApp Notification (Self-DM)
      if (opts.socket) {
        try {
          const ownJid = (opts.socket as any).user?.id;
          if (ownJid) {
            const waText = buildWhatsAppText({ name, phone: opts.phone, sessionName });
            await opts.socket.sendMessage(ownJid, { text: waText });
            logger.info('[ConnectedNotify] WhatsApp DM delivered', { sessionId });
          }
        } catch (err) {
          logger.warn('[ConnectedNotify] WhatsApp DM failed', { err: String(err), sessionId });
        }
      }

      // C. Telegram Notification
      if (opts.telegram && opts.telegramChatId) {
        try {
          const tgText = buildTelegramText({ name, phone: opts.phone, sessionId, method });
          const tg = opts.telegram;
          const chatId = opts.telegramChatId;

          if (opts.progressMsgId) {
            await tg.editMessageText(chatId, opts.progressMsgId, undefined, tgText, {
              parse_mode: 'HTML',
              reply_markup: opts.replyMarkup,
            } as any).catch(() => {
              // Fallback to new message if edit fails
              return tg.sendMessage(chatId, tgText, {
                parse_mode: 'HTML',
                reply_markup: opts.replyMarkup,
              });
            });
          } else {
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
      logger.info('[ConnectedNotify] Pipeline complete.', { sessionId });

    } catch (err) {
      logger.error('[ConnectedNotify] Fatal pipeline error', { 
        err: err instanceof Error ? err.message : String(err),
        sessionId 
      });
    }
  })().catch(err => logger.error('[ConnectedNotify] Background task failed', { err: String(err) }));
}
