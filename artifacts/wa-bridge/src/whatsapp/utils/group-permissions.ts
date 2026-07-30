// ============================================================
// WA-Bridge — Group Permission Utilities
// Single source of truth for:
//   • Fetching group metadata + participant admin state
//   • Determining whether the bot is an admin
//   • Deciding whether a participant is "protected" from
//     automated moderation (admin / owner / bot / sudo)
//   • Resolving a real WhatsApp JID from a LID
//
// Imported by: anti-system engine, group-moderation commands
// ============================================================

import type { BridgeWASocket as WASocket } from '../baileys-types.js';
import { logger } from '../../utils/logger.js';

// ── Types ──────────────────────────────────────────────────

export interface GroupParticipant {
  id: string;
  admin: 'admin' | 'superadmin' | null;
  phoneNumber?: string;
}

export interface ResolvedGroupMeta {
  /** Bot's own JID — device suffix stripped */
  botJid: string;
  /** True when the bot has admin or superadmin in this group */
  botIsAdmin: boolean;
  /** Full participant list as returned by groupMetadata */
  participants: GroupParticipant[];
  /** Group display name */
  subject: string;
}

// ── Internal helpers ───────────────────────────────────────

export function stripDeviceSuffix(jid: string): string {
  const atIdx = jid.indexOf('@');
  if (atIdx === -1) return jid;
  return `${jid.slice(0, atIdx).split(':')[0]}@${jid.slice(atIdx + 1)}`;
}

/** Extract the numeric user-part of any JID variant. */
export function numericId(jid: string): string {
  return jid.split('@')[0]?.split(':')[0] ?? '';
}

// ── Core fetch ─────────────────────────────────────────────

/**
 * Fetch group metadata and resolve the bot's admin status.
 * Returns null if the group cannot be reached or an error occurs.
 */
export async function fetchGroupMeta(
  socket: WASocket,
  groupJid: string
): Promise<ResolvedGroupMeta | null> {
  try {
    const meta = await (socket as unknown as {
      groupMetadata(jid: string): Promise<{
        subject?: string;
        participants: {
          id: string;
          admin?: 'admin' | 'superadmin' | null;
          phoneNumber?: string;
        }[];
      }>;
    }).groupMetadata(groupJid);

    const rawBotJid = (socket as unknown as { user?: { id?: string } }).user?.id ?? '';
    const botJid = stripDeviceSuffix(rawBotJid);
    const botNum = numericId(botJid);

    const participants: GroupParticipant[] = (meta.participants ?? []).map((p) => ({
      id: p.id,
      admin: p.admin ?? null,
      phoneNumber: p.phoneNumber,
    }));

    const botParticipant = participants.find((p) => numericId(p.id) === botNum);
    const botIsAdmin =
      botParticipant?.admin === 'admin' || botParticipant?.admin === 'superadmin';

    return {
      botJid,
      botIsAdmin,
      participants,
      subject: meta.subject ?? groupJid.split('@')[0] ?? 'Group',
    };
  } catch (err) {
    logger.warn('[GroupPermissions] fetchGroupMeta failed', { err: String(err), groupJid });
    return null;
  }
}

// ── Permission checks ──────────────────────────────────────

/**
 * Check whether a JID (real, LID, or device-suffixed) belongs to an admin
 * by comparing the numeric user-part against the participant list.
 */
export function isAdminJid(
  participants: GroupParticipant[],
  jid: string
): boolean {
  const targetNum = numericId(jid);
  if (!targetNum) return false;
  return participants.some(
    (p) =>
      numericId(p.id) === targetNum &&
      (p.admin === 'admin' || p.admin === 'superadmin')
  );
}

/**
 * Returns true if the JID must never receive automated moderation actions.
 *
 * Protected = group admin/owner  OR  the bot itself  OR  a sudo-listed number.
 */
export function isProtectedJid(
  meta: ResolvedGroupMeta,
  jid: string,
  sudoNumbers?: string[]
): boolean {
  const targetNum = numericId(jid);
  if (!targetNum) return false;

  // Always protect the bot
  if (numericId(meta.botJid) === targetNum) return true;

  // Group admin or owner
  if (isAdminJid(meta.participants, jid)) return true;

  // Global sudo numbers
  if (sudoNumbers?.length) {
    if (sudoNumbers.some((n) => n.replace(/\D/g, '') === targetNum)) return true;
  }

  return false;
}

// ── LID resolution ─────────────────────────────────────────

/**
 * Given a raw JID that may be a Linked-Device ID (@lid), try to find the
 * corresponding real WA JID (@s.whatsapp.net) in the participant list.
 *
 * Baileys may expose a `phoneNumber` field on the LID participant entry which
 * lets us cross-reference.  If nothing matches, the original JID is returned
 * unchanged so the caller can decide how to proceed.
 */
export function resolveRealJidFromMeta(
  participants: GroupParticipant[],
  rawJid: string
): string {
  const clean = stripDeviceSuffix(rawJid);
  if (!clean.endsWith('@lid')) return clean;

  const lidNum = numericId(rawJid);

  // Try to match via the phoneNumber field that Baileys populates for LID entries
  const byPhone = participants.find(
    (p) =>
      !p.id.endsWith('@lid') &&
      (p.phoneNumber ?? '').replace(/\D/g, '') === lidNum
  );
  if (byPhone) return stripDeviceSuffix(byPhone.id);

  // Can't resolve — return as-is; caller should treat as unresolvable
  return clean;
}

/**
 * Convenience: given a raw sender JID (possibly LID / device-suffixed),
 * return the best-effort real JID from the participant list.
 */
export function bestRealJid(
  participants: GroupParticipant[],
  rawJid: string
): string {
  const stripped = stripDeviceSuffix(rawJid);
  if (stripped.endsWith('@lid')) {
    return resolveRealJidFromMeta(participants, rawJid);
  }
  return stripped;
}

// ── Bot admin message helper ───────────────────────────────

/** Standard error message when the bot is not a group admin. */
export const BOT_NOT_ADMIN_MSG =
  '⚠️ I need to be a group admin before this feature can work.\n' +
  'Please promote me to admin and try again.';
