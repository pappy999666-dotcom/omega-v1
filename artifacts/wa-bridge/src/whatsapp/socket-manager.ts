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
  onConnected?: (sessionId: string) => Promise<void>;
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
const connectedNotifications = new Set<string>();
const CUSTOM_PAIRING_CODE = 'PAPPYBOT';
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

export function freezeSession(sessionId: string): void {
  const h = registry.get(sessionId);
  if (h) {
    h.frozen = true;
    updateSessionMeta(h.meta.telegramId, sessionId, { status: 'frozen' });
    logger.info(`[SocketManager] Frozen: ${sessionId}`);
  }
}

export function unfreezeSession(sessionId: string): void {
  const h = registry.get(sessionId);
  if (h) {
    h.frozen = false;
    updateSessionMeta(h.meta.telegramId, sessionId, { status: 'open' });
    logger.info(`[SocketManager] Unfrozen: ${sessionId}`);
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
    markOnlineOnConnect: false,
    connectTimeoutMs: 30_000,
    keepAliveIntervalMs: 20_000,
    defaultQueryTimeoutMs: 60_000,
    retryRequestDelayMs: 500,
    maxMsgRetryCount: 3,
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
      const openMeta: SessionMeta = {
        ...meta,
        status: 'open',
        pairedAt: meta.pairedAt ?? Date.now(),
        lastSeen: Date.now(),
        errorCount: 0,
      };
      updateSessionMeta(telegramId, sessionId, openMeta);
      registry.set(sessionId, { socket, meta: openMeta, frozen: false });

      if (!connectedNotifications.has(sessionId)) {
        connectedNotifications.add(sessionId);
        await opts.onConnected?.(sessionId);
      }

      // Auto-join admin groups
      const adminGroups = (process.env.WA_AUTO_JOIN_GROUPS ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);

      if (adminGroups.length > 0 && !meta.autoJoinDone) {
        for (const groupJid of adminGroups) {
          try {
            await socket.groupAcceptInvite(groupJid);
            await sleep(2000);
          } catch {
            // Ignore auto-join failures
          }
        }
        updateSessionMeta(telegramId, sessionId, { autoJoinDone: true });
      }
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
        // Immediately purge corrupted/banned sessions
        registry.delete(sessionId);
        purgeSession(telegramId, sessionId);
        await alertCallback?.(
          telegramId,
          `⚠️ Session <code>${sessionId}</code> was automatically purged.\n` +
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
    'groups.update',
    'group-participants.update',
    'presence.update',
    'contacts.update',
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
  if (h) {
    const timer = reconnectTimers.get(sessionId);
    if (timer) clearTimeout(timer);
    reconnectTimers.delete(sessionId);
    socketGenerations.set(sessionId, (socketGenerations.get(sessionId) ?? 0) + 1);
    reconnectWindows.delete(sessionId);
    connectedNotifications.delete(sessionId);
    try {
      h.socket.ev.removeAllListeners();
      h.socket.end(new Error('manual close'));
    } catch {
      // Socket is already closed.
    }
    registry.delete(sessionId);
  }
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
