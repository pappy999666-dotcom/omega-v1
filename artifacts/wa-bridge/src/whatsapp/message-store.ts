// ============================================================
// WA-Bridge — Per-Session In-Memory Stores
//
// Contact store (LID→phone fallback), message store (getMessage
// for Baileys quoted resolution), upsert dedupe, reactions,
// online-presence tracking.
// ============================================================

import type { WebMessageInfo } from './baileys-types.js';

export interface StoredContact {
  id: string;
  name?: string;
  notify?: string;
  lid?: string;
  phoneNumber?: string;
}

interface StoredMessage {
  message: WebMessageInfo;
  ts: number;
}

class SessionStores {
  contacts = new Map<string, StoredContact>();
  messages = new Map<string, StoredMessage>();
  /** messageId → (senderJid → emoji) */
  reactions = new Map<string, Map<string, string>>();
  online = new Set<string>();
  /** messageId → ts (dedupe + anti-repeat window) */
  seen = new Map<string, number>();
  groupMeta = new Map<string, unknown>();
  readonly maxMessages = 8000;
  readonly maxSeen = 60000;

  evict(): void {
    if (this.messages.size > this.maxMessages) {
      let excess = this.messages.size - this.maxMessages;
      for (const [k] of this.messages) {
        if (excess-- <= 0) break;
        this.messages.delete(k);
      }
    }
    if (this.seen.size > this.maxSeen) {
      const now = Date.now();
      for (const [k, ts] of this.seen) {
        if (now - ts > 10 * 60 * 1000) this.seen.delete(k);
      }
    }
  }
}

const stores = new Map<string, SessionStores>();

export function getStores(sessionId: string): SessionStores {
  let s = stores.get(sessionId);
  if (!s) {
    s = new SessionStores();
    stores.set(sessionId, s);
  }
  return s;
}

/** Drop all runtime state for a session (call on purge). */
export function clearStores(sessionId: string): void {
  stores.delete(sessionId);
}

// ── Message store (getMessage for Baileys) ─────────────────

export function rememberMessage(sessionId: string, msg: WebMessageInfo): void {
  const remoteJid = msg.key?.remoteJid;
  const id = msg.key?.id;
  if (!remoteJid || !id) return;
  const s = getStores(sessionId);
  s.messages.set(`${remoteJid}:${id}`, { message: msg, ts: Date.now() });
  s.evict();
}

export function loadMessage(
  sessionId: string,
  remoteJid: string | null | undefined,
  id: string | null | undefined
): WebMessageInfo | null {
  if (!remoteJid || !id) return null;
  return getStores(sessionId).messages.get(`${remoteJid}:${id}`)?.message ?? null;
}

// ── Upsert dedupe ───────────────────────────────────────────

/** Returns true if the message id is NEW (should be processed). */
export function markSeen(sessionId: string, id: string | null | undefined): boolean {
  if (!id) return false;
  const s = getStores(sessionId);
  const now = Date.now();
  const last = s.seen.get(id);
  if (last && now - last < 10 * 60 * 1000) return false;
  s.seen.set(id, now);
  s.evict();
  return true;
}

// ── Contact store (LID→phone fallback) ──────────────────────

export function upsertContacts(sessionId: string, contacts: Array<Record<string, unknown>>): void {
  if (!contacts?.length) return;
  const s = getStores(sessionId);
  for (const raw of contacts) {
    const c = (raw ?? {}) as Record<string, any>;
    const id = c.id ?? c.jid;
    if (!id) continue;
    const existing = s.contacts.get(id) ?? ({} as Partial<StoredContact>);
    s.contacts.set(id, {
      id: String(id),
      name: c.name ?? existing.name,
      notify: c.notify ?? existing.notify,
      lid: c.lid ?? existing.lid,
      phoneNumber: c.phoneNumber ?? existing.phoneNumber,
    });
    // Index by lid too so lookups by LID can find the contact.
    const lid = c.lid;
    if (lid && lid !== id) {
      s.contacts.set(String(lid), {
        id: String(lid),
        name: c.name ?? existing.name,
        notify: c.notify ?? existing.notify,
        lid: String(lid),
        phoneNumber: c.phoneNumber ?? existing.phoneNumber,
      });
    }
  }
}

export function lookupContact(sessionId: string, jid: string): StoredContact | undefined {
  if (!jid) return undefined;
  return getStores(sessionId).contacts.get(jid);
}

export function contactName(sessionId: string, jid: string): string | null {
  const c = lookupContact(sessionId, jid);
  return c?.name ?? c?.notify ?? null;
}

export function allContacts(sessionId: string): StoredContact[] {
  return [...getStores(sessionId).contacts.values()];
}

// ── Presence (presence.update) ──────────────────────────────

export function setPresence(sessionId: string, jid: string, isOnline: boolean): void {
  const s = getStores(sessionId);
  if (isOnline) s.online.add(jid);
  else s.online.delete(jid);
}

export function getOnlineUsers(sessionId: string): string[] {
  return [...getStores(sessionId).online];
}

// ── Reactions (messages.reaction) ───────────────────────────

export function noteReaction(sessionId: string, messageId: string, senderJid: string, emoji: string): void {
  const s = getStores(sessionId);
  let per = s.reactions.get(messageId);
  if (!per) {
    per = new Map();
    s.reactions.set(messageId, per);
  }
  per.set(senderJid, emoji);
}

export function reactionsFor(sessionId: string, messageId: string): Map<string, string> {
  return getStores(sessionId).reactions.get(messageId) ?? new Map();
}

// ── Group metadata snapshot (groups.update) ─────────────────

export function setGroupMetaSnapshot(sessionId: string, groupJid: string, meta: unknown): void {
  getStores(sessionId).groupMeta.set(groupJid, meta);
}

export function getGroupMetaSnapshot(sessionId: string, groupJid: string): unknown {
  return getStores(sessionId).groupMeta.get(groupJid);
}
