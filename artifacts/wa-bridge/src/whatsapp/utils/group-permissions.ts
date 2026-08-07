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
  /** Group description */
  desc?: string;
}

// ── Group Metadata TTL Cache ───────────────────────────────
//
// Keyed by socket (WeakMap → no leak) then groupJid.
// TTL: 30 seconds — short enough to catch role changes, long enough
// to avoid hammering the Baileys API on every Anti System check.
// Call bustGroupMetaCache() after promote/demote/add/remove events.

const META_TTL_MS = 30_000;

const _metaCache = new WeakMap<
  object,
  Map<string, { meta: ResolvedGroupMeta; ts: number }>
>();

function _getPerSocket(
  socket: WASocket
): Map<string, { meta: ResolvedGroupMeta; ts: number }> {
  const key = socket as unknown as object;
  let m = _metaCache.get(key);
  if (!m) {
    m = new Map();
    _metaCache.set(key, m);
  }
  return m;
}

/** Force the next fetchGroupMeta call to bypass the cache for this group. */
export function bustGroupMetaCache(socket: WASocket, groupJid: string): void {
  _getPerSocket(socket).delete(groupJid);
}

/**
 * Surgically patch the in-memory cache when a group-participants.update
 * event arrives.  This avoids a full network refetch — admin changes are
 * visible to the very next message check with zero latency.
 *
 * Actions:
 *  promote → set admin = 'admin' for each JID, update botIsAdmin
 *  demote  → set admin = null for each JID, update botIsAdmin
 *  add     → insert new participants as regular members
 *  remove  → delete participants from the list
 *
 * If no cache entry exists for the group, this is a no-op (the next
 * fetchGroupMeta will build a fresh entry from the server).
 */
