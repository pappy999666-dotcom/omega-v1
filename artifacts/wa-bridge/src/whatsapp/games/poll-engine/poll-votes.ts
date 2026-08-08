// ============================================================
// Poll Vote Decryption & Security
//
// Verified against the installed @crysnovax/baileys@2.7.1:
//   • The fork's process-message.js poll-update auto-decrypt block
//     is COMMENTED OUT, but the raw pollUpdateMessage still arrives
//     via messages.upsert (upsertMessage is called unconditionally
//     after successful decryption in Socket/messages-recv.js).
//   • decryptPollVote({ encPayload, encIv }, { pollCreatorJid,
//     pollMsgId, pollEncKey, voterJid }) IS publicly exported from
//     the package root (Utils/process-message.js → Utils/index.js).
//   • getAggregateVotesInPollMessage() is likewise exported.
//   • Vote messages carry pollCreationMessageKey + vote: PollEncV1.
//   • Decrypted PollVoteMessage.selectedOptions = SHA-256 digests
//     of the chosen option names (repeated bytes).
//
// We NEVER guess: if a vote cannot be reliably attributed to one
// option of a tracked poll, it is logged and safely ignored.
// ============================================================

import crypto from 'crypto';
import type { PollVoteInput, EncryptedVote } from './types.js';
import { logger } from '../../../utils/logger.js';

export interface DecryptedVote {
  /** optionIndex (into the question.options array) or -1 when unknown. */
  optionIndex: number;
  /** The raw selected-option digest(s) as hex. */
  selectedHex: string[];
  /** True when the player explicitly removed their selection. */
  removed?: boolean;
}

let decryptFn: ((
  vote: { encPayload?: Uint8Array | Buffer | null; encIv?: Uint8Array | Buffer | null },
  ctx: { pollCreatorJid: string; pollMsgId: string; pollEncKey: Buffer; voterJid: string }
) => { selectedOptions?: Array<Uint8Array | Buffer | string> }) | null | undefined;
let normalizeJidFn: ((jid: string) => string) | null | undefined;

interface PollCrypto {
  decrypt: NonNullable<typeof decryptFn>;
  /** Fork's jidNormalizedUser — strips device suffix (e.g. ":5@"). */
  normalizeJid: (jid: string) => string;
}

/**
 * Lazily resolve the fork's decryptPollVote + jidNormalizedUser. Returns
 * null when the installed version does not expose them (then votes are
 * safely ignored — never guessed).
 */
async function getPollCrypto(): Promise<PollCrypto | null> {
  if (decryptFn !== undefined && normalizeJidFn !== undefined) {
    return decryptFn && normalizeJidFn ? { decrypt: decryptFn, normalizeJid: normalizeJidFn } : null;
  }
  try {
    const baileys = await import('@crysnovax/baileys') as Record<string, unknown>;
    decryptFn = (baileys['decryptPollVote'] as NonNullable<typeof decryptFn> | undefined) ?? null;
    normalizeJidFn = (baileys['jidNormalizedUser'] as ((jid: string) => string) | undefined) ?? null;
  } catch {
    decryptFn = null;
    normalizeJidFn = null;
  }
  return decryptFn && normalizeJidFn ? { decrypt: decryptFn, normalizeJid: normalizeJidFn } : null;
}

/** Strip a device suffix (":N@") from a JID, lowercased. */
function stripDevice(jid: string): string {
  return jid.trim().toLowerCase().replace(/:\d+(?=@)/, '');
}

/**
 * Candidate poll-creator JIDs the voter's client may have encrypted with:
 * device-stripped phone, raw phone (with :N device), device-stripped LID,
 * raw LID. Deduplicated, in likelihood order.
 */
function creatorJidCandidates(meId: string, meLid: string | undefined): string[] {
  const out: string[] = [];
  const push = (value: string | undefined): void => {
    const s = value?.trim().toLowerCase();
    if (s && !out.includes(s)) out.push(s);
  };
  push(stripDevice(meId));
  push(meId);
  push(stripDevice(meLid ?? ''));
  push(meLid);
  return out.length > 0 ? out : [''];
}

/** Candidate voter JIDs: raw key-author bytes first, then device-stripped. */
function voterJidCandidates(voterJid: string): string[] {
  const out: string[] = [];
  const push = (value: string | undefined): void => {
    const s = value?.trim().toLowerCase();
    if (s && !out.includes(s)) out.push(s);
  };
  push(voterJid);
  push(stripDevice(voterJid));
  return out.length > 0 ? out : [''];
}

/** SHA-256 hex digest of an option name (matches WhatsApp's poll hashing). */
export function optionHashHex(optionName: string): string {
  return crypto.createHash('sha256').update(Buffer.from(optionName, 'utf8')).digest('hex');
}

/** Normalize any selected-option value (Uint8Array | Buffer | string) to hex. */
function toHex(value: Uint8Array | Buffer | string): string {
  if (typeof value === 'string') {
    // Some decoders hand back the digest as a latin1/utf8 string of raw bytes.
    if (/^[0-9a-fA-F]{64}$/.test(value)) return value.toLowerCase();
    return Buffer.from(value, 'latin1').toString('hex');
  }
  return Buffer.from(value).toString('hex');
}

/**
 * Decrypt a poll vote and map it to an option index of the given
 * options array. Returns { optionIndex: -1 } when the digest cannot
 * be matched — the caller must then safely ignore the vote.
 */
