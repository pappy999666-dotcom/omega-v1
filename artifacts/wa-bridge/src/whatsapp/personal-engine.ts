// ============================================================
// WA-Bridge — Personal Engine
//
// View Once Engine · Anti Delete Engine · Personal Status
// Platform · AutoSend · AutoDownloadStatus · Status Save ·
// AutoStatusReact
//
// Every setting is ISOLATED per chat / group / session and
// persisted in engine-config.json inside the session folder
// (mirrors the anti-groups.json pattern — no leakage between
// chats, groups or sessions).
//
// All capability claims verified against the installed
// @crysnovax/baileys fork source:
//   • View Once        — viewOnceMessage / V2 / V2Extension
//                        wrappers + downloadMediaMessage(ctx
//                        reuploadRequest) at Utils/messages.js
//   • Status upload    — sendMessage('status@broadcast', …)
//                        at Socket/messages-send.js
//   • Reactions        — sendMessage({ react }) natively
//                        supported (messages-send.js:1051)
//   • Delete events    — messages.update protocolMessage
//                        REVOKE + messages.delete keys
// ============================================================

import fs from 'fs';
import path from 'path';
import { sessionDir, loadSessionConfig } from '../services/workspace.js';
import { resolveStatusJidList } from './utils/status-jids.js';
import { logger } from '../utils/logger.js';
import { errorCard, successCard, warningCard } from '../utils/ascii-art.js';
import type { BridgeWASocket as WASocket, WebMessageInfo } from './baileys-types.js';

// ── Config (isolated per chat / group / session) ──────────────

export type AntiDeleteMode = 'off' | 'on' | 'dm' | 'link';

export interface AntiDeleteConfig {
  mode: AntiDeleteMode;
  /** Destination JID or chat.whatsapp.com invite code for mode: 'link' */
  link?: string;
}

export interface ChatEngineConfig {
  /** .autovv — recover every view-once in this chat automatically */
  autoVV?: boolean;
  antiDelete?: AntiDeleteConfig;
}

export interface SessionEngineConfig {
  /** .autosend — auto-send status content when someone replies asking for it */
  autoSend?: boolean;
  /** .autodstatus — forward contacts' statuses to my own account */
  autoDownloadStatus?: boolean;
  /** .autostatusreact — native reaction to viewed statuses */
  autoStatusReact?: boolean;
  statusReactEmoji?: string;
}

interface EngineFile {
  chats: Record<string, ChatEngineConfig>;
  session: SessionEngineConfig;
}

function defaults(): EngineFile {
  return {
    chats: {},
    session: {
      autoSend: false,
      autoDownloadStatus: false,
      autoStatusReact: false,
      statusReactEmoji: '❤️',
    },
  };
}

function engineConfigPath(telegramId: string, sessionId: string): string {
  return path.join(sessionDir(telegramId, sessionId), 'engine-config.json');
}

function loadEngineFile(telegramId: string, sessionId: string): EngineFile {
  const p = engineConfigPath(telegramId, sessionId);
  if (!fs.existsSync(p)) return defaults();
  try {
    return { ...defaults(), ...(JSON.parse(fs.readFileSync(p, 'utf8')) as EngineFile) };
  } catch (err) {
    logger.warn('[PersonalEngine] failed to parse engine config, resetting', { err: String(err) });
    return defaults();
  }
}

function saveEngineFile(telegramId: string, sessionId: string, file: EngineFile): void {
  const p = engineConfigPath(telegramId, sessionId);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(file, null, 2), 'utf8');
}

export function getChatEngineConfig(
  telegramId: string,
  sessionId: string,
  chatJid: string
): ChatEngineConfig {
  return loadEngineFile(telegramId, sessionId).chats[chatJid] ?? {};
}

export function setChatEngineConfig(
  telegramId: string,
  sessionId: string,
  chatJid: string,
  patch: Partial<ChatEngineConfig>
): ChatEngineConfig {
  const file = loadEngineFile(telegramId, sessionId);
  file.chats[chatJid] = { ...(file.chats[chatJid] ?? {}), ...patch };
  saveEngineFile(telegramId, sessionId, file);
  return file.chats[chatJid]!;
}

export function getSessionEngineConfig(
  telegramId: string,
  sessionId: string
): SessionEngineConfig {
  return loadEngineFile(telegramId, sessionId).session;
}

export function updateSessionEngineConfig(
  telegramId: string,
  sessionId: string,
  patch: Partial<SessionEngineConfig>
): SessionEngineConfig {
  const file = loadEngineFile(telegramId, sessionId);
  file.session = { ...file.session, ...patch };
  saveEngineFile(telegramId, sessionId, file);
  return file.session;
}

// ── Identity helpers ──────────────────────────────────────────

