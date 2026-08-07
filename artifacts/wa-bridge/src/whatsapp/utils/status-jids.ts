// ============================================================
// WA-Bridge — Status JID List Resolver
//
// The installed @crysnovax/baileys fork has NO fetchStatusJidList
// helper. Its sendMessage status branch REQUIRES a non-empty
// statusJidList (normalizeStatusJidList throws
// "statusJidList must contain at least one recipient JID").
//
// This module is the single source of truth for building that
// list:
//   1. Contacts with an active status flag (fed by the
//      contacts.update / contacts.upsert event handlers).
//   2. Every known contact as a best-effort fallback.
//   3. The session's OWN JID so posting NEVER throws, even on a
//      fresh session with no contacts synced yet.
//
// Every status post (pstatus, godcast, statusdesign, smedia,
// gstatus, spam, omni status) routes through resolveStatusJidList.
// ============================================================

/**
 * sessionId → contact JID → { jid, hasStatus }
 * Contacts without an explicit status flag are still remembered so
 * the fallback list is never empty on fresh sessions.
 */
const statusContactsBySession = new Map<string, Map<string, { jid: string; hasStatus: boolean }>>();

/** True for user JIDs accepted by the fork's normalizeStatusJidList. */
function isUserJid(jid: string): boolean {
  return jid.endsWith('@s.whatsapp.net') || jid.endsWith('@lid');
}

function cleanJid(jid: string): string {
  if (!jid) return '';
  const trimmed = jid.trim();
  if (trimmed.includes('@')) return trimmed;
  return `${trimmed}@s.whatsapp.net`;
}

/**
 * Feed contact knowledge into the tracker. Called from the
 * contacts.update / contacts.upsert event handlers.
 *
 * contacts.update entries carry `status` (true while the contact
 * has an active status). contacts.upsert entries carry `id` and
 * usually no status flag — remember them as known contacts.
 */
export function rememberStatusContact(sessionId: string, jid: string, hasStatus: boolean): void {
  const clean = cleanJid(jid);
  if (!clean || clean === 'status@broadcast' || clean.endsWith('@g.us') || !isUserJid(clean)) return;
  let map = statusContactsBySession.get(sessionId);
  if (!map) {
    map = new Map();
    statusContactsBySession.set(sessionId, map);
  }
  const prev = map.get(clean);
  // Never downgrade a known contact to "no status" unless explicitly told so.
  map.set(clean, { jid: clean, hasStatus: hasStatus || Boolean(prev?.hasStatus) });
}

/** JIDs of contacts with an active status; falls back to all known contacts. */
export function getStatusJidList(sessionId: string): string[] {
  const map = statusContactsBySession.get(sessionId);
  if (!map || map.size === 0) return [];
  const active = [...map.values()].filter((c) => c.hasStatus).map((c) => c.jid);
  if (active.length > 0) return active;
  return [...map.keys()];
}

/** Resolve the session's own user JID from the socket, if available. */
export function selfJidOf(socket: unknown): string {
  const me = (socket as { user?: { id?: string } } | undefined)?.user?.id;
  if (!me) return '';
  const num = (me.split('@')[0] ?? '').split(':')[0]?.replace(/\D/g, '') ?? '';
  if (!num) return '';
  return `${num}@s.whatsapp.net`;
}

/**
 * Build a guaranteed non-empty statusJidList for a status post.
 * Order: tracked contacts (active status first) + self JID.
 * Never throws — callers can always post.
 */
export function resolveStatusJidList(socket: unknown, sessionId?: string): string[] {
  const tracked = sessionId ? getStatusJidList(sessionId) : [];
  const self = selfJidOf(socket);
  const list = [...new Set([...tracked, ...(self ? [self] : [])])].filter(isUserJid);
  return list;
}
