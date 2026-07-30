// ============================================================
// WA-Bridge — Universal Target Resolver
// One centralized resolver for every command that targets a
// WhatsApp user.  Supports all four input methods:
//   1. Quoted message sender  (highest priority)
//   2. @mention
//   3. Phone number in args
//   4. Full JID in args
// Import this instead of writing per-command targeting logic.
// ============================================================

import type { BridgeWASocket as WASocket, WebMessageInfo, MessageContextInfo } from '../baileys-types.js';
import type { ResolvedGroupMeta, GroupParticipant } from './group-permissions.js';

// ── Types ─────────────────────────────────────────────────

export interface ResolvedTarget {
  /** Full WhatsApp JID, e.g. 2348012345678@s.whatsapp.net (never a LID) */
  jid: string;
  /** Normalized phone number without domain, e.g. 2348012345678 */
  number: string;
  /**
   * LID if the participant entry uses a LID domain (@lid).
   * Displayed separately — never used in place of the real JID.
   */
  lid?: string;
  /** Matching live group participant, when group metadata was available. */
  participant?: GroupParticipant;
}

// ── Internal helpers ──────────────────────────────────────

/**
 * Normalize any WhatsApp identifier to a plain phone number string.
 * Strips the domain, device suffix, and all non-digit characters.
 * Mirrors event-handlers.ts:normalizeWhatsAppNumber — kept independent
 * here to avoid circular imports.
 */
export function normalizeNumber(value: string | null | undefined): string {
  if (!value) return '';
  const user = value.split('@')[0]!.split(':')[0]!;
  const digits = user.replace(/\D/g, '');
  // Nigerian local format: exactly 11 digits starting with 0 (0XXXXXXXXXX → 234XXXXXXXXX).
  // Restricted to 11 digits only — do not rewrite local numbers from other countries.
  if (/^0\d{10}$/.test(digits)) return `234${digits.slice(1)}`;
  return digits;
}

/** Extract contextInfo from all supported message types. */
function extractContextInfo(msg: WebMessageInfo): MessageContextInfo | null | undefined {
  return (
    msg.message?.extendedTextMessage?.contextInfo ??
    msg.message?.imageMessage?.contextInfo ??
    msg.message?.videoMessage?.contextInfo
  );
}

/**
 * Strip the device-suffix component from a JID while keeping the domain.
 * e.g. "2348012345678:7@s.whatsapp.net" → "2348012345678@s.whatsapp.net"
 */
function stripDeviceSuffix(jid: string): string {
  const atIdx = jid.indexOf('@');
  if (atIdx === -1) return jid;
  const user = jid.slice(0, atIdx);
  const domain = jid.slice(atIdx + 1);
  return `${user.split(':')[0]}@${domain}`;
}

/** Returns true if the JID is a LID (linked-device identifier, not a real WA number). */
function isLid(jid: string): boolean {
  return jid.endsWith('@lid');
}

// ── Core resolver ─────────────────────────────────────────

/**
 * Universal async resolver — returns a full ResolvedTarget or null.
 *
 * Provide `socket` + `groupJid` to resolve the real JID from the live
 * group participant list (handles device-suffix variants).  If they are
 * omitted the resolver falls back to constructing
 * `${number}@s.whatsapp.net` directly.
 *
 * Priority:
 *   1. Quoted message sender
 *   2. @mention (first JID in mentionedJid)
 *   3. Explicit arg  (phone number OR full JID)
 */
