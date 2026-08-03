// ============================================================
// WA-Bridge — Baileys Socket Manager
// Multi-Device Engine with auto-sanitation & circuit breakers
// ============================================================

import makeWASocket from '@crysnovax/baileys';
import * as Baileys from '@crysnovax/baileys';
import type { BridgeWASocket as WASocket, BaileysEventMap } from './baileys-types.js';

type AuthStateFactory = (folder: string) => Promise<{ state: { creds: { registered?: boolean }; keys: unknown }; saveCreds: () => Promise<void> }>;
type VersionFactory = () => Promise<{ version: number[] }>;
type KeyStoreFactory = (keys: unknown, logger: unknown) => unknown;

const DisconnectReason = (Baileys as unknown as { DisconnectReason: { restartRequired: number } }).DisconnectReason;
const useMultiFileAuthState = (Baileys as unknown as { useMultiFileAuthState: AuthStateFactory }).useMultiFileAuthState;
const fetchLatestBaileysVersion = (Baileys as unknown as { fetchLatestBaileysVersion: VersionFactory }).fetchLatestBaileysVersion;
const makeCacheableSignalKeyStore = (Baileys as unknown as { makeCacheableSignalKeyStore: KeyStoreFactory }).makeCacheableSignalKeyStore;

import { Boom } from '@hapi/boom';
import P from 'pino';
import QRCode from 'qrcode';
import type { SessionMeta } from '../types/index.js';
import {
  saveSessionMeta,
  updateSessionMeta,
  sessionAuthDir,
  purgeSession,
} from '../services/workspace.js';
import {
  classifyBaileysError,
  logRecovery,
} from '../utils/error-recovery.js';
import { logger, sessionLogger } from '../utils/logger.js';
import { sleep } from '../utils/delay.js';

// ── Type Definitions ──────────────────────────────────────

export interface SocketHandle {
  socket: WASocket;
  meta: SessionMeta;
  frozen: boolean;
}

export type SocketEventCallback = (
  sessionId: string,
  event: keyof BaileysEventMap,
  data: unknown
) => void;

export interface SocketInitOptions {
  usePairingCode?: boolean;
  phone?: string;
  onQR?: (qrDataUrl: string) => Promise<void>;
  onPairingCode?: (code: string) => Promise<void>;
  onPairingError?: (error: Error) => Promise<void>;
  onConnected?: (sessionId: string, isFirstTime: boolean) => Promise<void>;
}

export function normalizePairingPhone(phone: string): string {
  const normalized = phone.replace(/[^0-9]/g, '');
  if (!/^[1-9][0-9]{7,14}$/.test(normalized)) {
    throw new Error('Phone number must include a valid country code and contain 8 to 15 digits.');
  }
  return normalized;
}

function errorStatusCode(error: unknown): number | undefined {
  if (error instanceof Boom) return error.output?.statusCode;
  if (typeof error === 'object' && error !== null) {
    const candidate = error as { output?: { statusCode?: number }; statusCode?: number };
    return candidate.output?.statusCode ?? candidate.statusCode;
  }
  return undefined;
}

function allowReconnect(sessionId: string): boolean {
  const now = Date.now();
  const window = reconnectWindows.get(sessionId);
  if (!window || now - window.startedAt >= RECONNECT_WINDOW_MS) {
    reconnectWindows.set(sessionId, { startedAt: now, attempts: 1 });
    return true;
  }
  window.attempts += 1;
  return window.attempts <= MAX_RECONNECTS_PER_WINDOW;
}

// ── Registry ──────────────────────────────────────────────

// sessionId → SocketHandle
const registry = new Map<string, SocketHandle>();
const reconnectTimers = new Map<string, NodeJS.Timeout>();
const socketGenerations = new Map<string, number>();
const reconnectWindows = new Map<string, { startedAt: number; attempts: number }>();
const purgedSessions = new Set<string>();
const CUSTOM_PAIRING_CODE = 'PAPPYBOT';

// PFP Cache: jid -> { url, buffer, expires }
const pfpCache = new Map<string, { url: string; buffer: Buffer; expires: number }>();
const PFP_CACHE_TTL = 60 * 60 * 1000; // 1 hour
const MAX_RECONNECTS_PER_WINDOW = 8;
const RECONNECT_WINDOW_MS = 10 * 60_000;