function numOf(jid?: string | null): string {
  if (!jid) return '';
  return (jid.split('@')[0] ?? '').split(':')[0]?.replace(/\D/g, '') ?? '';
}

/** Resolve the session's own WhatsApp JID ("Saved Messages" / self chat). */
export function getSelfJid(
  socket: WASocket,
  telegramId: string,
  sessionId: string
): string | null {
  const me = (socket as unknown as { user?: { id?: string } }).user?.id;
  if (me) {
    const n = numOf(me);
    if (n) return `${n}@s.whatsapp.net`;
  }
  const cfg = loadSessionConfig(telegramId, sessionId);
  const owner = cfg.ownerWaNumbers?.[0];
  if (owner) {
    const n = owner.replace(/\D/g, '');
    if (n) return `${n}@s.whatsapp.net`;
  }
  return null;
}

// ── Media helpers ─────────────────────────────────────────────

const VIEW_ONCE_KEYS = ['viewOnceMessage', 'viewOnceMessageV2', 'viewOnceMessageV2Extension'] as const;

function unwrap(raw: unknown): { inner: any; viewOnce: boolean } {
  let r: any = (raw ?? {}) as Record<string, any>;
  let viewOnce = false;
  // Descend through every supported wrapper (view-once V1 / V2 / V2Extension
  // + ephemeral) so nested or combined wrappers always resolve to the real
  // content message.
  for (let i = 0; i < 8; i++) {
    if (!r || typeof r !== 'object') break;
    const vo = VIEW_ONCE_KEYS.find((k) => Boolean(r[k]));
    if (vo) {
      viewOnce = true;
      r = r[vo]?.message ?? r[vo];
      continue;
    }
    if (r.ephemeralMessage?.message) {
      r = r.ephemeralMessage.message;
      continue;
    }
    break;
  }
  // Some clients strip the view-once wrapper inside quotedMessage but keep
  // the media flagged viewOnce:true — treat that as view-once too.
  const mediaNode = r?.imageMessage ?? r?.videoMessage ?? r?.audioMessage;
  if (!viewOnce && mediaNode && mediaNode.viewOnce === true) viewOnce = true;
  return { inner: r, viewOnce };
}

/**
 * Download message media using the fork's downloadMediaMessage with the
 * reupload ctx — REQUIRED for view-once / expired messages, which need an
 * updateMediaMessage re-upload before their bytes can be fetched.
 */
async function downloadMedia(socket: WASocket, source: WebMessageInfo): Promise<Buffer | null> {
  try {
    const baileys = await import('@crysnovax/baileys') as Record<string, any>;
    const fn = baileys.downloadMediaMessage as
      | ((m: unknown, t: string, o: unknown, c?: unknown) => Promise<Buffer>)
      | undefined;
    if (!fn) return null;
    const sock = socket as unknown as { updateMediaMessage?: (m: unknown) => Promise<unknown> };
    const ctx = {
      logger,
      reuploadRequest: typeof sock.updateMediaMessage === 'function'
        ? (m: unknown) => sock.updateMediaMessage!(m)
        : undefined,
    };
    return await fn(source, 'buffer', {}, ctx);
  } catch (err) {
    logger.warn('[PersonalEngine] media download failed', { err: String(err) });
    return null;
  }
}

export interface RecoveredMedia {
  buffer: Buffer;
  type: 'image' | 'video' | 'audio' | 'sticker' | 'document';
  mimeType: string;
  caption?: string;
  fileName?: string;
  ptt?: boolean;
  gifPlayback?: boolean;
}

/** Recover media from a message — including view-once / ephemeral wrappers. */
export async function recoverMedia(
  socket: WASocket,
  source: WebMessageInfo
): Promise<RecoveredMedia | null> {
  const { inner } = unwrap(source.message as unknown);
  const node = inner?.imageMessage
    ? { type: 'image' as const, n: inner.imageMessage }
    : inner?.videoMessage
      ? { type: 'video' as const, n: inner.videoMessage }
      : inner?.audioMessage
        ? { type: 'audio' as const, n: inner.audioMessage }
        : inner?.stickerMessage
          ? { type: 'sticker' as const, n: inner.stickerMessage }
          : inner?.documentMessage
            ? { type: 'document' as const, n: inner.documentMessage }
            : null;
  if (!node) return null;

  const buffer = await downloadMedia(socket, source);
  if (!buffer) return null;

  const mimeType = node.n?.mimetype
    ?? (node.type === 'audio' ? 'audio/ogg; codecs=opus'
      : node.type === 'video' ? 'video/mp4'
        : node.type === 'sticker' ? 'image/webp'
          : node.type === 'document' ? 'application/octet-stream'
            : 'image/jpeg');

  return {
    buffer,
    type: node.type,
    mimeType,
    caption: node.n?.caption,
    fileName: node.n?.fileName,
    ptt: Boolean(node.n?.ptt),
    gifPlayback: node.type === 'video' ? Boolean((node.n as any)?.gifPlayback) : undefined,
  };
}