export async function resolveTarget(
  args: string[],
  msg: WebMessageInfo,
  socket?: WASocket,
  groupJid?: string,
  existingMeta?: ResolvedGroupMeta | null,
): Promise<ResolvedTarget | null> {
  const ci = extractContextInfo(msg);

  let rawTarget = '';

  // 1. Quoted message sender
  if (ci?.participant) {
    rawTarget = ci.participant;
  }
  // 2. @mentioned JID — first in list
  else if (ci?.mentionedJid?.length) {
    rawTarget = (ci.mentionedJid as string[])[0] ?? '';
  }
  // 3. Explicit arg (phone number or JID)
  else if (args[0]) {
    rawTarget = args[0];
  }

  if (!rawTarget) return null;

  const number = normalizeNumber(rawTarget);
  if (!number || number.length < 7) return null;

  const isLidInput = rawTarget.includes('@') && isLid(rawTarget);

  // Resolve from the live group participant list before returning a constructed
  // JID. This prevents +234/234/090 inputs from being reported as absent when
  // Baileys exposes participants with device suffixes or phoneNumber fields.
  if (groupJid?.endsWith('@g.us')) {
    try {
      const meta = existingMeta ?? (socket ? await (socket as unknown as {
        groupMetadata(jid: string): Promise<{ participants: GroupParticipant[] }>;
      }).groupMetadata(groupJid) as ResolvedGroupMeta : null);

      const participants = meta?.participants ?? [];
      const member = participants.find((p) => {
        const pId = stripDeviceSuffix(p.id);
        if (isLidInput) return pId === stripDeviceSuffix(rawTarget);
        if (rawTarget.includes('@') && pId === stripDeviceSuffix(rawTarget)) return true;
        // Never treat LID digits as a phone number — only compare real participants.
        if (p.id.endsWith('@lid')) return false;
        const pNum = normalizeNumber(p.id);
        const pPhone = normalizeNumber(p.phoneNumber);
        return pNum === number || pPhone === number;
      });

      if (member) {
        const lid = isLid(member.id) ? stripDeviceSuffix(member.id) : undefined;
        return { jid: stripDeviceSuffix(member.id), number: normalizeNumber(member.phoneNumber) || number, lid, participant: member };
      }
    } catch (err) {
      // Log resolution errors so live-lookup failures are observable.
      // Fall through to plain JID construction for non-moderation callers.
      const resolveErr = err instanceof Error ? err.message : String(err);
      // Use console to avoid circular import risk with the logger at this layer.
      // eslint-disable-next-line no-console
      console.warn('[resolveTarget] groupMetadata lookup failed:', resolveErr);
    }
  }

  // A LID input that was not resolved to a real participant must not have a phone JID
  // fabricated from its digits — LID digits are NOT phone numbers.
  if (isLidInput) return null;

  if (rawTarget.includes('@')) {
    return { jid: stripDeviceSuffix(rawTarget), number };
  }
  return { jid: `${number}@s.whatsapp.net`, number };
}

// ── Sync variant for permit / warn / ban commands ─────────

/**
 * Lightweight synchronous resolver — returns a normalized phone number or null.
 * Use this for commands that only need the number (ban list, warn counts,
 * permit lists) where a socket call is unnecessary.
 *
 * Priority: explicit arg → quoted message sender → @mention
 */
export function resolveTargetNumber(args: string[], msg: WebMessageInfo): string | null {
  const ci = extractContextInfo(msg);

  // 1. Explicit arg
  if (args[0]) {
    const n = normalizeNumber(args[0]);
    if (n.length >= 7) return n;
  }
  // 2. Quoted message sender
  if (ci?.participant) {
    const n = normalizeNumber(ci.participant);
    if (n.length >= 7) return n;
  }
  // 3. @mentioned JID
  if (ci?.mentionedJid?.length) {
    const n = normalizeNumber((ci.mentionedJid as string[])[0] ?? '');
    if (n.length >= 7) return n;
  }

  return null;
}

// ── Multi-target variant for sudo management ─────────────

/**
 * Resolve one or more target numbers for sudo/owner management.
 * Multiple phone numbers may be given as space-separated args.
 *
 * Priority: explicit args (all of them) → quoted sender → @mentions (all)
 */
export function resolveTargetNumbers(args: string[], msg: WebMessageInfo): string[] {
  // 1. Raw phone numbers / JIDs in args
  if (args.length > 0) {
    const numbers = args
      .map((a) => normalizeNumber(a))
      .filter((n) => n.length >= 7);
    if (numbers.length > 0) return numbers;
  }

  const ci = extractContextInfo(msg);

  // 2. Quoted message sender
  if (ci?.participant) {
    const n = normalizeNumber(ci.participant);
    if (n.length >= 7) return [n];
  }

  // 3. @mentioned JIDs (all of them)
  if (ci?.mentionedJid?.length) {
    const numbers = (ci.mentionedJid as string[])
      .map((jid) => normalizeNumber(jid))
      .filter((n) => n.length >= 7);
    if (numbers.length > 0) return numbers;
  }

  return [];
}