export function patchGroupMetaCache(
  socket: WASocket,
  groupJid: string,
  action: 'promote' | 'demote' | 'add' | 'remove',
  participants: string[],
): void {
  const perSocket = _getPerSocket(socket);
  const hit = perSocket.get(groupJid);
  if (!hit) return; // no cache entry — no-op

  const meta = hit.meta;
  const botNum = numericId(meta.botJid);

  if (action === 'promote') {
    for (const p of meta.participants) {
      if (participants.some((jid) => participantMatchesIdentity(p, jid))) p.admin = 'admin';
    }
    const botParticipant = meta.participants.find((p) => participantMatchesIdentity(p, meta.botJid));
    if (botParticipant) meta.botIsAdmin = botParticipant.admin === 'admin' || botParticipant.admin === 'superadmin';

  } else if (action === 'demote') {
    for (const p of meta.participants) {
      if (participants.some((jid) => participantMatchesIdentity(p, jid))) p.admin = null;
    }
    const botParticipant = meta.participants.find((p) => participantMatchesIdentity(p, meta.botJid));
    if (botParticipant) meta.botIsAdmin = botParticipant.admin === 'admin' || botParticipant.admin === 'superadmin';

  } else if (action === 'add') {
    for (const jid of participants) {
      if (!meta.participants.some((p) => participantMatchesIdentity(p, jid))) {
        meta.participants.push({ id: jid, admin: null });
      }
    }

  } else if (action === 'remove') {
    meta.participants = meta.participants.filter(
      (p) => !participants.some((jid) => participantMatchesIdentity(p, jid))
    );
  }

  // Preserve the existing timestamp — cache is still valid, just patched
  perSocket.set(groupJid, { meta, ts: hit.ts });
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
 *
 * Results are cached per-socket per-group for META_TTL_MS (30 s).
 * Pass bust=true to force a fresh fetch (e.g. after a promote/demote).
 * Returns null if the group cannot be reached or an error occurs.
 */
export async function fetchGroupMeta(
  socket: WASocket,
  groupJid: string,
  bust = false
): Promise<ResolvedGroupMeta | null> {
  // ── Cache read ──────────────────────────────────────────
  const perSocket = _getPerSocket(socket);
  if (!bust) {
    const hit = perSocket.get(groupJid);
    if (hit && Date.now() - hit.ts < META_TTL_MS) {
      return hit.meta;
    }
  }

  try {
    const meta = await (socket as unknown as {
      groupMetadata(jid: string): Promise<{
        subject?: string;
        desc?: string;
        participants: {
          id: string;
          admin?: 'admin' | 'superadmin' | null;
          phoneNumber?: string;
        }[];
      }>;
    }).groupMetadata(groupJid);

    // ── Resolve bot identity (handles @s.whatsapp.net AND @lid accounts) ──────
    // Newer WhatsApp accounts expose the bot in the participant list under a
    // @lid JID whose numeric part is NOT the phone number.  We must try every
    // identity form to reliably locate the bot's own participant entry.
    const rawUser = (socket as unknown as { user?: { id?: string; lid?: string } }).user;
    const rawBotJid  = rawUser?.id  ?? '';
    const rawBotLid  = rawUser?.lid ?? '';

    const botJid    = stripDeviceSuffix(rawBotJid);
    const botLidJid = rawBotLid ? stripDeviceSuffix(rawBotLid) : '';
    const botNum    = numericId(botJid);
    const botLidNum = botLidJid ? numericId(botLidJid) : '';

    const participants: GroupParticipant[] = (meta.participants ?? []).map((p) => ({
      id: p.id,
      admin: p.admin ?? null,
      phoneNumber: p.phoneNumber,
    }));

    const botParticipant = participants.find((p) => {
      const pStripped = stripDeviceSuffix(p.id);
      // 1. Exact stripped-JID match (most reliable; catches both @s.whatsapp.net and @lid)
      if (botJid    && pStripped === botJid)    return true;
      if (botLidJid && pStripped === botLidJid) return true;
      // 2. Numeric match — works for standard @s.whatsapp.net participants
      const pNum = numericId(p.id);
      if (botNum    && !p.id.endsWith('@lid') && pNum === botNum)    return true;
      if (botLidNum && p.id.endsWith('@lid')  && pNum === botLidNum) return true;
      // 3. Phone-number field fallback (populated by Baileys for some @lid entries)
      if (botNum && p.phoneNumber) {
        const clean = p.phoneNumber.replace(/\D/g, '');
        if (clean && clean === botNum) return true;
      }
      return false;
    });
    const botIsAdmin =
      botParticipant?.admin === 'admin' || botParticipant?.admin === 'superadmin';

    const result: ResolvedGroupMeta = {
      botJid,
      botIsAdmin,
      participants,
      subject: meta.subject ?? groupJid.split('@')[0] ?? 'Group',
      desc: meta.desc,
    };

    // ── Cache write ───────────────────────────────────────
    perSocket.set(groupJid, { meta: result, ts: Date.now() });

    return result;
  } catch (err) {
    logger.warn('[GroupPermissions] fetchGroupMeta failed', { err: String(err), groupJid });
    return null;
  }
}

// ── Permission checks ──────────────────────────────────────

/** Normalize a phone/JID value without ever treating LID digits as a phone. */
function phoneNumberOf(value: string | null | undefined): string {
  if (!value) return '';
  const normalized = stripDeviceSuffix(String(value));
  if (normalized.endsWith('@lid')) return '';
  return normalized.replace(/\D/g, '');
}

/** Compare a participant row with a canonical phone or raw LID identity. */
function participantMatchesIdentity(p: GroupParticipant, jid: string): boolean {
  const participantJid = stripDeviceSuffix(p.id);
  const targetJid = stripDeviceSuffix(jid);
  if (participantJid === targetJid) return true;

  const targetPhone = phoneNumberOf(targetJid);
  if (!targetPhone) return false;
  return phoneNumberOf(participantJid) === targetPhone || phoneNumberOf(p.phoneNumber) === targetPhone;
}

/**
 * Check whether a JID (real, LID, or device-suffixed) belongs to an admin.
 *
 * A WhatsApp participant may be represented by an @lid id while exposing the
 * real phone number separately in `phoneNumber`. Never compare LID digits with
 * phone digits: they are different identity spaces. Match exact JIDs first,
 * then normal phone identities, then the participant's explicit phoneNumber.
 */
export function isAdminJid(
  participants: GroupParticipant[],
  jid: string
): boolean {
  const targetJid = stripDeviceSuffix(jid);
  const targetPhone = phoneNumberOf(targetJid);
  if (!targetJid && !targetPhone) return false;

  return participants.some((p) => {
    if (p.admin !== 'admin' && p.admin !== 'superadmin') return false;

    const participantJid = stripDeviceSuffix(p.id);
    if (participantJid === targetJid) return true;

    // Numeric matching is safe only within the phone-JID space.
    const participantPhone = phoneNumberOf(participantJid);
    if (targetPhone && participantPhone && participantPhone === targetPhone) return true;

    // Baileys exposes the real phone number for many @lid participant rows.
    const declaredPhone = phoneNumberOf(p.phoneNumber);
    return Boolean(targetPhone && declaredPhone && declaredPhone === targetPhone);
  });
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

  // The LID participant entry itself carries the REAL phone number in its
  // `phoneNumber` field — match by the entry's own id and read it.
  // (Never compare LID digits against phone digits — LID numbers are NOT
  // phone numbers, so that cross-comparison always fails.)
  const entry = participants.find((p) => stripDeviceSuffix(p.id) === clean);
  if (entry?.phoneNumber) {
    const phone = entry.phoneNumber.replace(/\D/g, '');
    if (phone) return `${phone}@s.whatsapp.net`;
  }

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