export function isViewOnceMessage(msg: WebMessageInfo): boolean {
  return unwrap(msg.message as unknown).viewOnce;
}

function contextInfoOf(message: unknown): any {
  const raw = (message ?? {}) as Record<string, any>;
  return raw.extendedTextMessage?.contextInfo
    ?? raw.imageMessage?.contextInfo
    ?? raw.videoMessage?.contextInfo
    ?? (raw.stickerMessage as any)?.contextInfo
    ?? (raw as any).audioMessage?.contextInfo
    ?? (raw.documentMessage as any)?.contextInfo
    ?? null;
}

export function quotedMessageOf(msg: WebMessageInfo): any {
  return contextInfoOf(msg.message)?.quotedMessage ?? null;
}

/**
 * Build a WebMessageInfo for the QUOTED message that carries the ORIGINAL
 * message key (contextInfo.stanzaId / participant / remoteJid).
 *
 * CRITICAL for view-once recovery: the fork's downloadMediaMessage reupload
 * flow (Utils/messages.js) matches the media-retry response by
 * message.key.id. Using the command's own key makes the retry request
 * unresolvable and recovery silently fails — the quoted key must be used.
 */
export function quotedSourceOf(msg: WebMessageInfo): WebMessageInfo | null {
  const ctx = contextInfoOf(msg.message);
  if (!ctx?.quotedMessage) return null;
  return {
    key: {
      id: String(ctx.stanzaId ?? ''),
      remoteJid: String(ctx.remoteJid ?? msg.key?.remoteJid ?? ''),
      participant: ctx.participant,
      fromMe: false,
    },
    message: ctx.quotedMessage,
  } as unknown as WebMessageInfo;
}

function extractTextOf(message: unknown): string {
  const { inner } = unwrap(message);
  if (!inner) return '';
  return inner.conversation
    ?? inner.extendedTextMessage?.text
    ?? inner.imageMessage?.caption
    ?? inner.videoMessage?.caption
    ?? inner.documentMessage?.caption
    ?? '';
}

/** Build a sendMessage media payload preserving quality / codec / metadata. */
function mediaContent(media: RecoveredMedia, caption: string): Record<string, unknown> {
  if (media.type === 'image') return { image: media.buffer, caption, mimetype: media.mimeType };
  if (media.type === 'video') {
    return { video: media.buffer, caption, mimetype: media.mimeType, gifPlayback: media.gifPlayback ?? false };
  }
  if (media.type === 'audio') return { audio: media.buffer, mimetype: media.mimeType, ptt: media.ptt ?? false };
  if (media.type === 'document') {
    return { document: media.buffer, fileName: media.fileName ?? 'file', mimetype: media.mimeType, caption };
  }
  return { sticker: media.buffer, mimetype: media.mimeType };
}

// ── VIEW ONCE ENGINE ──────────────────────────────────────────
// .vv    → recover view-once media, resend as NORMAL media in this chat
// .vvdm  → recover and send to my own Saved Messages
// .autovv on|off → per-chat automatic recovery

export async function cmdViewOnce(
  socket: WASocket,
  sessionId: string,
  telegramId: string,
  chatJid: string,
  msg: WebMessageInfo,
  toSelf: boolean,
  prefix: string
): Promise<string> {
  const candidates = [
    quotedSourceOf(msg), // quoted view-once → carries the ORIGINAL key (stanzaId)
    msg.message ? ({ key: msg.key, message: msg.message } as unknown as WebMessageInfo) : null,
  ];
  for (const cand of candidates) {
    if (!cand) continue;
    const { inner, viewOnce } = unwrap(cand.message as unknown);
    if (!viewOnce) continue;
    if (!inner?.imageMessage && !inner?.videoMessage) continue;
    const media = await recoverMedia(socket, cand);
    if (!media) {
      return errorCard('VIEW ONCE', 'Could not recover the media. It may have expired.');
    }
    const target = toSelf ? getSelfJid(socket, telegramId, sessionId) : chatJid;
    if (!target) return errorCard('VIEW ONCE', 'No self chat found for this session.');
    try {
      await socket.sendMessage(target, mediaContent(media, media.caption ?? '') as any);
      return toSelf
        ? successCard('VIEW ONCE SAVED', 'Media recovered and sent to your Saved Messages.', [['Type', media.type]])
        : successCard('VIEW ONCE RECOVERED', 'Media sent as a normal message (view-once removed).', [['Type', media.type]]);
    } catch (err) {
      return errorCard('VIEW ONCE', `Send failed: ${String(err).slice(0, 120)}`);
    }
  }
  return errorCard('VIEW ONCE', `Reply to a View Once image or video.\nUsage: ${prefix}vv  |  ${prefix}vvdm`);
}

