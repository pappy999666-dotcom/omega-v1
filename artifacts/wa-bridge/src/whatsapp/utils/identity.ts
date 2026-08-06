// ============================================================
// WA-Bridge — Identity Utilities (JID / LID / Phone)
//
// Single source of truth for every identity comparison in the
// codebase. Uses the @crysnovax/baileys fork's authoritative
// `signalRepository.lidMapping` (getPNForLID / getLIDForPN) and
// `jidDecode` when available, then falls back to group-metadata
// and heuristic numeric matching.
//
// NEVER compare raw numerics across LID and phone JIDs — LID
// numbers are NOT phone numbers.
// ============================================================

import type {
  BridgeWASocket as WASocket,
  WebMessageInfo,
  IMessage,
  MessageContextInfo,
} from '../baileys-types.js';

// ── Basic JID shaping ───────────────────────────────────────

/** Strip the device suffix: "123:4@domain" → "123@domain" */
export function stripDeviceSuffix(jid: string): string {
  if (!jid) return jid;
  const at = jid.indexOf('@');
  if (at === -1) return jid;
  return `${jid.slice(0, at).split(':')[0]}@${jid.slice(at + 1)}`;
}

/** Canonical JID: device-stripped, or empty string for garbage. */
export function normalizeJid(jid: string | null | undefined): string {
  if (!jid) return '';
  return stripDeviceSuffix(String(jid));
}

/** Numeric user-part of any JID variant (phone OR LID number). */
export function numericId(jid: string | null | undefined): string {
  if (!jid) return '';
  return (String(jid).split('@')[0] ?? '').split(':')[0] ?? '';
}

export function isLidJid(jid: string | null | undefined): boolean {
  return Boolean(jid) && String(jid).endsWith('@lid');
}

export function isPhoneJid(jid: string | null | undefined): boolean {
  return Boolean(jid) && String(jid).endsWith('@s.whatsapp.net');
}

/** Normalize a number/JID/phone to plain digits (canonical form for lists). */
export function normalizePhone(value: string | null | undefined): string {
  if (!value) return '';
  const user = String(value).split('@')[0]?.split(':')[0] ?? '';
  return user.replace(/\D/g, '');
}

// ── Fork LID mapping access ─────────────────────────────────

interface LidMapping {
  getPNForLID?(jid: string): Promise<string | null | undefined>;
  getLIDForPN?(jid: string): Promise<string | null | undefined>;
}

function lidMapping(socket: WASocket): LidMapping | undefined {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (socket as unknown as any)?.signalRepository?.lidMapping;
}

// ── Decode JID via fork's jidDecode (lazy, cached) ─────────

let _baileysMod: Promise<Record<string, unknown>> | null = null;
function baileysModule(): Promise<Record<string, unknown>> {
  _baileysMod ??= import('@crysnovax/baileys') as Promise<Record<string, unknown>>;
  return _baileysMod;
}

/** Canonicalize a JID using the fork's jidDecode when the module is available. */
export async function decodeJidAsync(jid: string | null | undefined): Promise<string> {
  const raw = normalizeJid(jid);
  if (!raw) return '';
  try {
    const mod = await baileysModule();
    const jidDecode = mod['jidDecode'] as
      | ((j: string) => { user?: string; server?: string } | undefined)
      | undefined;
    if (typeof jidDecode === 'function') {
      const decoded = jidDecode(raw);
      if (decoded?.user && decoded.server) return `${decoded.user}@${decoded.server}`;
    }
  } catch {
    // module unavailable — fall through
  }
  return raw;
}

/**
 * Return every identity variant for a JID:
 * normalized JID + decoded JID + phone↔LID cross-mapping results.
 */
export async function identityVariants(
  socket: WASocket,
  jid: string | null | undefined
): Promise<Set<string>> {
  const out = new Set<string>();
  const norm = normalizeJid(jid);
  if (!norm) return out;
  out.add(norm);

  try {
    const decoded = await decodeJidAsync(norm);
    if (decoded && decoded !== norm) out.add(decoded);
  } catch { /* ignore */ }

  try {
    const map = lidMapping(socket);
    if (map?.getPNForLID && norm.endsWith('@lid')) {
      const pn = await map.getPNForLID(norm);
      if (pn) out.add(normalizeJid(pn));
    } else if (map?.getLIDForPN && norm.endsWith('@s.whatsapp.net')) {
      const lid = await map.getLIDForPN(norm);
      if (lid) out.add(normalizeJid(lid));
    }
  } catch { /* ignore */ }

  return out;
}

/** True when two JIDs refer to the same user (LID/phone/device agnostic). */
export async function identitiesOverlap(
  socket: WASocket,
  a: string | null | undefined,
  b: string | null | undefined
): Promise<boolean> {
  if (!a || !b) return false;
  const [av, bv] = await Promise.all([identityVariants(socket, a), identityVariants(socket, b)]);
  return [...av].some((v) => bv.has(v));
}

