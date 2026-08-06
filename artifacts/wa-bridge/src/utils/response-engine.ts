// ============================================================
// WA-Bridge — Shared Response Template Engine
// Centralised variable parser used by every feature that sends
// formatted messages: Anti System, moderation commands,
// welcome/goodbye events, and custom response templates.
//
// Supported variables:
//   @mention       → @<phone_number>
//   &gcname        → group subject
//   &desc          → group description
//   &getpp         → sender profile picture URL
//   &pp            → sender profile picture (attached as media by callers)
//   &membercount   → current member count
//   &admincount    → current admin count
//   &date          → current date (configured timezone)
//   &time          → current time (configured timezone)
//
// TIMEZONE: all date/time rendering honours OMEGA_TZ (then TZ, then
// the server's local zone). This fixes previews being ~1h off when the
// host runs UTC but the operator lives in UTC+1.
// ============================================================

import type { BridgeWASocket as WASocket } from '../whatsapp/baileys-types.js';
import { fetchGroupMeta } from '../whatsapp/utils/group-permissions.js';
import { resolveMention } from '../whatsapp/utils/mention-engine.js';

export interface ResponseContext {
  senderJid: string;
  gcName: string;
  socket: WASocket;
  groupJid: string;
  /**
   * Explicit real-phone number used for @mention / @user.
   *
   * When provided it takes precedence over anything derived from senderJid.
   * This is how callers guarantee the mention NEVER leaks a LID even when
   * senderJid is an unresolved @lid JID.
   */
  mentionNumber?: string;
}

/**
 * Digits to use for @mention — real phone only.
 * A LID senderJid must never contribute its digits (LID ≠ phone number).
 */
function mentionDigits(senderJid: string, mentionNumber?: string): string {
  if (mentionNumber) {
    const d = String(mentionNumber).replace(/\D/g, '');
    if (d) return d;
  }
  if (!senderJid || String(senderJid).endsWith('@lid')) return '';
  const user = String(senderJid).split('@')[0]?.split(':')[0] ?? '';
  return user.replace(/\D/g, '');
}

/** The configured timezone (OMEGA_TZ → TZ → server default). */
export function configuredTimeZone(): string | undefined {
  const tz = process.env.OMEGA_TZ ?? process.env.TZ;
  return tz && tz.trim() ? tz.trim() : undefined;
}

/** Format a date in the configured timezone. Falls back to locale string. */
export function formatInTimeZone(
  date: Date,
  options: Intl.DateTimeFormatOptions
): string {
  const tz = configuredTimeZone();
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: tz, ...options }).format(date);
  } catch {
    return new Intl.DateTimeFormat('en-US', options).format(date);
  }
}

/** Current date string in the configured timezone. */
export function currentDateString(): string {
  return formatInTimeZone(new Date(), { year: 'numeric', month: 'short', day: 'numeric' });
}

/** Current time string (24h) in the configured timezone. */
export function currentTimeString(): string {
  return formatInTimeZone(new Date(), { hour: '2-digit', minute: '2-digit', hour12: false });
}

/** True when the template contains a given variable token (e.g. 'pp'). */
export function hasTemplateVariable(template: string, token: string): boolean {
  if (!template) return false;
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`&${escaped}`, 'i').test(template);
}

/**
 * Render a response template string, substituting all supported variables.
 * Async because &desc, &getpp, &membercount, &admincount may require network calls.
 */