export async function maybeAutoViewOnce(
  socket: WASocket,
  sessionId: string,
  telegramId: string,
  msg: WebMessageInfo
): Promise<void> {
  if (msg.key?.fromMe) return;
  const chat = msg.key.remoteJid ?? '';
  if (!chat || chat === 'status@broadcast') return;
  const cfg = getChatEngineConfig(telegramId, sessionId, chat);
  if (!cfg.autoVV) return;
  if (!isViewOnceMessage(msg)) return;
  const { inner } = unwrap(msg.message as unknown);
  if (!inner?.imageMessage && !inner?.videoMessage) return;
  try {
    const media = await recoverMedia(socket, msg);
    if (!media) return;
    await socket.sendMessage(chat, mediaContent(media, media.caption ?? '') as any);
    logger.info('[AutoVV] view-once recovered', { sessionId, chat });
  } catch (err) {
    logger.warn('[AutoVV] recovery failed', { err: String(err) });
  }
}

export function cmdAutoVV(
  telegramId: string,
  sessionId: string,
  chatJid: string,
  args: string[],
  prefix: string
): string {
  if (!chatJid || chatJid === 'status@broadcast') {
    return errorCard('AUTO VIEW ONCE', 'Use inside a chat or group.');
  }
  const sub = args[0]?.toLowerCase();
  if (sub !== 'on' && sub !== 'off') {
    const current = getChatEngineConfig(telegramId, sessionId, chatJid).autoVV ? 'ON' : 'OFF';
    return warningCard('AUTO VIEW ONCE', `Current: ${current}\n\nUsage: ${prefix}autovv <on|off>`);
  }
  setChatEngineConfig(telegramId, sessionId, chatJid, { autoVV: sub === 'on' });
  return sub === 'on'
    ? successCard('AUTO VIEW ONCE', 'Every view-once in this chat will be recovered and resent as normal media.')
    : successCard('AUTO VIEW ONCE', 'Auto recovery disabled for this chat.');
}

// ── ANTI DELETE ENGINE ────────────────────────────────────────
// .antidelete on         → recover deleted messages back into the SAME chat
// .antidelete dm         → recover into my Saved Messages (with metadata)
// .antidelete link <dst> → forward to a configured group / chat
// .antidelete off        → disable for this chat only

const deletedCache = new Map<string, Map<string, { msg: WebMessageInfo; ts: number }>>();
const DELETED_CACHE_MAX = 500;

/** Remember every incoming message so a later revoke can be recovered. */
export function cacheMessage(sessionId: string, msg: WebMessageInfo): void {
  const id = msg?.key?.id;
  if (!id) return;
  // Skip messages that can never be resurrected: our own sends and status
  // broadcasts. Keeps the cache small and the hot path O(1).
  if (msg.key?.fromMe) return;
  if (msg.key?.remoteJid === 'status@broadcast') return;
  let map = deletedCache.get(sessionId);
  if (!map) {
    map = new Map();
    deletedCache.set(sessionId, map);
  }
  map.set(id, { msg, ts: Date.now() });
  // O(1) eviction: Map preserves insertion order, so the first key is oldest.
  if (map.size > DELETED_CACHE_MAX) {
    const oldestKey = map.keys().next().value;
    if (oldestKey !== undefined) map.delete(oldestKey);
  }
}

function contentKind(message: unknown): string {
  const { inner } = unwrap(message);
  if (!inner) return 'text';
  if (inner.conversation || inner.extendedTextMessage) return 'text';
  if (inner.imageMessage) return 'image';
  if (inner.videoMessage) return 'video';
  if (inner.audioMessage) return inner.audioMessage.ptt ? 'voice note' : 'audio';
  if (inner.stickerMessage) return 'sticker';
  if (inner.documentMessage) return 'document';
  if (inner.contactMessage) return 'contact';
  if (inner.pollCreationMessage || inner.pollCreationMessageV2) return 'poll';
  if (inner.locationMessage) return 'location';
  if (inner.liveLocationMessage) return 'live location';
  return 'message';
}

function fmtTime(ts?: number): string {
  if (!ts) return '—';
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return '—';
  }
}

async function resolveDestination(socket: WASocket, dest: string): Promise<string | null> {
  const trimmed = dest.trim();
  if (trimmed.endsWith('@g.us') || trimmed.endsWith('@s.whatsapp.net') || trimmed.endsWith('@lid')) {
    return trimmed;
  }
  const m = trimmed.match(/chat\.whatsapp\.com\/([A-Za-z0-9_-]+)/);
  if (m) {
    try {
      const info = await socket.groupGetInviteInfo(m[1]);
      return info.id;
    } catch {
      return null;
    }
  }
  return null;
}