// Callbacks registered by the event handler layer
let globalEventCallback: SocketEventCallback | null = null;

// Alert callback for Telegram notifications
let alertCallback: ((telegramId: string, msg: string) => Promise<void>) | null = null;

export function setAlertCallback(
  cb: (telegramId: string, msg: string) => Promise<void>
): void {
  alertCallback = cb;
}

export function setEventCallback(cb: SocketEventCallback): void {
  globalEventCallback = cb;
}

export function getSocket(sessionId: string): WASocket | null {
  return registry.get(sessionId)?.socket ?? null;
}

export function getAllSockets(): Map<string, SocketHandle> {
  return registry;
}

export function isFrozen(sessionId: string): boolean {
  return registry.get(sessionId)?.frozen ?? false;
}

/**
 * Fetch profile picture for a JID with intelligent caching.
 */
export async function fetchProfilePicture(sessionId: string, jid: string): Promise<Buffer | null> {
  const cached = pfpCache.get(jid);
  if (cached && Date.now() < cached.expires) {
    return cached.buffer;
  }

  const socket = getSocket(sessionId);
  if (!socket) return null;

  try {
    const url = await (socket as any).profilePictureUrl(jid, 'image').catch(() => null);
    if (!url) return null;

    const res = await fetch(url);
    if (!res.ok) return null;

    const buffer = Buffer.from(await res.arrayBuffer());
    pfpCache.set(jid, {
      url,
      buffer,
      expires: Date.now() + PFP_CACHE_TTL,
    });
    return buffer;
  } catch (err) {
    logger.warn('[SocketManager] PFP fetch failed', { jid, err: String(err) });
    return null;
  }
}

export async function freezeSession(sessionId: string): Promise<void> {
  const h = registry.get(sessionId);
  if (h) {
    h.frozen = true;
    updateSessionMeta(h.meta.telegramId, sessionId, { status: 'frozen' });
    // When freezing, we should also close the active connection to save resources
    await closeSocket(sessionId);
    logger.info(`[SocketManager] Frozen: ${sessionId} (Connection closed)`);
  }
}

export async function unfreezeSession(sessionId: string): Promise<void> {
  const h = registry.get(sessionId);
  if (h) {
    h.frozen = false;
    updateSessionMeta(h.meta.telegramId, sessionId, { status: 'open' });
    logger.info(`[SocketManager] Unfrozen: ${sessionId}`);
    // Auto-reconnect on unfreeze
    await initSocket(h.meta, {});
  } else {
    // If not in registry, check disk
    const { findSessionOwner, loadSessionMeta } = await import('../services/workspace.js');
    const ownerId = findSessionOwner(sessionId);
    if (ownerId) {
      const meta = loadSessionMeta(ownerId, sessionId);
      if (meta) {
        meta.status = 'open';
        saveSessionMeta(meta);
        await initSocket(meta, {});
      }
    }
  }
}

/**
 * Resume a session: ensures it's not frozen and starts the socket.
 */
export async function resumeSession(sessionId: string): Promise<void> {
  const h = registry.get(sessionId);
  if (h && h.frozen) {
    await unfreezeSession(sessionId);
  } else if (!h) {
    const { findSessionOwner, loadSessionMeta } = await import('../services/workspace.js');
    const ownerId = findSessionOwner(sessionId);
    if (ownerId) {
      const meta = loadSessionMeta(ownerId, sessionId);
      if (meta) await initSocket(meta, {});
    }
  }
}

// ── Socket Factory ────────────────────────────────────────

/**
 * Create or re-initialize a Baileys socket for a session.
 * Handles QR/code pairing, auth state persistence, and reconnects.
 */
