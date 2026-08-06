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