export async function handleDeletedKey(
  socket: WASocket,
  sessionId: string,
  telegramId: string,
  key: { remoteJid?: string; id?: string; participant?: string } | null | undefined
): Promise<void> {
  const chatJid = key?.remoteJid ?? '';
  const id = key?.id ?? '';
  const revokeParticipant = key?.participant ?? '';
  if (!chatJid || !id) return;

  const cfg = getChatEngineConfig(telegramId, sessionId, chatJid).antiDelete;
  if (!cfg || cfg.mode === 'off') return;

  const entry = deletedCache.get(sessionId)?.get(id);
  if (!entry) return;
  if (entry.msg.key?.fromMe) return; // never resurrect our own deletions
  deletedCache.get(sessionId)?.delete(id); // recover once only

  const { msg } = entry;
  const senderJid = revokeParticipant || msg.key?.participant || msg.key?.remoteJid || '';
  const kind = contentKind(msg.message);
  const text = extractTextOf(msg.message);
  const senderName = msg.pushName || numOf(senderJid) || 'Unknown';
  const sentTs = Number(msg.messageTimestamp ?? 0) > 0
    ? Number(msg.messageTimestamp) * 1000
    : entry.ts;

  let chatName = chatJid.endsWith('@g.us') ? chatJid.split('@')[0] ?? chatJid : chatJid;
  // Only fetch group metadata for actual groups — avoids a network round-trip
  // on every DM recovery.
  if (chatJid.endsWith('@g.us')) {
    try {
      const meta = await (socket as unknown as {
        groupMetadata(jid: string): Promise<{ subject?: string }>;
      }).groupMetadata(chatJid);
      chatName = meta?.subject ?? chatName;
    } catch { /* non-critical */ }
  }

  const header = [
    '🕵️ DELETED MESSAGE RECOVERED',
    `Chat: ${chatName}`,
    `Sender: ${senderName}`,
    `Sent: ${fmtTime(sentTs)}`,
    `Deleted: ${fmtTime(Date.now())}`,
    `Type: ${kind}`,
  ].join('\n');

  const self = getSelfJid(socket, telegramId, sessionId);
  let dest: string | null = chatJid;
  if (cfg.mode === 'dm') {
    dest = self;
  } else if (cfg.mode === 'link') {
    if (!cfg.link) return;
    dest = await resolveDestination(socket, cfg.link).catch(() => null);
  }
  if (!dest) return;

  try {
    const media = await recoverMedia(socket, msg);
    if (media && media.type !== 'sticker') {
      const caption = `${header}${media.caption ? `\nCaption: ${media.caption}` : ''}`;
      await socket.sendMessage(dest, mediaContent(media, caption) as any);
    } else if (text) {
      await socket.sendMessage(dest, { text: `${header}\n\n${text}` });
    } else if (media?.type === 'sticker') {
      await socket.sendMessage(dest, { sticker: media.buffer, mimetype: media.mimeType } as any);
    } else {
      await socket.sendMessage(dest, { text: header });
    }
    logger.info('[AntiDelete] recovered', { sessionId, chat: chatJid, mode: cfg.mode, kind });
  } catch (err) {
    logger.warn('[AntiDelete] send failed', { err: String(err) });
  }
}

export async function cmdAntiDelete(
  socket: WASocket,
  telegramId: string,
  sessionId: string,
  chatJid: string,
  args: string[],
  prefix: string
): Promise<string> {
  if (!chatJid || chatJid === 'status@broadcast') {
    return errorCard('ANTI DELETE', 'Use inside a chat or group.');
  }
  const sub = args[0]?.toLowerCase();
  if (sub === 'off') {
    setChatEngineConfig(telegramId, sessionId, chatJid, { antiDelete: { mode: 'off' } });
    return successCard('ANTI DELETE', 'Disabled for this chat.');
  }
  if (sub === 'on') {
    setChatEngineConfig(telegramId, sessionId, chatJid, { antiDelete: { mode: 'on' } });
    return successCard('ANTI DELETE', 'Deleted messages will be reposted in this chat.');
  }
  if (sub === 'dm') {
    setChatEngineConfig(telegramId, sessionId, chatJid, { antiDelete: { mode: 'dm' } });
    return successCard('ANTI DELETE', 'Deleted messages will be sent to your Saved Messages.');
  }
  if (sub === 'link') {
    const dest = args[1];
    if (!dest) {
      return warningCard('ANTI DELETE', `Usage: ${prefix}antidelete link <group-jid-or-invite-link>`);
    }
    const resolved = await resolveDestination(socket, dest).catch(() => null);
    if (!resolved) {
      return errorCard('ANTI DELETE', 'Invalid destination. Provide a group JID or a chat.whatsapp.com invite link.');
    }
    setChatEngineConfig(telegramId, sessionId, chatJid, { antiDelete: { mode: 'link', link: dest } });
    return successCard('ANTI DELETE', 'Recovered messages will be forwarded to the configured destination.');
  }
  const current = getChatEngineConfig(telegramId, sessionId, chatJid).antiDelete ?? { mode: 'off' as const };
  return warningCard(
    'ANTI DELETE',
    `Current: ${current.mode.toUpperCase()}${current.link ? ` → ${current.link}` : ''}\n\n` +
    `Usage: ${prefix}antidelete <on|dm|link <dest>|off>`
  );
}

