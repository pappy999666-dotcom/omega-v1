// ============================================================
// WA-Bridge — Baileys Socket Manager
// Multi-Device Engine with auto-sanitation & circuit breakers
// ============================================================

import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  type WASocket,
  type BaileysEventMap,
} from '@crysnovax/baileys';
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

// ── Registry ──────────────────────────────────────────────

// sessionId → SocketHandle
const registry = new Map<string, SocketHandle>();
const reconnectTimers = new Map<string, NodeJS.Timeout>();
const socketGenerations = new Map<string, number>();

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
  opts: {
    usePairingCode?: boolean;
    phone?: string;
    onQR?: (qrDataUrl: string) => Promise<void>;
    onPairingCode?: (code: string) => Promise<void>;
    onConnected?: (sessionId: string) => Promise<void>;
  } = {}
): Promise<WASocket> {
  const { sessionId, telegramId } = meta;
  const log = sessionLogger(sessionId);
  const generation = (socketGenerations.get(sessionId) ?? 0) + 1;
  socketGenerations.set(sessionId, generation);
  const pendingReconnect = reconnectTimers.get(sessionId);
  if (pendingReconnect) clearTimeout(pendingReconnect);
  reconnectTimers.delete(sessionId);
  let pairingCodeRequested = false;

  const authDir = sessionAuthDir(telegramId, sessionId);
  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const { version } = await fetchLatestBaileysVersion();

  const socket: WASocket = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, P({ level: 'silent' })),
    },
    printQRInTerminal: false,
    browser: [
      process.env.WA_BROWSER_NAME ?? 'Chrome',
      'Chrome',
      '120.0.0',
    ],
    syncFullHistory: false,
    markOnlineOnConnect: true,
    logger: P({ level: 'silent' }),
    generateHighQualityLinkPreview: true,
    getMessage: async () => undefined,
  });

  // ── Auth Events ──────────────────────────────────────────

  socket.ev.on('creds.update', saveCreds);

  // ── Connection Updates ────────────────────────────────────

  socket.ev.on('connection.update', async (update) => {
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

    // Pairing code request
    if (
      opts.usePairingCode &&
      opts.phone &&
      !socket.authState.creds.registered &&
      !pairingCodeRequested
    ) {
      pairingCodeRequested = true;
      try {
        const prefix = process.env.PAIRING_CODE_PREFIX ?? 'pappy-bot';
        const code = await socket.requestPairingCode(opts.phone);
        const formatted = `${prefix}-${code}`;
        await opts.onPairingCode?.(formatted);
      } catch (e) {
        log.error('Pairing code request failed', { err: e });
      }
    }

    if (connection === 'open') {
      log.info('Connection established');
      updateSessionMeta(telegramId, sessionId, {
        status: 'open',
        lastSeen: Date.now(),
        errorCount: 0,
        autoJoinDone: meta.autoJoinDone,
      });
      registry.set(sessionId, { socket, meta: { ...meta, status: 'open' }, frozen: false });

      await opts.onConnected?.(sessionId);

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
      const err = (lastDisconnect?.error as Boom)?.output?.statusCode;
      log.warn('Connection closed', { code: err, generation });

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

      // Recovery decision
      const action = classifyBaileysError(lastDisconnect?.error);
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
        const exponent = Math.min(currentMeta.errorCount - 1, 6);
        const baseDelay = action.action === 'backoff' ? 5_000 : 2_000;
        const delay = Math.min(120_000, baseDelay * Math.pow(2, exponent)) + Math.floor(Math.random() * 2_000);

        log.info(`Reconnecting in ${delay}ms...`);
        registry.delete(sessionId);
        const timer = setTimeout(() => {
          reconnectTimers.delete(sessionId);
          if (socketGenerations.get(sessionId) !== generation) return;
          initSocket(currentMeta, opts).catch((e) =>
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
    socket.ev.on(ev as 'messages.upsert', (data) => {
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