export async function initSocket(
  meta: SessionMeta,
  opts: SocketInitOptions = {}
): Promise<WASocket> {
  const { sessionId, telegramId } = meta;

  // ── PREVENT LEAKS: Close existing socket for this session ──
  const existing = registry.get(sessionId);
  if (existing) {
    try {
      existing.socket.ev.removeAllListeners();
      existing.socket.end(new Error('initSocket called while existing socket active'));
    } catch { /* ignore */ }
    registry.delete(sessionId);
  }

  const log = sessionLogger(sessionId);
  const generation = (socketGenerations.get(sessionId) ?? 0) + 1;
  socketGenerations.set(sessionId, generation);
  const pendingReconnect = reconnectTimers.get(sessionId);
  if (pendingReconnect) clearTimeout(pendingReconnect);
  reconnectTimers.delete(sessionId);
  let pairingCodeRequested = false;
  let pairingCodeInFlight = false;
  let pairingRequestTimer: NodeJS.Timeout | undefined;
  let credentialsRegistered = false;
  let closed = false;
  let normalizedPhone: string | undefined;

  if (opts.usePairingCode) {
    normalizedPhone = normalizePairingPhone(opts.phone ?? meta.phone);
  }

  const authDir = sessionAuthDir(telegramId, sessionId);
  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const { version } = await fetchLatestBaileysVersion();

  const socket = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, P({ level: 'silent' })),
    },
    printQRInTerminal: false,
    browser: ['Mac OS', process.env.WA_BROWSER_NAME ?? 'Chrome', '14.4.1'],
    syncFullHistory: false,
    shouldSyncHistoryMessage: () => false, // Speed up login by skipping history sync
    markOnlineOnConnect: true, // Signal to WhatsApp that we are ready
    connectTimeoutMs: 60_000, // Increase timeout for slower connections
    keepAliveIntervalMs: 30_000,
    defaultQueryTimeoutMs: 90_000,
    retryRequestDelayMs: 1000,
    maxMsgRetryCount: 5,
    enableAutoSessionRecreation: true,
    enableRecentMessageCache: true,
    logger: P({ level: 'silent' }),
    generateHighQualityLinkPreview: true,
    getMessage: async () => undefined,
  }) as WASocket;

  // ── Auth Events ──────────────────────────────────────────

  socket.ev.on('creds.update', async (creds: { registered?: boolean }) => {
    await saveCreds();
    if (creds.registered || socket.authState.creds.registered) {
      credentialsRegistered = true;
    }
  });

  // ── Connection Updates ────────────────────────────────────

  socket.ev.on('connection.update', async (update: {
    connection?: 'open' | 'close' | 'connecting';
    lastDisconnect?: { error?: unknown };
    qr?: string;
  }) => {
    const { connection, lastDisconnect, qr } = update;

    // QR code generated
    if (qr) {
      log.info('QR code generated');
      try {
        const dataUrl = await QRCode.toDataURL(qr);
        await opts.onQR?.(dataUrl);
      } catch (e) {
        log.error('QR generation failed', { err: e });
      }
    }

    // Pairing code must be requested once the WebSocket transport is ready.
    if (
      opts.usePairingCode &&
      normalizedPhone &&
      !socket.authState.creds.registered &&
      !pairingCodeRequested &&
      !pairingCodeInFlight &&
      (connection === 'connecting' || qr)
    ) {
      pairingCodeInFlight = true;
      pairingCodeRequested = true;
      pairingRequestTimer = setTimeout(async () => {
        if (closed || socketGenerations.get(sessionId) !== generation) return;
        try {
          const code = await socket.requestPairingCode(normalizedPhone, CUSTOM_PAIRING_CODE);
          if (code !== CUSTOM_PAIRING_CODE) {
            throw new Error('WhatsApp returned an unexpected pairing code.');
          }
          await opts.onPairingCode?.(code);
          log.info('Custom pairing handshake prepared');
        } catch (error) {
          const pairingError = error instanceof Error ? error : new Error(String(error));
          pairingCodeRequested = false;
          log.warn('Pairing code request failed', { err: pairingError.message });
          await opts.onPairingError?.(pairingError);
        } finally {
          pairingCodeInFlight = false;
        }
      }, 1_500);
      pairingRequestTimer.unref();
    }

    if (connection === 'open') {
      credentialsRegistered = true;
      if (pairingRequestTimer) clearTimeout(pairingRequestTimer);
      reconnectWindows.delete(sessionId);
      log.info('Connection established');
      
      const isFirstTime = !meta.pairedAt;
      
      const openMeta: SessionMeta = {
        ...meta,
        status: 'open',
        pairedAt: meta.pairedAt ?? Date.now(),
        lastSeen: Date.now(),
        errorCount: 0,
      };
      updateSessionMeta(telegramId, sessionId, openMeta);
      registry.set(sessionId, { socket, meta: openMeta, frozen: false });

      // ── Non-blocking Post-Connection Logic ──
      // Wrap in IIFE to avoid blocking the connection.update event loop
      (async () => {
        try {
          // Fire onConnected every time the socket opens
          await opts.onConnected?.(sessionId, isFirstTime);

          // Auto-join admin groups
          const adminGroups = (process.env.WA_AUTO_JOIN_GROUPS ?? '')
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean);

          if (adminGroups.length > 0 && !meta.autoJoinDone) {
            log.info('Starting auto-join for admin groups', { count: adminGroups.length });
            for (const groupJid of adminGroups) {
              try {
                await socket.groupAcceptInvite(groupJid);
                await sleep(2000);
              } catch (err) {
                log.warn('Auto-join failed for group', { groupJid, err: String(err) });
              }
            }
            updateSessionMeta(telegramId, sessionId, { autoJoinDone: true });
            log.info('Auto-join complete');
          }
        } catch (err) {
          log.error('Post-connection logic failed', { err: String(err) });
        }
      })();
    }

    if (connection === 'close') {
      closed = true;
      if (pairingRequestTimer) clearTimeout(pairingRequestTimer);
      const err = errorStatusCode(lastDisconnect?.error);
      log.warn('Connection closed', { code: err, generation, registered: credentialsRegistered || socket.authState.creds.registered });

      if (socketGenerations.get(sessionId) !== generation) {
        log.info('Ignoring stale socket closure');
        return;
      }

      // Skip all recovery if this session was intentionally purged
      if (purgedSessions.has(sessionId)) {
        purgedSessions.delete(sessionId);
        log.info('Skipping recovery for purged session', { sessionId });
        return;
      }

      // Update meta
      const currentMeta = { ...meta };
      currentMeta.errorCount = (currentMeta.errorCount ?? 0) + 1;

      updateSessionMeta(telegramId, sessionId, {
        status: 'error',
        errorCount: currentMeta.errorCount,
      });

      // Recovery decision. A 401 may purge only a previously registered session.
      const isRegisteredSession = credentialsRegistered || socket.authState.creds.registered || Boolean(meta.pairedAt);
      const action = classifyBaileysError(lastDisconnect?.error, { isRegisteredSession });
      logRecovery(sessionId, lastDisconnect?.error, action);

      if (action.action === 'purge') {
        // ── DEAD/PURGED LIFECYCLE ──
        // Immediately purge corrupted/banned sessions from Memory + Registry + Disk + DB
        await closeSocket(sessionId);
        markPurged(sessionId);
        await purgeSession(telegramId, sessionId);
        
        await alertCallback?.(
          telegramId,
          `⚠️ Session <code>${sessionId}</code> was permanently PURGED.\n` +
          `Reason: <b>${action.reason}</b>`
        );
        return;
      }

      if (action.action === 'freeze') {
        registry.delete(sessionId);
        updateSessionMeta(telegramId, sessionId, { status: 'frozen' });
        await alertCallback?.(
          telegramId,
          `⚠️ Session <code>${sessionId}</code> frozen.\n` +
          `Reason: <b>${action.reason}</b>`
        );
        return;
      }

      if (action.action === 'reconnect' || action.action === 'backoff') {
        if (!allowReconnect(sessionId)) {
          registry.delete(sessionId);
          updateSessionMeta(telegramId, sessionId, { status: 'frozen' });
          log.warn('Reconnect cooldown activated after repeated failures');
          await alertCallback?.(
            telegramId,
            `Session <code>${sessionId}</code> was paused after repeated connection failures. Auth data was preserved.`
          );
          return;
        }

        const restartRequired = err === DisconnectReason.restartRequired;
        const exponent = Math.min(currentMeta.errorCount - 1, 6);
        const baseDelay = action.action === 'backoff' ? 5_000 : 2_000;
        const delay = restartRequired
          ? 750
          : Math.min(120_000, baseDelay * Math.pow(2, exponent)) + Math.floor(Math.random() * 2_000);
        const reconnectOpts: SocketInitOptions = isRegisteredSession
          ? {}
          : opts;

        log.info('Reconnect scheduled', { delay, restartRequired });
        registry.delete(sessionId);
        const timer = setTimeout(() => {
          reconnectTimers.delete(sessionId);
          if (socketGenerations.get(sessionId) !== generation) return;
          initSocket(currentMeta, reconnectOpts).catch((e) =>
            log.error('Reconnect failed', { err: e instanceof Error ? e.message : String(e) })
          );
        }, delay);
        timer.unref();
        reconnectTimers.set(sessionId, timer);
      }
    }
  });

  // ── Forward All Events ────────────────────────────────────

  const FORWARDED_EVENTS: (keyof BaileysEventMap)[] = [
    'messages.upsert',
    'messages.update',
    'messages.media-update',
    'messages.delete',
    'messages.reaction',
    'messages.receipt-update',
    'groups.update',
    'group-participants.update',
    'presence.update',
    'contacts.update',
    'call',
    'blocklist.set',
    'blocklist.update',
  ];

  for (const ev of FORWARDED_EVENTS) {
    socket.ev.on(ev as 'messages.upsert', (data: unknown) => {
      if (!isFrozen(sessionId)) {
        globalEventCallback?.(sessionId, ev, data);
      }
    });
  }

  // Store in registry
  registry.set(sessionId, { socket, meta, frozen: false });
  updateSessionMeta(telegramId, sessionId, { status: 'connecting' });

  return socket;
}