/**
 * Resolve the best real phone JID from a list of candidates.
 * Prefers an explicit @s.whatsapp.net JID, then LID mapping, then null.
 */
export async function resolvePhoneJid(
  socket: WASocket,
  candidates: Array<string | null | undefined>
): Promise<string | null> {
  const values = [...new Set(candidates.filter(Boolean).map((c) => normalizeJid(c)))];
  const direct = values.find(isPhoneJid);
  if (direct) return direct;
  for (const v of values.filter(isLidJid)) {
    const variants = await identityVariants(socket, v);
    const real = [...variants].find(isPhoneJid);
    if (real) return real;
  }
  return null;
}

// ── Context extraction for ALL message types ───────────────

/** contextInfo from any message type, including wrapped containers. */
export function getContextInfoAny(
  message: IMessage | null | undefined
): MessageContextInfo | null {
  if (!message) return null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const m = message as any;
  const inner =
    m.ephemeralMessage?.message ??
    m.viewOnceMessage?.message ??
    m.viewOnceMessageV2?.message ??
    m.viewOnceMessageV2Extension?.message ??
    m.documentWithCaptionMessage?.message ??
    m.groupStatusMessage?.message ??
    m.groupStatusMessageV2?.message ??
    m;
  const ci =
    inner?.extendedTextMessage?.contextInfo ??
    inner?.imageMessage?.contextInfo ??
    inner?.videoMessage?.contextInfo ??
    inner?.audioMessage?.contextInfo ??
    inner?.stickerMessage?.contextInfo ??
    inner?.documentMessage?.contextInfo ??
    inner?.buttonsMessage?.contextInfo ??
    inner?.listMessage?.contextInfo ??
    inner?.templateMessage?.contextInfo ??
    inner?.interactiveMessage?.contextInfo ??
    inner?.contactMessage?.contextInfo ??
    inner?.locationMessage?.contextInfo ??
    inner?.groupStatusMessage?.contextInfo ??
    inner?.groupStatusMessageV2?.contextInfo ??
    null;
  return ci ?? null;
}

/** The quoted message payload from any message type. */
export function quotedMessageOf(message: IMessage | null | undefined): IMessage | null | undefined {
  return getContextInfoAny(message)?.quotedMessage ?? null;
}

/** Text extraction for every message type (mirrors the reference serializer). */
export function extractMessageTextAny(message: IMessage | null | undefined): string {
  if (!message) return '';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const m = message as any;
  const wrapped =
    m.ephemeralMessage?.message ??
    m.viewOnceMessage?.message ??
    m.viewOnceMessageV2?.message ??
    m.documentWithCaptionMessage?.message;
  if (wrapped) return extractMessageTextAny(wrapped);
  const text =
    m.conversation ??
    m.extendedTextMessage?.text ??
    m.imageMessage?.caption ??
    m.videoMessage?.caption ??
    m.documentMessage?.caption ??
    m.audioMessage?.caption ??
    m.buttonsMessage?.contentText ??
    m.listMessage?.description ??
    m.listResponseMessage?.singleSelectReply?.selectedRowId ??
    m.buttonsResponseMessage?.selectedButtonId ??
    m.templateMessage?.hydratedTemplate?.hydratedContentText ??
    m.pollCreationMessage?.name ??
    m.groupStatusMessage?.message?.extendedTextMessage?.text ??
    m.groupStatusMessageV2?.message?.extendedTextMessage?.text ??
    '';
  return typeof text === 'string' ? text : '';
}

// ── Sender resolution ───────────────────────────────────────

/**
 * Every place a sender JID can hide on a raw message, in priority order.
 * Uses the fork's alt-JID fields (remoteJidAlt / participantAlt).
 */
export function senderCandidates(msg: WebMessageInfo): string[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const key = (msg.key ?? {}) as any;
  const ci = getContextInfoAny(msg.message);
  const out: string[] = [];
  if (msg.key?.fromMe) {
    return out; // fromMe handled by caller with socket.user.id
  }
  const candidates = [
    key.participantAlt,
    ci?.participantAlt,
    key.participant,
    ci?.participant,
    key.remoteJidAlt ?? key.remoteJid,
  ] as Array<string | null | undefined>;
  for (const v of candidates) {
    if (v) out.push(v);
  }
  return out;
}

/**
 * Resolve the sender's real JID for a message.
 * LID senders are mapped through the fork's signal repository; if that
 * fails the LID is returned unchanged (callers may resolve via metadata).
 */