export async function renderTemplate(
  template: string,
  ctx: ResponseContext
): Promise<string> {
  const { senderJid, gcName, socket, groupJid } = ctx;

  // @mention / @user — real phone number only. When the identity is a LID
  // and no explicit mentionNumber was resolved, the token is left untouched
  // rather than leaking the LID digits.
  const mention = mentionDigits(senderJid, ctx.mentionNumber);
  const mentionText = mention ? `@${mention}` : '@mention';
  const userText = mention ? `@${mention}` : '@user';

  let result = template;

  // ── Synchronous substitutions ─────────────────────────────
  // Standard variables
  result = result.replace(/@mention/gi, mentionText);
  result = result.replace(/&gcname/gi, gcName);
  result = result.replace(/&date/gi, currentDateString());
  result = result.replace(/&time/gi, currentTimeString());

  // User requested aliases
  result = result.replace(/@user/gi, userText);
  result = result.replace(/@group/gi, gcName);

  // Profile picture placeholders are removed from the text here; callers
  // that can attach media detect &pp / &getpp beforehand via
  // hasTemplateVariable and attach the image (see welcome/goodbye/preview).
  result = result.replace(/&pp/gi, '');
  result = result.replace(/&getpp/gi, '');

  // ── Group metadata (single fetch for desc + counts) ───────
  const needsMeta =
    result.includes('&desc') ||
    result.includes('&membercount') ||
    result.includes('&admincount') ||
    result.includes('@count');
  if (needsMeta) {
    try {
      const meta = await fetchGroupMeta(socket, groupJid);

      result = result.replace(/&desc/gi, meta?.desc ?? '');
      result = result.replace(/&membercount/gi, String(meta?.participants.length ?? 0));
      result = result.replace(/@count/gi, String(meta?.participants.length ?? 0));
      result = result.replace(/&admincount/gi,
        String(meta?.participants.filter((p) => p.admin).length ?? 0)
      );
    } catch {
      result = result.replace(/&desc/gi, '');
      result = result.replace(/&membercount/gi, '?');
      result = result.replace(/@count/gi, '?');
      result = result.replace(/&admincount/gi, '?');
    }
  }

  return result;
}

/**
 * Render a response template AND return the mentionedJid array that stays
 * in sync with the rendered text (native WhatsApp mentions).
 *
 * The sender identity is resolved through the central Mention Engine
 * (LID → real phone JID), so @mention/@user never leak LID digits and the
 * returned mentions array always carries the real phone JID.
 */
export async function renderTemplateWithMentions(
  template: string,
  ctx: ResponseContext
): Promise<{ text: string; mentions: string[] }> {
  let participants: { id: string; phoneNumber?: string }[] | null = null;
  try {
    const meta = await fetchGroupMeta(ctx.socket, ctx.groupJid).catch(() => null);
    participants = meta?.participants ?? null;
  } catch {
    /* non-critical */
  }

  const mention = await resolveMention(ctx.socket, {
    jid: ctx.senderJid,
    participants,
  });

  const text = await renderTemplate(template, {
    ...ctx,
    senderJid: mention.jid || ctx.senderJid,
    mentionNumber: mention.number || ctx.mentionNumber,
  });

  const mentions = mention.jid ? [mention.jid] : [];

  // When the identity could not be resolved to a phone number, strip the
  // template tokens instead of leaking a raw '@mention' / '@<lid>' string.
  if (!mention.jid) {
    const cleaned = text
      .replace(/@mention/gi, '')
      .replace(/@user/gi, '')
      .replace(/[ \t]{2,}/g, ' ')
      .trim();
    return { text: cleaned, mentions };
  }

  return { text, mentions };
}

/**
 * Render a LIVE preview of a response template, simulating the event with a
 * real example member (usually the command sender).
 *
 * Used by .setwelcome / .setgoodbye / .setkickmsg / .setwarnmsg / .setbanmsg
 * so the admin sees EXACTLY what members will receive — not a raw echo of the
 * template. The sender is used as the example member for @mention / &pp.
 */
export async function renderTemplatePreview(
  template: string,
  socket: WASocket,
  groupJid: string,
  senderJid: string
): Promise<string> {
  let gcName = groupJid.split('@')[0] ?? 'Group';
  try {
    const meta = await socket.groupMetadata(groupJid);
    if (meta?.subject) gcName = meta.subject;
  } catch { /* keep fallback */ }
  return renderTemplate(template, { senderJid, gcName, socket, groupJid });
}