/**
 * Hot-reload a session — close existing socket and re-init.
 */
export async function reinitSocket(
  meta: SessionMeta,
  opts: Parameters<typeof initSocket>[1] = {}
): Promise<WASocket> {
  const existing = registry.get(meta.sessionId);
  if (existing) {
    try {
      existing.socket.ev.removeAllListeners();
      existing.socket.end(new Error('intentional hot reload'));
    } catch {
      // Socket is already closed.
    }
    registry.delete(meta.sessionId);
    await sleep(1000);
  }
  return initSocket(meta, opts);
}

/**
 * Close and remove a session from the registry.
 */
export async function closeSocket(sessionId: string): Promise<void> {
  const h = registry.get(sessionId);
  
  // Cleanup timers first
  const timer = reconnectTimers.get(sessionId);
  if (timer) clearTimeout(timer);
  reconnectTimers.delete(sessionId);
  
  socketGenerations.set(sessionId, (socketGenerations.get(sessionId) ?? 0) + 1);
  reconnectWindows.delete(sessionId);

  if (h) {
    try {
      // 1. Stop any active status runs
      const { stopAllStatus } = await import('./commands/all-status.js');
      stopAllStatus(sessionId);
      
      // 2. Remove listeners to prevent memory leaks
      h.socket.ev.removeAllListeners();
      
      // 3. Gracefully end the socket
      h.socket.end(undefined);
      
      // 4. If it doesn't close in 2s, force destroy
      setTimeout(() => {
        try { (h.socket as any).ws?.terminate(); } catch {}
      }, 2000).unref();
      
    } catch (err) {
      logger.debug(`[SocketManager] Error closing socket ${sessionId}`, { err: String(err) });
    }
    registry.delete(sessionId);
  }
}

/** Mark a session as intentionally purged so the disconnect handler skips recovery. */
export function markPurged(sessionId: string): void {
  purgedSessions.add(sessionId);
}

/**
 * Get all active socket session IDs for a Telegram user.
 */
export function getUserSockets(telegramId: string): string[] {
  const result: string[] = [];
  for (const [id, h] of registry.entries()) {
    if (h.meta.telegramId === telegramId) result.push(id);
  }
  return result;
}

export async function closeAllSockets(): Promise<void> {
  for (const timer of reconnectTimers.values()) clearTimeout(timer);
  reconnectTimers.clear();
  await Promise.allSettled([...registry.keys()].map((sessionId) => closeSocket(sessionId)));
}
