// ============================================================
// WA-Bridge — Centralized Session Connected Notification Service
//
// Single source of truth for "session connected" notifications.
// Replaces the three duplicated onConnected blocks in:
//   - telegram/handlers/session.ts (QR, pairing-code, reinit)
//   - whatsapp/event-handlers.ts (pair command)
//
// Responsibilities:
//   1. Fetch WA profile (name + photo)
//   2. Send Telegram notification (with optional photo)
//   3. Send WhatsApp self-DM with connectedCard
// ============================================================

import type { BridgeWASocket as WASocket } from '../whatsapp/baileys-types.js';
import { connectedCard } from '../utils/ascii-art.js';
import { logger } from '../utils/logger.js';
import { PreviewManager } from '../preview-engine/index.js';
import { findSessionOwner } from './workspace.js';

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
}

// ── Fetch WA Profile ──────────────────────────────────────

async function fetchWAProfile(
  socket: WASocket,
  jid: string
): Promise<{ name: string; photoBuffer: Buffer | null }> {
  let name = 'Unknown';
  let photoBuffer: Buffer | null = null;
  try {
    const info = await (socket as unknown as {
      fetchBusinessProfile(jid: string): Promise<{ name?: string } | null>;
    }).fetchBusinessProfile(jid).catch(() => null);
    if (info?.name) name = info.name;
    else {
      const contacts = (socket as unknown as { store?: { contacts?: Record<string, { name?: string; notify?: string }> } }).store?.contacts;
      const contact = contacts?.[jid];
      if (contact?.name) name = contact.name;
      else if (contact?.notify) name = contact.notify;
    }
  } catch { /* ignore */ }
  try {
    const ppUrl = await (socket as unknown as {
      profilePictureUrl(jid: string, type: string): Promise<string | null>;
    }).profilePictureUrl(jid, 'image').catch(() => null);
    if (ppUrl) {
      const res = await fetch(ppUrl);
      if (res.ok) photoBuffer = Buffer.from(await res.arrayBuffer());
    }
  } catch { /* ignore */ }
  return { name, photoBuffer };
}

// ── Build Connected Text ──────────────────────────────────

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function buildConnectedText(opts: {
  name: string;
  phone: string;
  sessionId: string;
  method: string;
  isReinit?: boolean;
}): string {
  const { name, phone, sessionId, method, isReinit } = opts;
  const title = isReinit ? 'Session Reconnected!' : 'Session Connected!';
  const emoji = isReinit ? '🔄' : '🟢';
  return [
    `${emoji} <b>${title}</b>`,
    '',
    `👤 <b>Name:</b> ${escapeHtml(name)}`,
    `📱 <b>Number:</b> <code>${escapeHtml(phone)}</code>`,
    `🔑 <b>Session:</b> <code>${escapeHtml(sessionId)}</code>`,
    `🔗 <b>Method:</b> ${escapeHtml(method)}`,
    `⏰ <b>Paired:</b> ${new Date().toLocaleString()}`,
    '',
    `<blockquote>Ready for WhatsApp commands. Use the menu below to manage this session.</blockquote>`,
  ].join('\n');
}

// ── Send Telegram Notification ────────────────────────────

async function sendTelegramNotification(opts: ConnectedNotification, { name, photoBuffer }: { name: string; photoBuffer: Buffer | null }): Promise<void> {
  if (!opts.telegram || !opts.telegramChatId) return;
  const tg = opts.telegram;
  const chatId = opts.telegramChatId;
  const isReinit = opts.method === 'Reinit';
  const text = buildConnectedText({
    name,
    phone: opts.phone,
    sessionId: opts.sessionId,
    method: opts.method,
    isReinit,
  });

  if (opts.progressMsgId) {
    // Edit existing progress message
    try {
      await tg.editMessageText(chatId, opts.progressMsgId, undefined, text, {
        parse_mode: 'HTML',
        reply_markup: opts.replyMarkup,
      } as any);
    } catch {
      // If edit fails, fall through to new message
    }
  }

  if (!opts.progressMsgId) {
    try {
      if (photoBuffer) {
        await tg.sendPhoto(chatId, { source: photoBuffer }, {
          caption: text,
          parse_mode: 'HTML',
          reply_markup: opts.replyMarkup,
        });
      } else {
        await tg.sendMessage(chatId, text, {
          parse_mode: 'HTML',
          reply_markup: opts.replyMarkup,
        });
      }
    } catch (err) {
      logger.warn('[ConnectedNotify] Telegram send failed', { err: String(err) });
    }
  }

  // Also send to owner's Telegram ID if different from chat
  if (opts.ownerTelegramId && opts.ownerTelegramId !== String(opts.telegramChatId)) {
    try {
      const ownerId = parseInt(opts.ownerTelegramId, 10);
      if (photoBuffer) {
        await tg.sendPhoto(ownerId, { source: photoBuffer }, {
          caption: text,
          parse_mode: 'HTML',
          reply_markup: opts.replyMarkup,
        });
      } else {
        await tg.sendMessage(ownerId, text, {
          parse_mode: 'HTML',
          reply_markup: opts.replyMarkup,
        });
      }
    } catch { /* ignore — same chat or blocked */ }
  }
}

// ── Send WhatsApp Self-DM ─────────────────────────────────

async function sendWhatsAppSelfDM(opts: ConnectedNotification, name: string): Promise<void> {
  if (!opts.socket) return;
  try {
    const ownJid = (opts.socket as unknown as { user?: { id?: string } })?.user?.id;
    if (!ownJid) return;
    
    const telegramId = opts.ownerTelegramId || findSessionOwner(opts.sessionId);
    if (!telegramId) return;

    await PreviewManager.send(opts.socket as any, ownJid, connectedCard({ 
      name, 
      phone: opts.phone, 
      sessionId: opts.sessionId, 
      method: opts.method 
    }), {
      sessionId: opts.sessionId,
      telegramId,
    });
  } catch (err) {
    logger.warn('[ConnectedNotify] WhatsApp self-DM failed', { err: String(err) });
  }
}

// ── Main Entry Point ──────────────────────────────────────

export async function notifySessionConnected(opts: ConnectedNotification): Promise<void> {
  try {
    // 1. Fetch profile
    let name = opts.label || opts.phone;
    let photoBuffer: Buffer | null = null;

    if (opts.socket) {
      const ownJid = (opts.socket as unknown as { user?: { id?: string } })?.user?.id;
      if (ownJid) {
        const profile = await fetchWAProfile(opts.socket, ownJid);
        name = profile.name !== 'Unknown' ? profile.name : (opts.label || opts.phone);
        photoBuffer = profile.photoBuffer;
      }
    }

    // 2. Send Telegram notification (if applicable)
    if (opts.telegram && opts.telegramChatId) {
      await sendTelegramNotification(opts, { name, photoBuffer });
    }

    // 3. Send WhatsApp self-DM (if applicable)
    await sendWhatsAppSelfDM(opts, name);
  } catch (err) {
    logger.error('[ConnectedNotify] Failed to send connected notification', {
      err: err instanceof Error ? err.message : String(err),
      sessionId: opts.sessionId,
    });
  }
}