// ── PERSONAL STATUS PLATFORM ──────────────────────────────────
// .pstatus <text>  or  reply to image/video/audio/document
// Posts to my own WhatsApp Status (status@broadcast).

export interface MyStatusEntry {
  kind: 'text' | 'image' | 'video' | 'audio' | 'document';
  text?: string;
  buffer?: Buffer;
  mimeType?: string;
  caption?: string;
  fileName?: string;
  ptt?: boolean;
  gifPlayback?: boolean;
  ts: number;
}

/** sessionId → status message id → posted content (for AutoSend) */
const myStatuses = new Map<string, Map<string, MyStatusEntry>>();
const MY_STATUSES_MAX = 10;

function trackStatus(sessionId: string, keyId: string, entry: MyStatusEntry): void {
  let map = myStatuses.get(sessionId);
  if (!map) {
    map = new Map();
    myStatuses.set(sessionId, map);
  }
  map.set(keyId, entry);
  if (map.size > MY_STATUSES_MAX) {
    const oldest = [...map.entries()].sort((a, b) => a[1].ts - b[1].ts)[0];
    if (oldest) map.delete(oldest[0]);
  }
}

export async function cmdPStatus(
  socket: WASocket,
  telegramId: string,
  sessionId: string,
  msg: WebMessageInfo,
  text: string,
  prefix: string
): Promise<string> {
  const { inner } = unwrap(msg.message as unknown);
  const directMedia = Boolean(inner?.imageMessage || inner?.videoMessage || inner?.audioMessage || inner?.documentMessage);
  const sourceMedia = directMedia ? msg : quotedSourceOf(msg);

  const media = sourceMedia ? await recoverMedia(socket, sourceMedia) : null;
  let content: Record<string, unknown>;
  let kind: MyStatusEntry['kind'];

  if (media) {
    if (media.type === 'sticker') {
      return errorCard('PERSONAL STATUS', "Sticker statuses aren't supported by WhatsApp Status. Post the image instead.");
    }
    if (media.type === 'document') {
      return errorCard('PERSONAL STATUS', "Document statuses aren't supported by WhatsApp Status. Use an image, video or audio instead.");
    }
    const caption = text && !media.caption ? text : (media.caption ?? (text ?? ''));
    kind = media.type as MyStatusEntry['kind'];
    content = mediaContent(media, caption);
  } else {
    if (sourceMedia && !text) {
      // A quoted/direct media was detected but its bytes could not be
      // downloaded (expired, view-once, or stale URL) — be explicit.
      return errorCard('PERSONAL STATUS', 'Could not download the replied media — it may have expired.');
    }
    if (!text) {
      return errorCard('PERSONAL STATUS', `Reply to media or send text.\nUsage: ${prefix}pstatus <text>`);
    }
    kind = 'text';
    content = { text };
  }

  // The fork's sendMessage status branch REQUIRES a non-empty statusJidList
  // (normalizeStatusJidList throws "statusJidList must contain at least one
  // recipient JID" otherwise). Resolve it, and guarantee at least the
  // session's own JID so posting NEVER fails on an empty list.
  let statusJidList = resolveStatusJidList(socket, sessionId);
  if (statusJidList.length === 0) {
    const self = getSelfJid(socket, telegramId, sessionId);
    if (self) statusJidList = [self];
  }
  if (statusJidList.length === 0) {
    return errorCard('PERSONAL STATUS', 'Cannot resolve any recipient for the status. Reconnect the session and try again.');
  }

  try {
    let res: unknown;
    try {
      res = await socket.sendMessage('status@broadcast', content as any, { statusJidList } as any);
    } catch (err) {
      // Retry with ONLY the session's own JID if the fork still rejects the
      // list (fresh account with zero tracked contacts). Never swallow real
      // send failures.
      if (!String(err).includes('statusJidList')) throw err;
      const self = getSelfJid(socket, telegramId, sessionId);
      if (!self) throw err;
      res = await socket.sendMessage('status@broadcast', content as any, { statusJidList: [self] } as any);
    }
    const keyId = (res as unknown as { key?: { id?: string } })?.key?.id;
    if (keyId) {
      trackStatus(
        sessionId,
        keyId,
        kind === 'text'
          ? { kind, text, ts: Date.now() }
          : {
              kind,
              buffer: media?.buffer,
              mimeType: media?.mimeType,
              caption: content.caption as string | undefined,
              fileName: media?.fileName,
              ptt: media?.ptt,
              gifPlayback: media?.gifPlayback,
              ts: Date.now(),
            }
      );
    }
    return successCard('PERSONAL STATUS', `Status posted${kind === 'text' ? '' : ` (${kind})`}.`);
  } catch (err) {
    return errorCard('PERSONAL STATUS', `Post failed: ${String(err).slice(0, 120)}`);
  }
}

