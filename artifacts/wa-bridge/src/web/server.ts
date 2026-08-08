// ============================================================
// WA-Bridge — User Web Dashboard API + Frontend
// User-facing controls only; no owner/admin override routes.
// ============================================================
import express, { type Request, type Response, type NextFunction } from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import multer from 'multer';
import { createWebUser, verifyWebUser, createSession, resolveSession, deleteSession } from './auth.js';
import { addToMainBucket, findSessionOwner, loadAllSessionsGlobally, loadBucket, loadSessionMeta, loadWorkspace, purgeSession, saveBucket, saveSessionMeta, updateConfig, updateSessionMeta } from '../services/workspace.js';
import { exportBucket } from '../services/tri-bucket.js';
import { freezeSession, getSocket, getUserSockets, initSocket, isFrozen, normalizePairingPhone, unfreezeSession } from '../whatsapp/socket-manager.js';
import { registerSessionOwner } from '../whatsapp/event-handlers.js';
import { cmdAllStatus } from '../whatsapp/commands/all-status.js';
import { cmdAllChat, stopOutreach } from '../whatsapp/commands/mass-outreach.js';
import { startAutoFilter, stopAutoFilter, validateLinksHttp } from '../services/tri-bucket.js';
import { importLinksToMainBucket } from '../services/importer.js';
import { statusDesignEngine, type StatusTheme } from '../services/StatusDesignEngine.js';
import { PreviewManager } from '../preview-engine/index.js';
import type { SessionMeta } from '../types/index.js';
import { logger } from '../utils/logger.js';
import { notifySessionConnected } from '../services/session-connected.js';
import {
  getRemoteApiConfig,
  isRemoteApiAuthorized,
  isSessionAllowlisted,
  normalizeRemoteSessionStatus,
  normalizeRemoteText,
  validRemoteJid,
  type RemoteSessionDescriptor,
} from './remote-session-api.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let botRef: any = null;

export function setBotReference(bot: any): void {
  botRef = bot;
}
const publicDir = path.resolve(__dirname, '../public');
const logs = new Map<string, string[]>();
const pairing = new Map<string, { qr?: string; code?: string; error?: string; isPairing?: boolean; method?: 'qr' | 'code' }>();
const clients = new Map<string, Set<Response>>();
const remoteMessageResults = new Map<string, { expiresAt: number; fingerprint: string; body: { ok: true; sessionId: string; messageId: string | null } }>();
const remoteMessageInFlight = new Map<string, { fingerprint: string; promise: Promise<{ ok: true; sessionId: string; messageId: string | null }> }>();

type AuthedRequest = Request & { userId: string };

function emit(userId: string, line: string): void {
  const list = logs.get(userId) ?? [];
  list.push(`[${new Date().toLocaleTimeString()}] ${line}`);
  logs.set(userId, list.slice(-200));
  const payload = `data: ${JSON.stringify({ line, snapshot: dashboardSnapshot(userId) })}\n\n`;
  for (const res of clients.get(userId) ?? []) res.write(payload);
}

function cookie(req: Request, name: string): string | undefined {
  return req.headers.cookie?.split(';').map((p) => p.trim()).find((p) => p.startsWith(`${name}=`))?.slice(name.length + 1);
}

function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const userId = resolveSession(cookie(req, 'wa_web_session'));
  if (!userId) { res.status(401).json({ error: 'Authentication required' }); return; }
  (req as AuthedRequest).userId = userId;
  next();
}

function setSessionCookie(res: Response, token: string): void {
  res.setHeader('Set-Cookie', `wa_web_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=1209600`);
}

function routeParam(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? '' : value ?? '';
}

function dashboardSnapshot(userId: string): object {
  const workspace = loadWorkspace(userId);
  return {
    config: workspace.config,
    sessions: Object.values(workspace.sessions),
    activeSockets: getUserSockets(userId),
    buckets: { main: workspace.mainBucket.length, active: workspace.activeBucket.length, dead: workspace.deadBucket.length },
    logs: logs.get(userId) ?? [],
    themes: statusDesignEngine.themes,
  };
}

function assertSessionOwner(userId: string, sessionId: string): void {
  if (!loadWorkspace(userId).sessions[sessionId]) throw new Error('Session does not belong to this workspace');
}