export async function resolveSenderJid(
  socket: WASocket,
  msg: WebMessageInfo
): Promise<string> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ownId = (socket as unknown as any)?.user?.id ?? '';
  if (msg.key?.fromMe) return ownId ? normalizeJid(ownId) : '';

  const candidates = senderCandidates(msg);
  for (const raw of candidates) {
    const norm = normalizeJid(raw);
    if (!norm) continue;
    if (!isLidJid(norm)) return norm;
    const variants = await identityVariants(socket, norm);
    const real = [...variants].find(isPhoneJid);
    if (real) return real;
    return norm;
  }
  return ownId ? normalizeJid(ownId) : '';
}

// ── group-participants.update payload helpers ──────────────

/**
 * Normalize the fork's participant entries (string JIDs or objects with
 * { id, jid, lid, phoneNumber, pn }) into a list of canonical JIDs.
 * Prefers real phone JIDs over LIDs when both are present.
 */
export function normalizeParticipantEntries(participants: unknown[]): string[] {
  const out: string[] = [];
  for (const p of participants ?? []) {
    if (typeof p === 'string') {
      const n = normalizeJid(p);
      if (n && !out.includes(n)) out.push(n);
      continue;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const o = (p ?? {}) as any;
    const phone = o.phoneNumber ?? o.pn ?? '';
    const phoneJid =
      phone && String(phone).includes('@')
        ? String(phone)
        : phone
          ? `${String(phone).replace(/\D/g, '')}@s.whatsapp.net`
          : '';
    const jidish = o.jid ?? o.id ?? o.lid ?? '';
    // Prefer a real phone JID; otherwise any JID-ish field.
    const picked = phoneJid && !isLidJid(phoneJid) ? phoneJid : jidish || phoneJid;
    if (!picked) continue;
    const n = normalizeJid(picked);
    if (n && !out.includes(n)) out.push(n);
  }
  return out;
}

/**
 * The actor (author) of a group-participants.update. The fork can deliver
 * the actor as `authorPn` (LID account) — prefer it.
 */
export function authorFromUpdate(
  update: { author?: string; authorPn?: string; actor?: string } | undefined
): string | undefined {
  const author = update?.authorPn ?? update?.author ?? update?.actor ?? undefined;
  return author ? normalizeJid(author) : undefined;
}

/** Build a real phone JID from a phoneNumber/pn value (bare digits or full JID). */
function toPhoneJid(value: string | null | undefined): string {
  if (!value) return '';
  const v = String(value);
  if (v.includes('@')) {
    const n = normalizeJid(v);
    return isPhoneJid(n) ? n : '';
  }
  const digits = v.replace(/\D/g, '');
  return digits ? `${digits}@s.whatsapp.net` : '';
}

/**
 * Normalize a @crysnovax/baileys 2.7.0 `group-participants.update`
 * `participants` payload (string JIDs OR objects) into plain JID strings.
 *
 * The fork's object entries are shaped `{ id: '<jid>', phoneNumber: '<pn>' }`
 * where `id` may be a LID (`xxx@lid`) and `phoneNumber` is the REAL phone
 * number.  Preferring the real phone JID here (instead of the LID `id`)
 * means Welcome / Goodbye / AutoBlock / AntiPromote / AntiDemote all
 * receive real JIDs and never leak LIDs downstream.
 */
export function normalizeParticipantUpdateJids(participants: unknown[]): string[] {
  const out: string[] = [];
  for (const p of participants ?? []) {
    if (typeof p === 'string') {
      const n = normalizeJid(p);
      if (n && !out.includes(n)) out.push(n);
      continue;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const o = (p ?? {}) as any;
    const phoneJid = toPhoneJid(o.phoneNumber ?? o.pn ?? '');
    const idJid = normalizeJid(o.id ?? o.jid ?? o.lid ?? '');
    // Prefer the real phone JID whenever the payload exposes one.
    const picked = phoneJid || idJid;
    if (picked && !out.includes(picked)) out.push(picked);
  }
  return out;
}

/** Build a WAMessageKey for a quoted message from contextInfo. */
export function buildQuotedKey(
  msg: WebMessageInfo,
  resolvedGroupJid: string,
  resolvedSenderJid: string
): { remoteJid: string; fromMe: boolean; id: string; participant?: string } {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ci = (getContextInfoAny(msg.message) ?? {}) as any;
  const remoteJid = ci.remoteJid ?? resolvedGroupJid;
  const quotedParticipant =
    typeof ci.participant === 'string' ? ci.participant : undefined;
  const participant = resolvedSenderJid || quotedParticipant;
  return {
    remoteJid: typeof remoteJid === 'string' ? remoteJid : resolvedGroupJid,
    fromMe: false,
    id: ci.stanzaId ?? msg.key?.id ?? '',
    participant,
  };
}

// ═══════════════════════════════════════════════════════════
// CENTRALIZED IDENTITY RESOLUTION (single source of truth)
//
// Every user reference in the codebase must resolve through one of
// these helpers. They guarantee: no LID leaks, no raw participantAlt
// exposure, phone-first JIDs, and stable display numbers.
// ═══════════════════════════════════════════════════════════

/** Minimal group participant shape accepted by the resolvers. */
export interface IdentityParticipant {
  id?: string;
  phoneNumber?: string;
  /** Fork aliases — some payloads expose the phone under `pn`. */
  pn?: string;
  /** Fork aliases — some payloads expose the JID under `jid` / `lid`. */
  jid?: string;
  lid?: string;
}

/**
 * Resolve any identifier (LID / phone JID / device JID / raw number)
 * to a canonical phone JID + display number.
 *
 * Resolution order:
 *   1. Fork lidMapping (authoritative LID → phone)
 *   2. Group participant list (phoneNumber field / matching real JID)
 *   3. Direct phone JID passthrough
 *   4. Fallback: the raw value with a @s.whatsapp.net domain ONLY when
 *      the input is already a phone JID (never fabricate from LID digits).
 */
export async function resolveIdentity(
  socket: WASocket,
  rawJid: string | null | undefined,
  participants?: IdentityParticipant[] | null
): Promise<{ jid: string; number: string; isLid: boolean }> {
  const norm = normalizeJid(rawJid);
  if (!norm) return { jid: '', number: '', isLid: false };

  const isLid = norm.endsWith('@lid');

  // 1. Authoritative fork mapping.
  if (isLid) {
    const variants = await identityVariants(socket, norm).catch(() => new Set<string>());
    const real = [...variants].find(isPhoneJid);
    if (real) return { jid: real, number: normalizePhone(real), isLid };
  }

  // 2. Group participant list.  The LID participant entry itself carries the
  //    real phone number in phoneNumber/pn — match by the entry's OWN identity
  //    fields (id / jid / lid), never by comparing LID digits to phone digits
  //    (LID numbers are NOT phone numbers, so that comparison always fails).
  if (participants?.length) {
    const match = participants.find((p) => {
      const own = [p.id, p.jid, p.lid].filter(Boolean).map((v) => normalizeJid(v));
      return own.includes(norm);
    });
    if (match) {
      const phone = normalizePhone(match.phoneNumber ?? match.pn);
      if (phone) return { jid: `${phone}@s.whatsapp.net`, number: phone, isLid };
      const ownJid = normalizeJid(match.id ?? match.jid ?? '');
      if (ownJid && isPhoneJid(ownJid)) {
        return { jid: ownJid, number: normalizePhone(ownJid), isLid };
      }
    }
  }

  // 3. Already a phone JID — pass through.
  if (isPhoneJid(norm)) return { jid: norm, number: normalizePhone(norm), isLid };

  // 4. Unresolvable LID: return empty so callers never leak LID digits.
  if (isLid) return { jid: '', number: '', isLid };

  return { jid: norm, number: normalizePhone(norm), isLid };
}

/**
 * The @mention text for a JID — ALWAYS the real phone number, never a LID.
 * Returns '' when the identity cannot be resolved to a phone number.
 */
export async function mentionTextFor(
  socket: WASocket,
  rawJid: string | null | undefined,
  participants?: IdentityParticipant[] | null
): Promise<string> {
  const id = await resolveIdentity(socket, rawJid, participants);
  return id.number ? `@${id.number}` : '';
}

/**
 * Display name from the socket contact store (name → notify → number).
 * Never exposes a LID.
 */
export async function displayNameFor(
  socket: WASocket,
  rawJid: string | null | undefined
): Promise<string> {
  const norm = normalizeJid(rawJid);
  if (!norm) return 'Unknown';
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sock = socket as any;
    const contact =
      sock?.store?.contacts?.[norm] ??
      sock?.contacts?.[norm] ??
      sock?.store?.contacts?.[norm.replace('@s.whatsapp.net', '@lid')];
    if (contact?.name) return contact.name;
    if (contact?.notify) return contact.notify;
    if (contact?.verifiedName) return contact.verifiedName;
  } catch {
    /* non-critical */
  }
  const num = normalizePhone(norm);
  return num ? num : 'Unknown';
}

/**
 * Download a user's profile picture as a Buffer (best-effort).
 * Returns null when private / unavailable / network failure.
 */
export async function profilePicBuffer(
  socket: WASocket,
  rawJid: string | null | undefined
): Promise<Buffer | null> {
  const jid = normalizeJid(rawJid);
  if (!jid) return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ppUrl = await (socket as any)?.profilePictureUrl?.(jid, 'image').catch(() => null);
    if (!ppUrl) return null;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      const res = await fetch(ppUrl, { signal: controller.signal });
      if (!res.ok) return null;
      return Buffer.from(await res.arrayBuffer());
    } finally {
      clearTimeout(timeout);
    }
  } catch {
    return null;
  }
}
