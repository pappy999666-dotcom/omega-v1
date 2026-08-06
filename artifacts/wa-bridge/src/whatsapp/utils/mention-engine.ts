// ============================================================
// WA-Bridge — Central Mention Engine
//
// THE single source of truth for building native WhatsApp mentions.
// No module may ever construct "@" + digits manually again.
//
// ── Guarantees ─────────────────────────────────────────────
//   1. Mention text tokens (@<number>) and the mentionedJid array are
//      ALWAYS built from the same resolved identity — they can never
//      fall out of sync.
//   2. Tokens and arrays only ever contain REAL phone numbers / phone
//      JIDs (@s.whatsapp.net). LID, PN, device-suffix and remoteJidAlt
//      values never leak into user-facing text.
//   3. WhatsApp renders a native mention only when the @token in the
//      text matches the user-part of a JID in contextInfo.mentionedJid.
//      This engine makes that match structural, not accidental.
//   4. Display names are resolved best-effort (contact → notify →
//      phone number) and exposed via MentionResult.displayName.
//
// Resolution order (per input):
//   participant object phoneNumber/pn  →  explicit JID  →  bare phone
//   …each candidate through resolveIdentity() (fork lidMapping →
//   group participant list → phone-JID passthrough).
// ============================================================

import type { BridgeWASocket as WASocket } from '../baileys-types.js';
import {
  normalizeJid,
  normalizePhone,
  isPhoneJid,
  isLidJid,
  resolveIdentity,
  displayNameFor,
  type IdentityParticipant,
} from './identity.js';

// ── Input / Output shapes ──────────────────────────────────

export interface MentionSource {
  /** Any JID form: phone JID, LID, device-suffixed JID. */
  jid?: string | null;
  /** Bare phone number (digits or +prefix form). */
  phoneNumber?: string | null;
  /** Fork participant object ({ id, jid, lid, phoneNumber, pn }). */
  participant?: IdentityParticipant | null;
  /** Group participant list — enables LID → phone resolution. */
  participants?: IdentityParticipant[] | null;
}

export interface MentionResult {
  /** Real phone JID ('<number>@s.whatsapp.net') — '' when unresolvable. */
  jid: string;
  /** Real phone digits — '' when unresolvable. */
  number: string;
  /** '@<number>' — the exact token to embed in message text ('' when unresolvable). */
  token: string;
  /** Best available display name (contact name → notify → number → 'User'). */
  displayName: string;
}

export const UNRESOLVED_MENTION: MentionResult = {
  jid: '',
  number: '',
  token: '',
  displayName: 'User',
};

/** Matches an @mention-style token in rendered text (7–15 digits). */
export const MENTION_TOKEN_RE = /@([0-9]{7,15})/g;

// ── Token builder ──────────────────────────────────────────

/**
 * '@<digits>' from any identity value. Returns '' for LID JIDs and unknown
 * domains so LID digits can never leak into message text.
 */
export function mentionToken(value: string | null | undefined): string {
  if (!value) return '';
  const s = String(value);
  if (s.includes('@')) {
    const norm = normalizeJid(s);
    if (isLidJid(norm)) return '';        // LID digits are NOT phone numbers
    if (!isPhoneJid(norm)) return '';     // unknown domain — never guess
    return `@${normalizePhone(norm)}`;
  }
  const digits = normalizePhone(s);
  return digits ? `@${digits}` : '';
}

// ── Core resolver ──────────────────────────────────────────

/**
 * Resolve any identifier to a real phone JID + @token + display name.
 * Returns UNRESOLVED_MENTION (all empty) when no phone identity can be
 * established — callers must NOT fabricate a token in that case.
 */