// ── AUTOSEND ──────────────────────────────────────────────────
// .autosend on|off — when someone replies to one of my statuses
// asking for it, the ORIGINAL status content is sent to them.

const AUTO_SEND_PATTERN = /\b(send|please|can i|may i|give me|i want|share)\b/i;
const autoSendSent = new Set<string>();

export async function maybeAutoSend(
  socket: WASocket,
  sessionId: string,
  telegramId: string,
  msg: WebMessageInfo,
  text: string
): Promise<void> {
  if (msg.key?.fromMe) return;
  const chat = msg.key.remoteJid ?? '';
  if (!chat || chat.endsWith('@g.us') || chat === 'status@broadcast') return;

  const cfg = getSessionEngineConfig(telegramId, sessionId);
  if (!cfg.autoSend) return;

  const stanzaId = contextInfoOf(msg.message)?.stanzaId;
  if (!stanzaId) return;
  const entry = myStatuses.get(sessionId)?.get(stanzaId);
  if (!entry) return;
  if (!AUTO_SEND_PATTERN.test(text)) return;

  const dedupe = `${sessionId}:${stanzaId}:${chat}`;
  if (autoSendSent.has(dedupe)) return;
  autoSendSent.add(dedupe);

  try {
    if (entry.kind === 'text') {
      await socket.sendMessage(chat, { text: entry.text ?? '' });
    } else if (entry.buffer) {
      const media: RecoveredMedia = {
        buffer: entry.buffer,
        type: entry.kind as RecoveredMedia['type'],
        mimeType: entry.mimeType ?? '',
        caption: entry.caption,
        fileName: entry.fileName,
        ptt: entry.ptt,
        gifPlayback: entry.gifPlayback,
      };
      await socket.sendMessage(chat, mediaContent(media, entry.caption ?? '') as any);
    } else {
      return;
    }
    logger.info('[AutoSend] status content sent', { sessionId, to: chat });
  } catch (err) {
    logger.warn('[AutoSend] failed', { err: String(err) });
  }
}

export function cmdAutoSend(
  telegramId: string,
  sessionId: string,
  args: string[],
  prefix: string
): string {
  const sub = args[0]?.toLowerCase();
  if (sub !== 'on' && sub !== 'off') {
    const current = getSessionEngineConfig(telegramId, sessionId).autoSend ? 'ON' : 'OFF';
    return warningCard('AUTO SEND', `Current: ${current}\n\nUsage: ${prefix}autosend <on|off>`);
  }
  updateSessionEngineConfig(telegramId, sessionId, { autoSend: sub === 'on' });
  return sub === 'on'
    ? successCard('AUTO SEND', 'When someone replies to your status asking for it, the original content will be sent to them.')
    : successCard('AUTO SEND', 'Disabled.');
}

// ── AUTODSTATUS + AUTOSTATUSREACT ─────────────────────────────
// .autodstatus on|off — contacts' statuses are downloaded and
// forwarded to my own account with full metadata.
// .autostatusreact on|off [emoji] — native reaction to statuses.

const seenStatuses = new Set<string>();
const SEEN_STATUS_MAX = 400;

export async function maybeAutoDownloadStatus(
  socket: WASocket,
  sessionId: string,
  telegramId: string,
  msg: WebMessageInfo
): Promise<void> {
  if (msg.key?.remoteJid !== 'status@broadcast' || msg.key?.fromMe) return;

  const cfg = getSessionEngineConfig(telegramId, sessionId);
  const id = msg.key.id ?? '';
  const participant = msg.key.participant ?? '';
  if (!id || seenStatuses.has(`${sessionId}:${id}`)) return;

  // AutoStatusReact — native reaction packet (verified in fork messages-send.js)
  if (cfg.autoStatusReact && cfg.statusReactEmoji) {
    socket
      .sendMessage('status@broadcast', { react: { text: cfg.statusReactEmoji, key: msg.key } } as any)
      .catch(() => undefined);
  }

  if (!cfg.autoDownloadStatus) return;

  seenStatuses.add(`${sessionId}:${id}`);
  if (seenStatuses.size > SEEN_STATUS_MAX) {
    const first = [...seenStatuses][0];
    if (first) seenStatuses.delete(first);
  }

  const self = getSelfJid(socket, telegramId, sessionId);
  if (!self) return;

  const text = extractTextOf(msg.message);
  const kind = contentKind(msg.message);
  const postedTs = Number(msg.messageTimestamp ?? 0) > 0
    ? Number(msg.messageTimestamp) * 1000
    : Date.now();
  const header = [
    '📥 STATUS SAVED',
    `Contact: ${msg.pushName ?? 'Unknown'}`,
    `Phone: ${numOf(participant) || '—'}`,
    `Posted: ${fmtTime(postedTs)}`,
    `Type: ${kind}`,
  ].join('\n');

  try {
    const media = await recoverMedia(socket, msg);
    if (media && media.type !== 'sticker') {
      const caption = `${header}${media.caption ? `\nCaption: ${media.caption}` : ''}`;
      await socket.sendMessage(self, mediaContent(media, caption) as any);
    } else if (text) {
      await socket.sendMessage(self, { text: `${header}\n\n${text}` });
    } else if (media?.type === 'sticker') {
      await socket.sendMessage(self, { sticker: media.buffer, mimetype: media.mimeType } as any);
    } else {
      await socket.sendMessage(self, { text: header });
    }
    logger.info('[AutoDStatus] saved', { sessionId, from: participant });
  } catch (err) {
    logger.warn('[AutoDStatus] failed', { err: String(err) });
  }
}

