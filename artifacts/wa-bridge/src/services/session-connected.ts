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

    // A. Prepare shared data (name, sessionName) — profile fetch runs here so both
    //    channels can use the result, but we don't wait for socket.user before
    //    starting the Telegram send (see parallel section below).
    let name = opts.label || opts.phone;
    let sessionName = meta?.sessionName || opts.label || 'Main';

    // B. WhatsApp self-DM + Telegram run in parallel.
    //
    //    WA self-DM: socket.user.id may not be populated the instant 'open' fires.
    //    We retry up to 5 × 3 s = 15 s max, but this runs CONCURRENTLY with the
    //    Telegram send so Telegram is never blocked behind this wait.
    //
    //    Telegram delivery is the authoritative success signal.  We only set
    //    notificationDelivered after a successful Telegram send (or when Telegram
    //    is not configured, after WA DM succeeds) to prevent a transient failure
    //    from permanently suppressing future notifications.

    const waPromise: Promise<void> = opts.socket
      ? (async () => {
          try {
            // Resolve socket.user.id with retries
            let ownJid: string | undefined;
            for (let attempt = 0; attempt < 5; attempt++) {
              ownJid = (opts.socket as any)?.user?.id;
              if (ownJid) break;
              await new Promise<void>((r) => setTimeout(r, 3_000));
            }
            if (!ownJid) {
              logger.warn('[ConnectedNotify] socket.user.id not available after retries — WhatsApp DM skipped', { sessionId });
              return;
            }
            // Fetch profile once we have the JID
            const profile = await fetchWAProfile(opts.socket!, ownJid);
            const resolvedName = profile.name !== 'Unknown' ? profile.name : name;
            const waText = buildWhatsAppText({ name: resolvedName, phone: opts.phone, sessionName });
            await opts.socket!.sendMessage(ownJid, { text: waText });
            logger.info('[ConnectedNotify] WhatsApp DM delivered', { sessionId });
          } catch (err) {
            logger.warn('[ConnectedNotify] WhatsApp DM failed', { err: String(err), sessionId });
          }
        })()
      : Promise.resolve();

    // Telegram send with bounded retry (3 attempts, exponential backoff)
    let telegramDelivered = false;
    if (opts.telegram && opts.telegramChatId) {
      const tgText = buildTelegramText({ name, phone: opts.phone, sessionId, method });
      const tg = opts.telegram;
      const chatId = opts.telegramChatId;

      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          if (attempt > 0) {
            await new Promise<void>((r) => setTimeout(r, Math.min(5_000 * attempt, 10_000)));
          }

          if (opts.progressMsgId) {
            await tg.editMessageText(chatId, opts.progressMsgId, undefined, tgText, {
              parse_mode: 'HTML',
              reply_markup: opts.replyMarkup,
            } as any).catch(async (editErr: unknown) => {
              logger.debug(`[ConnectedNotify] TG Edit failed, sending new message: ${String(editErr)}`);
              return tg.sendMessage(chatId, tgText, {
                parse_mode: 'HTML',
                reply_markup: opts.replyMarkup,
              });
            });
          } else {
            // Fetch photo for first attempt only (avoid redundant fetches on retry)
            let photoBuffer: Buffer | null = null;
            if (attempt === 0 && opts.socket) {
              const ownJid = (opts.socket as any)?.user?.id;
              if (ownJid) {
                try {
                  const profile = await fetchWAProfile(opts.socket, ownJid);
                  name = profile.name !== 'Unknown' ? profile.name : name;
                  photoBuffer = profile.photoBuffer;
                } catch { /* ignore — use text-only fallback */ }
              }
            }

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

          telegramDelivered = true;
          logger.info('[ConnectedNotify] Telegram notification delivered', { sessionId, attempt });
          break; // success
        } catch (err) {
          logger.warn(`[ConnectedNotify] Telegram attempt ${attempt + 1} failed`, { err: String(err), sessionId });
        }
      }

      if (!telegramDelivered) {
        logger.warn('[ConnectedNotify] All Telegram attempts failed — notificationDelivered will NOT be set', { sessionId });
      }
    }

    // Wait for the WA DM to finish (it may still be in the retry loop)
    await waPromise;

    // C. Mark as delivered ONLY after successful Telegram send.
    //    If Telegram is not configured (WA-only mode), mark after WA DM completes.
    const shouldMark = telegramDelivered || (!opts.telegram && opts.socket);
    if (shouldMark) {
      updateSessionMeta(telegramId, sessionId, { notificationDelivered: true });
      logger.info('[ConnectedNotify] Delivery pipeline finished successfully.', { sessionId });
    }

  } catch (err) {
    logger.error('[ConnectedNotify] Fatal delivery error', { 
      err: err instanceof Error ? err.message : String(err),
      sessionId 
    });
  }
}