function remoteSessionStatus(meta: SessionMeta | null, sessionId: string): RemoteSessionDescriptor {
  if (!meta) {
    return { sessionId, label: sessionId, status: 'UNAVAILABLE', available: false, reason: 'Session is not registered on Omega.' };
  }

  const status = normalizeRemoteSessionStatus(meta.status);
  if (status === 'ACTIVE' && getSocket(sessionId) && !isFrozen(sessionId)) {
    return { sessionId, label: meta.label ?? meta.sessionName, status: 'ACTIVE', available: true };
  }
  if (status === 'FROZEN' || isFrozen(sessionId)) {
    return { sessionId, label: meta.label ?? meta.sessionName, status: 'FROZEN', available: false, reason: 'Session is frozen.' };
  }
  if (status === 'PAIRING') {
    return { sessionId, label: meta.label ?? meta.sessionName, status: 'PAIRING', available: false, reason: 'Session pairing is not complete.' };
  }
  if (status === 'PURGED') {
    return { sessionId, label: meta.label ?? meta.sessionName, status: 'PURGED', available: false, reason: 'Session was purged.' };
  }
  return { sessionId, label: meta.label ?? meta.sessionName, status: 'DISCONNECTED', available: false, reason: 'Session is not connected.' };
}

function remoteApiGuard(req: Request, res: Response, next: NextFunction): void {
  const config = getRemoteApiConfig();
  if (!config.apiKey) {
    res.status(503).json({ error: 'Remote session integration is not configured', code: 'REMOTE_API_UNAVAILABLE' });
    return;
  }
  if (!isRemoteApiAuthorized(req.headers.authorization, config)) {
    res.status(401).json({ error: 'Invalid remote session credentials', code: 'REMOTE_API_UNAUTHORIZED' });
    return;
  }
  next();
}

function assertRemoteSessionAccess(sessionId: string): void {
  if (!isSessionAllowlisted(sessionId)) {
    throw Object.assign(new Error('Session is not authorized for remote use'), { statusCode: 403, code: 'REMOTE_SESSION_FORBIDDEN' });
  }
}