export function cmdAutoDStatus(
  telegramId: string,
  sessionId: string,
  args: string[],
  prefix: string
): string {
  const sub = args[0]?.toLowerCase();
  if (sub !== 'on' && sub !== 'off') {
    const current = getSessionEngineConfig(telegramId, sessionId).autoDownloadStatus ? 'ON' : 'OFF';
    return warningCard('AUTO STATUS DOWNLOAD', `Current: ${current}\n\nUsage: ${prefix}autodstatus <on|off>`);
  }
  updateSessionEngineConfig(telegramId, sessionId, { autoDownloadStatus: sub === 'on' });
  return sub === 'on'
    ? successCard('AUTO STATUS DOWNLOAD', 'Contacts\' statuses will be forwarded to your Saved Messages with metadata.')
    : successCard('AUTO STATUS DOWNLOAD', 'Disabled.');
}

export function cmdAutoStatusReact(
  telegramId: string,
  sessionId: string,
  args: string[],
  prefix: string
): string {
  const sub = args[0]?.toLowerCase();
  if (sub !== 'on' && sub !== 'off') {
    const cfg = getSessionEngineConfig(telegramId, sessionId);
    const state = cfg.autoStatusReact ? `ON (${cfg.statusReactEmoji})` : 'OFF';
    return warningCard('AUTO STATUS REACT', `Current: ${state}\n\nUsage: ${prefix}autostatusreact <on|off> [emoji]`);
  }
  const emoji = args.slice(1).join('') || undefined;
  updateSessionEngineConfig(telegramId, sessionId, {
    autoStatusReact: sub === 'on',
    ...(sub === 'on' && emoji ? { statusReactEmoji: emoji } : {}),
  });
  return sub === 'on'
    ? successCard('AUTO STATUS REACT', `Native reactions enabled${emoji ? ` — ${emoji}` : ''}.`)
    : successCard('AUTO STATUS REACT', 'Disabled.');
}

// ── STATUS SAVE ───────────────────────────────────────────────
// .sstatus       → save the replied contact status into this chat
// .sstatus dm    → save it to my Saved Messages

export async function cmdSStatusSave(
  socket: WASocket,
  telegramId: string,
  sessionId: string,
  chatJid: string,
  msg: WebMessageInfo,
  dm: boolean,
  prefix: string
): Promise<string> {
  const quoted = quotedMessageOf(msg);
  if (!quoted) {
    return errorCard('STATUS SAVE', `Reply to a contact's status.\nUsage: ${prefix}sstatus${dm ? ' dm' : ''}`);
  }
  const source = { key: msg.key, message: quoted } as unknown as WebMessageInfo;
  const media = await recoverMedia(socket, source);
  const text = extractTextOf(quoted);
  const self = getSelfJid(socket, telegramId, sessionId);
  const target = dm ? self : chatJid;
  if (dm && !target) return errorCard('STATUS SAVE', 'No self chat found for this session.');

  try {
    if (media) {
      if (media.type === 'sticker') {
        await socket.sendMessage(target!, { sticker: media.buffer, mimetype: media.mimeType } as any);
      } else {
        await socket.sendMessage(target!, mediaContent(media, media.caption ?? '') as any);
      }
    } else if (text) {
      await socket.sendMessage(target!, { text });
    } else {
      return errorCard('STATUS SAVE', 'No recoverable content in that status.');
    }
    return successCard('STATUS SAVE', dm ? 'Status sent to your Saved Messages.' : 'Status recovered into this chat.');
  } catch (err) {
    return errorCard('STATUS SAVE', `Failed: ${String(err).slice(0, 120)}`);
  }
}