export async function decryptVoteToOption(
  input: PollVoteInput,
  options: string[]
): Promise<DecryptedVote> {
  const { vote } = input;
  if (!vote?.encPayload || !vote?.encIv) {
    return { optionIndex: -1, selectedHex: [] };
  }

  const crypto = await getPollCrypto();
  if (!crypto) {
    // The installed fork does not expose vote decryption → log + ignore.
    return { optionIndex: -1, selectedHex: [] };
  }

  // messageSecret we set at poll creation time (stored base64 in the game).
  const pollEncKey = pollSecretForKey(input.pollMsgId, input.scope);
  if (!pollEncKey) return { optionIndex: -1, selectedHex: [] };

  // ── JID permutation fallback ───────────────────────────────
  // Real WhatsApp clients encrypt with THEIR view of the poll creator's JID,
  // which for multi-device / LID-migrated accounts can be the phone JID with
  // a :N device suffix or the @lid form (e.g. creds.me.id =
  // "2250508934077:3@s.whatsapp.net", me.lid = "130808262201350:3@lid").
  // GCM auth is deterministic: we try every candidate permutation until one
  // verifies — never guessing, always proven by the auth tag.
  let decoded: { selectedOptions?: Array<Uint8Array | Buffer | string> } | undefined;
  const creators = creatorJidCandidates(input.meId || '', input.meLid);
  const voters = voterJidCandidates(input.voterJid);
  let lastErr: unknown = null;
  outer:
  for (const pollCreatorJid of creators) {
    for (const voterJid of voters) {
      try {
        const attempt = crypto.decrypt(
          { encPayload: vote.encPayload, encIv: vote.encIv },
          { pollCreatorJid, pollMsgId: input.pollMsgId, pollEncKey, voterJid }
        );
        if (attempt) {
          decoded = attempt;
          logger.debug('[PollGame] vote decrypted', { pollMsgId: input.pollMsgId, pollCreatorJid, voterJid });
          break outer;
        }
      } catch (err) {
        lastErr = err;
      }
    }
  }
  if (!decoded) {
    // None of the JID permutations verified — malformed / undecryptable vote.
    // Never guess. Log the candidates + error so it stays diagnosable.
    logger.warn('[PollGame] vote decrypt failed (GCM auth)', {
      pollMsgId: input.pollMsgId,
      creatorCandidates: creators,
      voterCandidates: voters,
      err: String(lastErr ?? ''),
    });
    return { optionIndex: -1, selectedHex: [] };
  }

  const selectedHex = (decoded.selectedOptions ?? []).map(toHex);
  if (selectedHex.length === 0) {
    // An empty selectedOptions array is a real WhatsApp vote-removal event,
    // not an invalid payload. The engine removes the player's previous choice.
    return { optionIndex: -1, selectedHex, removed: true };
  }

  // These games create single-select polls. Require exactly one digest and
  // require it to match exactly one option; never accept the first matching
  // digest from a malformed multi-option payload.
  if (selectedHex.length !== 1) {
    logger.warn('[PollGame] multi-option vote rejected for single-select poll', {
      pollMsgId: input.pollMsgId,
      voterJid: input.voterJid,
      selectedCount: selectedHex.length,
    });
    return { optionIndex: -1, selectedHex };
  }

  // Map the one selected digest to an option index.
  const hashes = options.map((name) => optionHashHex(name));
  const optionIndex = hashes.indexOf(selectedHex[0]!);
  if (optionIndex < 0) {
    // Decryption succeeded but the voter's option digest does not match any
    // of OUR stored option names — WhatsApp may have normalized/truncated
    // the option text. Log both sides so the exact diff is visible.
    logger.warn('[PollGame] vote decrypt OK but option digest mismatch', {
      pollMsgId: input.pollMsgId,
      voterJid: input.voterJid,
      received: selectedHex,
      expected: hashes,
    });
  }

  return { optionIndex, selectedHex };
}

/**
 * Poll secrets (messageSecret buffers) are stored by the engine per
 * pollMsgId so decryption is possible after creation. This registry is
 * kept in-memory only (the engine also persists it inside game state).
 */
const secretRegistry = new Map<string, string>(); // scoped poll key → base64 secret

function secretKey(pollMsgId: string, scope?: PollVoteInput['scope']): string {
  return scope
    ? `${scope.sessionId}\u0000${scope.chatJid}\u0000${pollMsgId}`
    : pollMsgId;
}

export function registerPollSecret(pollMsgId: string, secret: Buffer, scope?: PollVoteInput['scope']): void {
  if (pollMsgId) secretRegistry.set(secretKey(pollMsgId, scope), secret.toString('base64'));
}

export function unregisterPollSecret(pollMsgId: string, scope?: PollVoteInput['scope']): void {
  secretRegistry.delete(secretKey(pollMsgId, scope));
}

function pollSecretForKey(pollMsgId: string, scope?: PollVoteInput['scope']): Buffer | null {
  // New engine registrations are always scope-qualified. Never fall back to
  // an unscoped id: identical WhatsApp message ids must not cross sessions or
  // chats, even if stale process memory contains a legacy entry.
  const b64 = secretRegistry.get(secretKey(pollMsgId, scope));
  if (!b64) return null;
  return Buffer.from(b64, 'base64');
}

/** Register every stored secret after a game-state restore. */
export function restorePollSecrets(pairs: Array<{ pollMsgId: string; secretB64: string; scope?: PollVoteInput['scope'] }>): void {
  for (const p of pairs) {
    if (p?.pollMsgId && p?.secretB64) secretRegistry.set(secretKey(p.pollMsgId, p.scope), p.secretB64);
  }
}

/** Export shape used for tests / tooling. */
export function __secretRegistrySize(): number {
  return secretRegistry.size;
}

export type { EncryptedVote };