export function createWebApp(): express.Express {
  const app = express();
  app.use(express.json({ limit: '15mb' }));
  app.use(express.urlencoded({ extended: true, limit: '15mb' }));

  // ── Anti-scraping / bot protection ──────────────────────
  const reqCounts = new Map<string, { count: number; resetAt: number }>();
  app.use((req, res, next) => {
    // Block obvious scrapers by UA
    const ua = req.headers['user-agent'] ?? '';
    if (/curl|wget|python|scrapy|bot|spider|crawl|httpclient|okhttp|java\/|go-http/i.test(ua) && !req.path.startsWith('/api/auth') && !req.path.startsWith('/api/remote')) {
      res.status(403).json({ error: 'Forbidden' }); return;
    }
    // Rate limit: 120 req/min per IP on API routes
    if (req.path.startsWith('/api/')) {
      const ip = String(req.headers['x-forwarded-for'] ?? req.socket.remoteAddress ?? 'unknown');
      const now = Date.now();
      const entry = reqCounts.get(ip) ?? { count: 0, resetAt: now + 60_000 };
      if (now > entry.resetAt) { entry.count = 0; entry.resetAt = now + 60_000; }
      entry.count++;
      reqCounts.set(ip, entry);
      if (entry.count > 120) { res.status(429).json({ error: 'Too many requests' }); return; }
    }
    // Security headers
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    next();
  });

  app.post('/api/auth/register', (req, res) => {
    try {
      const user = createWebUser(String(req.body.username ?? ''), String(req.body.password ?? ''));
      setSessionCookie(res, createSession(user.id));
      emit(user.id, `Workspace created for ${user.username}`);
      res.json({ user });
    } catch (err) { res.status(400).json({ error: err instanceof Error ? err.message : String(err) }); }
  });

  app.post('/api/auth/login', (req, res) => {
    const user = verifyWebUser(String(req.body.username ?? ''), String(req.body.password ?? ''));
    if (!user) { res.status(401).json({ error: 'Invalid username or password' }); return; }
    setSessionCookie(res, createSession(user.id));
    emit(user.id, `Signed in as ${user.username}`);
    res.json({ user });
  });

  app.post('/api/auth/logout', (req, res) => {
    deleteSession(cookie(req, 'wa_web_session'));
    res.setHeader('Set-Cookie', 'wa_web_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
    res.json({ ok: true });
  });

  app.get('/api/events', requireAuth, (req, res) => {
    const userId = (req as AuthedRequest).userId;
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(`data: ${JSON.stringify({ snapshot: dashboardSnapshot(userId) })}\n\n`);
    const set = clients.get(userId) ?? new Set<Response>();
    set.add(res); clients.set(userId, set);
    req.on('close', () => set.delete(res));
  });

  app.get('/api/dashboard', requireAuth, (req, res) => res.json(dashboardSnapshot((req as AuthedRequest).userId)));

  // ── Remote capability API (Waiq or another explicitly configured client) ──
  // Only allowlisted sessions are visible. No auth files, credentials, socket
  // handles, or raw Baileys objects are ever serialized over this API.
  app.get('/api/remote/sessions', remoteApiGuard, (_req, res) => {
    const config = getRemoteApiConfig();
    const allowAll = config.allowedSessionIds.includes('*');
    const sessions = allowAll
      ? loadAllSessionsGlobally().map(({ sessionId, meta }) => remoteSessionStatus(meta, sessionId))
      : config.allowedSessionIds.map((sessionId) => {
          const ownerId = findSessionOwner(sessionId);
          return remoteSessionStatus(ownerId ? loadSessionMeta(ownerId, sessionId) : null, sessionId);
        });
    res.json({ sessions });
  });

  app.get('/api/remote/sessions/:id', remoteApiGuard, (req, res) => {
    const sessionId = routeParam(req.params.id);
    try {
      assertRemoteSessionAccess(sessionId);
      const ownerId = findSessionOwner(sessionId);
      res.json(remoteSessionStatus(ownerId ? loadSessionMeta(ownerId, sessionId) : null, sessionId));
    } catch (err) {
      const error = err as { statusCode?: number; code?: string; message?: string };
      res.status(error.statusCode ?? 403).json({ error: error.message ?? 'Remote session unavailable', code: error.code ?? 'REMOTE_SESSION_UNAVAILABLE' });
    }
  });

  app.post('/api/remote/sessions/:id/messages', remoteApiGuard, async (req, res) => {
    const sessionId = routeParam(req.params.id);
    let meta: SessionMeta | null = null;
    try {
      assertRemoteSessionAccess(sessionId);
      const ownerId = findSessionOwner(sessionId);
      meta = ownerId ? loadSessionMeta(ownerId, sessionId) : null;
      const descriptor = remoteSessionStatus(meta, sessionId);
      if (!descriptor.available) {
        res.status(503).json({ ...descriptor, code: 'REMOTE_SESSION_UNAVAILABLE' });
        return;
      }

      const idempotencyKey = String(req.headers['idempotency-key'] ?? '').trim();
      if (!/^[A-Za-z0-9._:-]{8,128}$/u.test(idempotencyKey)) {
        res.status(400).json({ error: 'Idempotency-Key header is required (8-128 safe characters)', code: 'INVALID_IDEMPOTENCY_KEY' });
        return;
      }
      const requestKey = `${sessionId}:${idempotencyKey}`;
      const cached = remoteMessageResults.get(requestKey);
      if (cached && cached.expiresAt > Date.now()) {
        const cachedJid = String(req.body?.jid ?? '').trim();
        const cachedText = normalizeRemoteText(req.body?.text);
        if (cached.fingerprint !== `${cachedJid}\u0000${cachedText ?? ''}`) {
          res.status(409).json({ error: 'Idempotency-Key was already used with a different message', code: 'IDEMPOTENCY_CONFLICT' });
          return;
        }
        res.json(cached.body);
        return;
      }
      const jid = String(req.body?.jid ?? '').trim();
      const text = normalizeRemoteText(req.body?.text);
      if (!validRemoteJid(jid)) {
        res.status(400).json({ error: 'A valid WhatsApp recipient JID is required', code: 'INVALID_RECIPIENT' });
        return;
      }
      if (text === null) {
        res.status(400).json({ error: 'Text must be a non-empty string of at most 4096 characters', code: 'INVALID_TEXT' });
        return;
      }

      const fingerprint = `${jid}\u0000${text}`;
      const inFlight = remoteMessageInFlight.get(requestKey);
      if (inFlight) {
        if (inFlight.fingerprint !== fingerprint) {
          res.status(409).json({ error: 'Idempotency-Key was already used with a different message', code: 'IDEMPOTENCY_CONFLICT' });
          return;
        }
        res.json(await inFlight.promise);
        return;
      }

      const sendPromise = (async () => {
        const socket = getSocket(sessionId);
        if (!socket || isFrozen(sessionId)) {
          throw Object.assign(new Error('Session is not connected'), { statusCode: 503, code: 'REMOTE_SESSION_DISCONNECTED' });
        }
        const result = await socket.sendMessage(jid, { text });
        const key = typeof result === 'object' && result !== null && 'key' in result
          ? (result as { key?: { id?: string } }).key?.id
          : undefined;
        return { ok: true as const, sessionId, messageId: key ?? null };
      })();
      remoteMessageInFlight.set(requestKey, { fingerprint, promise: sendPromise });
      try {
        const body = await sendPromise;
        remoteMessageResults.set(requestKey, { expiresAt: Date.now() + 10 * 60_000, fingerprint, body });
        for (const [cacheKey, entry] of remoteMessageResults) {
          if (entry.expiresAt <= Date.now()) remoteMessageResults.delete(cacheKey);
        }
        res.json(body);
      } finally {
        if (remoteMessageInFlight.get(requestKey)?.promise === sendPromise) remoteMessageInFlight.delete(requestKey);
      }
    } catch (err) {
      const error = err as { statusCode?: number; code?: string; message?: string };
      const descriptor = remoteSessionStatus(meta, sessionId);
      const disconnected = error.code === 'REMOTE_SESSION_DISCONNECTED' || !getSocket(sessionId) || isFrozen(sessionId);
      res.status(error.statusCode ?? 502).json({
        ...(disconnected ? { ...descriptor, status: 'DISCONNECTED', available: false } : {}),
        error: error.message ?? 'Remote message failed',
        code: error.code ?? 'REMOTE_MESSAGE_FAILED',
      });
    }
  });

  // Remote probe: onWhatsApp existence check through an authorized, connected
  // session. Lets Waiq run WA-native ban checks without holding any socket.
  app.post('/api/remote/sessions/:id/probe', remoteApiGuard, async (req, res) => {
    const sessionId = routeParam(req.params.id);
    let meta: SessionMeta | null = null;
    try {
      assertRemoteSessionAccess(sessionId);
      const ownerId = findSessionOwner(sessionId);
      meta = ownerId ? loadSessionMeta(ownerId, sessionId) : null;
      const descriptor = remoteSessionStatus(meta, sessionId);
      if (!descriptor.available) {
        res.status(503).json({ ...descriptor, code: 'REMOTE_SESSION_UNAVAILABLE' });
        return;
      }
      const number = String(req.body?.number ?? '').replace(/\D/g, '');
      if (!number) {
        res.status(400).json({ error: 'A phone number is required', code: 'INVALID_NUMBER' });
        return;
      }
      const socket = getSocket(sessionId);
      if (!socket || isFrozen(sessionId)) {
        res.status(503).json({ ...descriptor, status: 'DISCONNECTED', available: false, code: 'REMOTE_SESSION_DISCONNECTED' });
        return;
      }
      const jid = `${number}@s.whatsapp.net`;
      // onWhatsApp is not on the BridgeWASocket type, but exists on the runtime socket.
      const onWhatsApp = (socket as unknown as {
        onWhatsApp: (jid: string) => Promise<Array<{ exists: boolean; jid: string }> | { exists: boolean; jid: string }>;
      }).onWhatsApp.bind(socket);
      const results = await Promise.race([
        Promise.resolve(onWhatsApp(jid)),
        new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error('Probe timed out'), { statusCode: 504, code: 'PROBE_TIMEOUT' })), 8_000)),
      ]);
      const first = Array.isArray(results) ? results[0] : results;
      const exists = Boolean(first && typeof first === 'object' && 'exists' in first ? (first as { exists?: boolean }).exists : false);
      res.json({ ok: true, sessionId, number, exists });
    } catch (err) {
      const error = err as { statusCode?: number; code?: string; message?: string };
      res.status(error.statusCode ?? 502).json({ error: error.message ?? 'Remote probe failed', code: error.code ?? 'REMOTE_PROBE_FAILED' });
    }
  });

  // Remote report: contact/group report through an authorized, connected session.
  // Mirrors the Waiq reporter's investigation + reportContact flow entirely on
  // Omega's socket — Waiq never receives a socket or credentials, only the
  // outcome. Contact reports use native reportContact (spam IQ + block fallback,
  // block stays). Group reports require the session to already be a member.
  app.post('/api/remote/sessions/:id/report', remoteApiGuard, async (req, res) => {
    const sessionId = routeParam(req.params.id);
    let meta: SessionMeta | null = null;
    try {
      assertRemoteSessionAccess(sessionId);
      const ownerId = findSessionOwner(sessionId);
      meta = ownerId ? loadSessionMeta(ownerId, sessionId) : null;
      const descriptor = remoteSessionStatus(meta, sessionId);
      if (!descriptor.available) {
        res.status(503).json({ ...descriptor, code: 'REMOTE_SESSION_UNAVAILABLE' });
        return;
      }
      const jid = String(req.body?.jid ?? '').trim();
      if (!validRemoteJid(jid) || jid.endsWith('@broadcast')) {
        res.status(400).json({ error: 'A valid WhatsApp contact or group JID is required', code: 'INVALID_TARGET' });
        return;
      }
      const socket = getSocket(sessionId);
      if (!socket || isFrozen(sessionId)) {
        res.status(503).json({ ...descriptor, status: 'DISCONNECTED', available: false, code: 'REMOTE_SESSION_DISCONNECTED' });
        return;
      }
      const s = socket as unknown as {
        presenceSubscribe(jid: string): Promise<unknown>;
        sendNode(node: { tag: string; attrs: Record<string, unknown>; content?: unknown[] }): Promise<unknown>;
        generateMessageTag(): string;
        reportContact(jid: string): Promise<unknown>;
        updateBlockStatus(jid: string, status: 'block'): Promise<unknown>;
        groupMetadata(jid: string): Promise<unknown>;
        reportGroup(jid: string): Promise<unknown>;
      };
      const withTimeout = <T>(promise: Promise<T>, ms: number): Promise<T> => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const result = Promise.race([
          promise,
          new Promise<T>((_, reject) => {
            timer = setTimeout(() => reject(new Error('Operation timed out')), ms);
          }),
        ]);
        result.then(
          () => { if (timer) clearTimeout(timer); },
          () => { if (timer) clearTimeout(timer); }
        );
        return result;
      };
      const isGroup = jid.endsWith('@g.us');
      let method: 'native' | 'fallback' = 'native';
      if (isGroup) {
        // Group report — verify membership first (reportGroup requires it).
        let isMember = true;
        try { await withTimeout(s.groupMetadata(jid), 6_000); } catch { isMember = false; }
        if (!isMember) {
          throw Object.assign(new Error('Session is not a member of this group'), { statusCode: 404, code: 'REMOTE_REPORT_NOT_MEMBER' });
        }
        try {
          await withTimeout(s.reportGroup(jid), 8_000);
        } catch (err2) {
          throw Object.assign(
            new Error(`group report failed: ${err2 instanceof Error ? err2.message : String(err2)}`),
            { statusCode: 502, code: 'REMOTE_REPORT_FAILED' }
          );
        }
      } else {
        // 1. Investigation signals (best effort — same as Waiq's reporter)
        try { await withTimeout(s.presenceSubscribe(jid), 5_000); } catch {}
        try {
          await withTimeout(
            s.sendNode({
              tag: 'iq',
              attrs: { type: 'get', xmlns: 'w:biz', to: jid, id: s.generateMessageTag() },
              content: [{ tag: 'business_profile', attrs: { v: '244' }, content: [] }],
            }),
            6_000
          );
        } catch {}
        // 2. Report — native first, spam IQ + block fallback (block stays)
        try {
          await withTimeout(s.reportContact(jid), 8_000);
        } catch {
          try {
            await withTimeout(
              s.sendNode({
                tag: 'iq',
                attrs: { type: 'set', xmlns: 'spam', to: 's.whatsapp.net', id: s.generateMessageTag() },
                content: [{ tag: 'spam_list', attrs: {}, content: [{ tag: 'spam', attrs: { jid }, content: [] }] }],
              }),
              8_000
            );
            try { await withTimeout(s.updateBlockStatus(jid, 'block'), 6_000); } catch {}
            method = 'fallback';
          } catch (err2) {
            throw Object.assign(
              new Error(`report failed: ${err2 instanceof Error ? err2.message : String(err2)}`),
              { statusCode: 502, code: 'REMOTE_REPORT_FAILED' }
            );
          }
        }
      }
      res.json({ ok: true, sessionId, jid, method });
    } catch (err) {
      const error = err as { statusCode?: number; code?: string; message?: string };
      res.status(error.statusCode ?? 502).json({ error: error.message ?? 'Remote report failed', code: error.code ?? 'REMOTE_REPORT_FAILED' });
    }
  });

  app.post('/api/sessions', requireAuth, async (req, res) => {
    const userId = (req as AuthedRequest).userId;
    try {
      const phone = normalizePairingPhone(String(req.body.phone ?? ''));
      const label = String(req.body.label ?? 'Workspace').slice(0, 64);
      const pairMethod = req.body.method === 'code' ? 'code' : 'qr';
      const safeName = label.toLowerCase().replace(/\W/g, '_');
      const sessionId = `web_${userId}_${safeName}_${Math.random().toString(36).slice(2, 10)}`;
      
      pairing.set(sessionId, { isPairing: true, method: pairMethod });
      const meta: SessionMeta = { 
        sessionId, 
        telegramId: userId, 
        sessionName: label,
        phone, 
        label, 
        pairMethod, 
        status: 'PAIRING', 
        errorCount: 0, 
        autoJoinDone: false 
      };
      saveSessionMeta(meta); registerSessionOwner(sessionId, userId);
      emit(userId, `Starting ${pairMethod.toUpperCase()} pairing for ${label}`);
      initSocket(meta, {
        usePairingCode: pairMethod === 'code', phone,
        onQR: async (qr) => { if (pairMethod === 'qr') pairing.set(sessionId, { isPairing: true, method: pairMethod, qr }); emit(userId, 'QR code ready'); },
        onPairingCode: async (code) => { if (pairMethod === 'code') pairing.set(sessionId, { isPairing: true, method: pairMethod, code }); emit(userId, `Pairing code ready: ${code}`); },
        onPairingError: async (error) => { pairing.set(sessionId, { isPairing: false, method: pairMethod, error: error.message }); emit(userId, `Pairing warning: ${error.message}`); },
        onConnected: async (sid, isFirstTime) => {
          pairing.set(sessionId, { isPairing: false, method: pairMethod });
          emit(userId, `${label} connected`);
          if (botRef) {
            await notifySessionConnected({
              telegramChatId: parseInt(userId, 10),
              telegram: botRef.telegram,
              socket: getSocket(sid) ?? undefined,
              sessionId: sid,
              phone: meta.phone,
              label: meta.label,
              method: `Web ${pairMethod.toUpperCase()}`,
              ownerTelegramId: userId,
            });
          }
        },
      }).catch((err) => { pairing.set(sessionId, { isPairing: false, method: pairMethod, error: String(err) }); emit(userId, `Socket error: ${String(err)}`); });
      res.json({ sessionId });
    } catch (err) { res.status(400).json({ error: err instanceof Error ? err.message : String(err) }); }
  });

  app.get('/api/sessions/:id/pairing', requireAuth, (req, res) => res.json(pairing.get(routeParam(req.params.id)) ?? {}));
  app.post('/api/sessions/:id/freeze', requireAuth, (req, res) => { freezeSession(routeParam(req.params.id)); emit((req as AuthedRequest).userId, 'Session frozen'); res.json({ ok: true }); });
  app.post('/api/sessions/:id/unfreeze', requireAuth, (req, res) => { unfreezeSession(routeParam(req.params.id)); emit((req as AuthedRequest).userId, 'Session unfrozen'); res.json({ ok: true }); });

  app.post('/api/sessions/:id/autopromote', requireAuth, (req, res) => {
    const userId = (req as AuthedRequest).userId;
    const sessionId = routeParam(req.params.id);
    const meta = loadSessionMeta(userId, sessionId);
    if (!meta) { res.status(404).json({ error: 'Session not found' }); return; }
    const updated = updateSessionMeta(userId, sessionId, {
      autoPromote: {
        enabled: Boolean(req.body.enabled),
        message: String(req.body.message ?? ''),
        postOnJoin: req.body.postOnJoin !== false,
        intervalMinutes: Number(req.body.intervalMinutes ?? 0),
        lastPostedAt: meta.autoPromote?.lastPostedAt,
      },
    });
    emit(userId, 'Auto Promote settings saved');
    res.json(updated?.autoPromote);
  });

  app.delete('/api/sessions/:id', requireAuth, (req, res) => { const userId = (req as AuthedRequest).userId; purgeSession(userId, routeParam(req.params.id)); emit(userId, 'Session purged'); res.json({ ok: true }); });

  app.post('/api/buckets/links', requireAuth, (req, res) => {
    const result = importLinksToMainBucket((req as AuthedRequest).userId, String(req.body.links ?? ''));
    emit((req as AuthedRequest).userId, `Imported ${result.added} links (${result.dupes} duplicates)`);
    res.json(result);
  });
  app.post('/api/buckets/import', requireAuth, (req, res) => {
    const text = req.body.base64 ? Buffer.from(String(req.body.base64), 'base64').toString('utf8') : String(req.body.text ?? '');
    const result = importLinksToMainBucket((req as AuthedRequest).userId, text);
    emit((req as AuthedRequest).userId, `File import added ${result.added} links`);
    res.json(result);
  });
  app.get('/api/buckets/:bucket', requireAuth, (req, res) => res.json(loadBucket((req as AuthedRequest).userId, routeParam(req.params.bucket) as 'main' | 'active' | 'dead')));
  app.delete('/api/buckets/:bucket', requireAuth, (req, res) => { const userId = (req as AuthedRequest).userId; saveBucket(userId, routeParam(req.params.bucket) as 'main' | 'active' | 'dead', []); emit(userId, 'Bucket purged'); res.json({ ok: true }); });
  app.get('/api/buckets/:bucket/export/:format', requireAuth, (req, res) => { const userId = (req as AuthedRequest).userId; res.download(exportBucket(userId, routeParam(req.params.bucket) as 'main' | 'active' | 'dead', routeParam(req.params.format) as 'txt' | 'csv' | 'html')); });

  // Sessionless HTTP validator
  app.post('/api/validator/http', requireAuth, async (req, res) => {
    const userId = (req as AuthedRequest).userId;
    try {
      emit(userId, 'HTTP validation started (no session needed)');
      void validateLinksHttp(userId, async (msg) => emit(userId, msg)).then(r => {
        emit(userId, `HTTP validation done: ${r.activated} active, ${r.killed} dead, ${r.errors} errors`);
      });
      res.json({ ok: true });
    } catch (err) { res.status(400).json({ error: err instanceof Error ? err.message : String(err) }); }
  });

  app.post('/api/validator/start', requireAuth, async (req, res) => {
    const userId = (req as AuthedRequest).userId; const sessionId = String(req.body.sessionId ?? '');
    try { assertSessionOwner(userId, sessionId); const socket = getSocket(sessionId); if (!socket) throw new Error('Selected validation session is offline'); void startAutoFilter(userId, sessionId, socket, async (msg) => emit(userId, msg)); res.json({ ok: true }); }
    catch (err) { res.status(400).json({ error: err instanceof Error ? err.message : String(err) }); }
  });
  app.post('/api/validator/stop', requireAuth, (req, res) => { stopAutoFilter((req as AuthedRequest).userId); emit((req as AuthedRequest).userId, 'Validation stopped'); res.json({ ok: true }); });

  app.post('/api/outreach', requireAuth, async (req, res) => {
    const userId = (req as AuthedRequest).userId; const sessionId = String(req.body.sessionId);
    const socket = getSocket(sessionId); if (!socket) { res.status(404).json({ error: 'Active session not found' }); return; }
    const progress = async (msg: string) => emit(userId, msg);
    const result = req.body.type === 'allchat'
      ? await cmdAllChat(socket, sessionId, userId, String(req.body.message ?? ''), { onProgress: progress })
      : await cmdAllStatus(socket, sessionId, userId, String(req.body.message ?? ''), { onProgress: progress });
    emit(userId, 'Outreach complete'); res.json(result);
  });
  app.post('/api/outreach/stop', requireAuth, (req, res) => { stopOutreach(String(req.body.sessionId)); emit((req as AuthedRequest).userId, 'Outreach stop requested'); res.json({ ok: true }); });

  // Link preview API
  app.post('/api/preview', requireAuth, async (req, res) => {
    const url = String(req.body.url ?? '');
    if (!url.startsWith('http')) { res.status(400).json({ error: 'Invalid URL' }); return; }
    try {
      const meta = await PreviewManager.fetchLinkMeta(url);
      res.json({
        url: meta.url,
        title: meta.title ?? null,
        description: meta.description ?? null,
        imageUrl: meta.imageUrl ?? null,
        siteName: meta.siteName ?? null,
        canonicalUrl: meta.canonicalUrl ?? null,
      });
    } catch (err) { res.status(500).json({ error: err instanceof Error ? err.message : String(err) }); }
  });

  // Auto-promote settings
  app.post('/api/sessions/:id/autopromote', requireAuth, (req, res) => {
    const userId = (req as AuthedRequest).userId;
    const sessionId = routeParam(req.params.id);
    const meta = loadSessionMeta(userId, sessionId);
    if (!meta) { res.status(404).json({ error: 'Session not found' }); return; }
    const updated = updateSessionMeta(userId, sessionId, {
      autoPromote: {
        enabled: Boolean(req.body.enabled),
        message: String(req.body.message ?? ''),
        postOnJoin: req.body.postOnJoin !== false,
        intervalMinutes: Number(req.body.intervalMinutes ?? 0),
        lastPostedAt: meta.autoPromote?.lastPostedAt,
      },
    });
    emit(userId, 'Auto Promote settings saved');
    res.json(updated?.autoPromote);
  });

  // Link collection toggle
  app.post('/api/sessions/:id/linkcollection', requireAuth, (req, res) => {
    const userId = (req as AuthedRequest).userId;
    const sessionId = routeParam(req.params.id);
    const updated = updateSessionMeta(userId, sessionId, { linkCollectionEnabled: Boolean(req.body.enabled) });
    emit(userId, `Link collection ${req.body.enabled ? 'enabled' : 'disabled'}`);
    res.json({ linkCollectionEnabled: updated?.linkCollectionEnabled });
  });

  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

  // Set profile photo — HD no crop via Baileys hd:true
  app.post('/api/sessions/:id/pfp', requireAuth, upload.single('image'), async (req, res) => {
    const userId = (req as AuthedRequest).userId;
    const sessionId = routeParam(req.params.id);
    try {
      assertSessionOwner(userId, sessionId);
      const socket = getSocket(sessionId);
      if (!socket) throw new Error('Session not connected');
      const file = (req as Request & { file?: Express.Multer.File }).file;
      if (!file) throw new Error('No image provided');
      const ownJid = (socket as { user?: { id?: string } }).user?.id;
      if (!ownJid) throw new Error('WhatsApp JID unavailable');
      await (socket as unknown as {
        updateProfilePicture(jid: string, content: Buffer, opts?: { hd?: boolean }): Promise<void>;
      }).updateProfilePicture(ownJid, file.buffer, { hd: true });
      emit(userId, `Profile photo updated for ${sessionId} (HD, no crop)`);
      res.json({ ok: true });
    } catch (err) { res.status(400).json({ error: err instanceof Error ? err.message : String(err) }); }
  });

  // Set display name
  app.post('/api/sessions/:id/setname', requireAuth, async (req, res) => {
    const userId = (req as AuthedRequest).userId;
    const sessionId = routeParam(req.params.id);
    try {
      assertSessionOwner(userId, sessionId);
      const socket = getSocket(sessionId);
      if (!socket) throw new Error('Session not connected');
      const name = String(req.body.name ?? '').trim();
      if (!name) throw new Error('Name cannot be empty');
      await (socket as unknown as { updateProfileName(name: string): Promise<void> }).updateProfileName(name);
      emit(userId, `Display name updated to: ${name}`);
      res.json({ ok: true });
    } catch (err) { res.status(400).json({ error: err instanceof Error ? err.message : String(err) }); }
  });

  // Bridge — execute a command on a session
  app.post('/api/sessions/:id/bridge', requireAuth, async (req, res) => {
    const userId = (req as AuthedRequest).userId;
    const sessionId = routeParam(req.params.id);
    try {
      assertSessionOwner(userId, sessionId);
      const socket = getSocket(sessionId);
      if (!socket) throw new Error('Session not connected');
      const command = String(req.body.command ?? '').trim();
      if (!command) throw new Error('Command cannot be empty');
      // Send command to own JID as a self-message (bridge pattern)
      const ownJid = (socket as { user?: { id?: string } }).user?.id;
      if (!ownJid) throw new Error('WhatsApp JID unavailable');
      await socket.sendMessage(ownJid, { text: command });
      emit(userId, `Bridge command sent: ${command}`);
      res.json({ ok: true, result: `Command sent to session ${sessionId}` });
    } catch (err) { res.status(400).json({ error: err instanceof Error ? err.message : String(err) }); }
  });

  // Re-init session
  app.post('/api/sessions/:id/reinit', requireAuth, async (req, res) => {
    const userId = (req as AuthedRequest).userId;
    const sessionId = routeParam(req.params.id);
    const meta = loadSessionMeta(userId, sessionId);
    if (!meta) { res.status(404).json({ error: 'Session not found' }); return; }
    emit(userId, `Re-initializing ${sessionId}…`);
    const { reinitSocket } = await import('../whatsapp/socket-manager.js');
    reinitSocket(meta, {
      onConnected: async (sid) => {
        emit(userId, `${meta.label || meta.phone} reconnected`);
        if (botRef) {
          await notifySessionConnected({
            telegramChatId: parseInt(userId, 10),
            telegram: botRef.telegram,
            socket: getSocket(sid) ?? undefined,
            sessionId: sid,
            phone: meta.phone,
            label: meta.label,
            method: 'Web Reinit',
            ownerTelegramId: userId,
          });
        }
      },
    }).catch(err => emit(userId, `Reinit error: ${String(err)}`));
    res.json({ ok: true });
  });

  app.post('/api/statusdesign/preview', requireAuth, (req, res) => {
    const text = statusDesignEngine.render({ theme: String(req.body.theme ?? 'clean') as StatusTheme, url: String(req.body.url ?? 'https://example.com'), title: String(req.body.title ?? ''), message: String(req.body.message ?? '') }).text;
    res.json({ text });
  });
  app.post('/api/settings', requireAuth, (req, res) => { const userId = (req as AuthedRequest).userId; const config = updateConfig(userId, req.body); emit(userId, 'Settings saved'); res.json(config); });

  app.use(express.static(publicDir, {
    setHeaders(res, filePath) {
      if (filePath.endsWith('.js') || filePath.endsWith('.css')) {
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
        res.setHeader('Pragma', 'no-cache');
      }
    },
  }));
  app.get('/{*path}', (_, res) => res.sendFile(path.join(publicDir, 'index.html')));
  return app;
}

export async function startWebServer(): Promise<void> {
  const app = createWebApp();
  const port = Number(process.env.WEB_PORT ?? 3000);
  app.listen(port, () => logger.info(`[Web] Dashboard listening on :${port}`));
}