export async function resolveMention(
  socket: WASocket,
  src: MentionSource
): Promise<MentionResult> {
  const candidates: string[] = [];
  const addCandidate = (v: string | null | undefined): void => {
    const n = normalizeJid(v);
    if (n && !candidates.includes(n)) candidates.push(n);
  };

  // 1. Participant object — its phoneNumber/pn is authoritative.
  const p = src.participant;
  if (p) {
    const digits = normalizePhone(p.phoneNumber ?? p.pn);
    if (digits) candidates.push(`${digits}@s.whatsapp.net`);
    addCandidate(p.jid ?? p.id ?? p.lid ?? src.jid);
  }

  // 2. Explicit JID.
  if (src.jid) addCandidate(src.jid);

  // 3. Bare phone number.
  if (src.phoneNumber) {
    const digits = normalizePhone(src.phoneNumber);
    if (digits) candidates.push(`${digits}@s.whatsapp.net`);
  }

  if (candidates.length === 0) return UNRESOLVED_MENTION;

  let jid = '';
  let number = '';
  for (const cand of candidates) {
    try {
      const resolved = await resolveIdentity(socket, cand, src.participants ?? null);
      if (resolved?.number) {
        jid = resolved.jid;
        number = resolved.number;
        break;
      }
      if (!jid && resolved?.jid && isPhoneJid(resolved.jid)) {
        jid = resolved.jid;
        number = resolved.number;
      }
    } catch {
      // try the next candidate
    }
  }

  if (!jid || !number) return UNRESOLVED_MENTION;

  return {
    jid,
    number,
    token: `@${number}`,
    displayName: await displayNameFor(socket, jid),
  };
}

// ── Array sanitizer ────────────────────────────────────────

/**
 * Convert a list of arbitrary JIDs to real phone JIDs (LID → phone via
 * lidMapping + participant list). Unresolvable entries are dropped.
 */
export async function sanitizeMentionJids(
  socket: WASocket,
  jids: Array<string | null | undefined>,
  participants?: IdentityParticipant[] | null
): Promise<string[]> {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of jids ?? []) {
    if (!raw) continue;
    const r = await resolveMention(socket, { jid: raw, participants }).catch(() => null);
    if (r?.jid && !seen.has(r.jid)) {
      seen.add(r.jid);
      out.push(r.jid);
    }
  }
  return out;
}

// ── Rendered text builder ──────────────────────────────────

/**
 * Replace @mention / @user tokens with the resolved tokens and return the
 * text + mentionedJid array that are ALWAYS in sync.
 *
 *  - Every resolved mention is added to the array.
 *  - Every @mention/@user token in the template is consumed by the first
 *    resolvable mention; leftover tokens are removed (never left raw).
 *  - Stray @<digits> tokens already present in the text are matched to the
 *    resolved mentions by number, so hand-written tokens stay highlighted.
 */
export async function renderMentionedText(
  socket: WASocket,
  template: string,
  results: MentionResult[]
): Promise<{ text: string; mentions: string[] }> {
  let text = template ?? '';
  const mentions: string[] = [];
  const seen = new Set<string>();

  for (const r of results) {
    if (!r.jid || !r.number || seen.has(r.jid)) continue;
    seen.add(r.jid);
    mentions.push(r.jid);
    if (r.token) {
      text = text
        .replace(/@mention/gi, r.token)
        .replace(/@user/gi, r.token);
    }
  }

  // Remove leftover template tokens so they never leak as raw strings.
  text = text.replace(/@mention/gi, '').replace(/@user/gi, '');

  // Sync guard: any remaining @<digits> token must have its phone JID in
  // the array (hand-written tokens in templates).
  const seenNumbers = new Set(mentions.map((j) => j.split('@')[0]));
  const existingTokens = new Set<string>();
  for (const match of text.matchAll(MENTION_TOKEN_RE)) {
    const digits = match[1];
    if (existingTokens.has(digits)) continue;
    existingTokens.add(digits);
    if (!seenNumbers.has(digits)) {
      const r = await resolveMention(socket, { jid: `${digits}@s.whatsapp.net` }).catch(() => null);
      if (r?.jid && !seen.has(r.jid)) {
        seen.add(r.jid);
        mentions.push(r.jid);
      }
    }
  }

  return { text, mentions };
}
