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
  return user.replace(/\D/g, '');
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

  // rawTarget is already a full JID — strip device suffix and return
  if (rawTarget.includes('@') && !isLid(rawTarget)) {
    return { jid: stripDeviceSuffix(rawTarget), number };
  }

  // If given a LID, still try to resolve against the participant list
  const isLidInput = rawTarget.includes('@') && isLid(rawTarget);

  // Resolve real JID from the live group participant list
  if (socket && groupJid?.endsWith('@g.us')) {
    try {
      const meta = await (socket as unknown as {
        groupMetadata(jid: string): Promise<{
          participants: { id: string; phoneNumber?: string }[];
        }>;
      }).groupMetadata(groupJid);

      const member = meta.participants.find((p) => {
        if (isLidInput) {
          // Match by LID directly
          return p.id === rawTarget || isLid(p.id);
        }
        const pNum = (p.id.split('@')[0] ?? '').split(':')[0];
        const pPhone = (p.phoneNumber ?? '').replace(/\D/g, '');
        return pNum === number || pPhone === number;
      });

      if (member) {
        // Distinguish between real JID and LID
        const isRealJid = !isLid(member.id);
        const lid = isLid(member.id) ? member.id : undefined;

        // Try to find the real JID if the matched entry was a LID
        if (!isRealJid) {
          const realMember = meta.participants.find((p) => !isLid(p.id) && normalizeNumber(p.id) === number);
          const jid = realMember
            ? stripDeviceSuffix(realMember.id)
            : `${number}@s.whatsapp.net`;
          return { jid, number, lid };
        }

        const jid = stripDeviceSuffix(member.id);
        return { jid, number };
      }
    } catch {
      // Fall through to plain JID construction
    }
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
