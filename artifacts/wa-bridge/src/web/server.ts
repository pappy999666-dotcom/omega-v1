// ============================================================
// WA-Bridge — User Web Dashboard API + Frontend
// User-facing controls only; no owner/admin override routes.
// ============================================================

import express, { type Request, type Response, type NextFunction } from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { createWebUser, verifyWebUser, createSession, resolveSession, deleteSession } from './auth.js';
import { addToMainBucket, loadAllSessions, loadBucket, loadConfig, loadWorkspace, purgeSession, saveBucket, saveSessionMeta, updateConfig, updateSessionMeta } from '../services/workspace.js';
import { freezeSession, getSocket, getUserSockets, initSocket, normalizePairingPhone, unfreezeSession } from '../whatsapp/socket-manager.js';
import { registerSessionOwner } from '../whatsapp/event-handlers.js';
import { cmdAllChat, cmdAllStatus, stopOutreach } from '../whatsapp/commands/mass-outreach.js';
import { exportBucket, isAutoFilterRunning, startAutoFilter, stopAutoFilter } from '../services/tri-bucket.js';
import { importLinksToMain } from '../services/link-import.js';
import { statusDesignEngine, type StatusTheme } from '../services/StatusDesignEngine.js';
import type { SessionMeta } from '../types/index.js';
import { logger } from '../utils/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(__dirname, '../public');
const logs = new Map<string, string[]>();
const pairing = new Map<string, { qr?: string; code?: string; error?: string; isPairing?: boolean }>();
const clients = new Map<string, Set<Response>>();
const activePairing = new Set<string>();

type AuthedRequest = Request & { userId: string };

function emit(userId: string, line: string): void {
  const list = logs.get(userId) ?? [];
  list.push(`[${new Date().toLocaleTimeString()}] ${line}`);
  logs.set(userId, list.slice(-300));
  push(userId).catch(() => {});
}

async function snapshot(userId: string): Promise<object> {
  const workspace = loadWorkspace(userId);
  return { config: workspace.config, sessions: Object.values(workspace.sessions), activeSockets: getUserSockets(userId), buckets: { main: workspace.mainBucket.length, active: workspace.activeBucket.length, dead: workspace.deadBucket.length }, validatorRunning: isAutoFilterRunning(userId), logs: logs.get(userId) ?? [], themes: statusDesignEngine.themes };
}

async function push(userId: string): Promise<void> {
  const body = `event: update\ndata: ${JSON.stringify(await snapshot(userId))}\n\n`;
  for (const res of clients.get(userId) ?? []) res.write(body);
}

function cookie(req: Request, name: string): string | undefined {
  return req.headers.cookie?.split(';').map((p: string) => p.trim()).find((p: string) => p.startsWith(`${name}=`))?.slice(name.length + 1);
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

export function createWebApp(): express.Express {
  const app = express();
  app.use(express.json({ limit: '12mb' }));
  app.use(express.urlencoded({ extended: true, limit: '12mb' }));

  app.post('/api/auth/register', (req, res) => {
    try { const user = createWebUser(String(req.body.username ?? ''), String(req.body.password ?? '')); setSessionCookie(res, createSession(user.id)); emit(user.id, `Workspace created for ${user.username}`); res.json({ user }); }
    catch (err) { res.status(400).json({ error: err instanceof Error ? err.message : String(err) }); }
  });
  app.post('/api/auth/login', (req, res) => {
    const user = verifyWebUser(String(req.body.username ?? ''), String(req.body.password ?? ''));
    if (!user) return res.status(401).json({ error: 'Invalid username or password' });
    setSessionCookie(res, createSession(user.id)); emit(user.id, `Signed in as ${user.username}`); res.json({ user });
  });
  app.post('/api/auth/logout', (req, res) => { deleteSession(cookie(req, 'wa_web_session')); res.setHeader('Set-Cookie', 'wa_web_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0'); res.json({ ok: true }); });

  app.get('/api/events', requireAuth, async (req, res) => {
    const userId = (req as AuthedRequest).userId;
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive' });
    let set = clients.get(userId); if (!set) { set = new Set(); clients.set(userId, set); }
    set.add(res); await push(userId);
    req.on('close', () => set?.delete(res));
  });

  app.get('/api/dashboard', requireAuth, async (req, res) => res.json(await snapshot((req as AuthedRequest).userId)));

  app.post('/api/sessions', requireAuth, async (req, res) => {
    const userId = (req as AuthedRequest).userId;
    try {
      const phone = normalizePairingPhone(String(req.body.phone ?? ''));
      const label = String(req.body.label ?? 'Workspace').slice(0, 64);
      const pairMethod = req.body.method === 'code' ? 'code' : 'qr';
      const sessionId = `web_${userId}_${phone}`;
      if (activePairing.has(sessionId)) { res.json({ sessionId, alreadyPairing: true }); return; }
      activePairing.add(sessionId);
      const meta: SessionMeta = { sessionId, telegramId: userId, phone, label, pairMethod, status: 'connecting', errorCount: 0, autoJoinDone: false };
      saveSessionMeta(meta); registerSessionOwner(sessionId, userId); pairing.set(sessionId, { isPairing: true }); emit(userId, `Starting ${pairMethod.toUpperCase()} pairing for ${label}`);
      initSocket(meta, {
        usePairingCode: pairMethod === 'code', phone,
        onQR: async (qr) => { pairing.set(sessionId, { ...(pairing.get(sessionId) ?? {}), qr, isPairing: true }); emit(userId, 'QR code ready'); },
        onPairingCode: async (code) => { pairing.set(sessionId, { ...(pairing.get(sessionId) ?? {}), code, isPairing: true }); emit(userId, `Pairing code ready: ${code}`); },
        onPairingError: async (error) => { activePairing.delete(sessionId); pairing.set(sessionId, { ...(pairing.get(sessionId) ?? {}), error: error.message, isPairing: false }); emit(userId, `Pairing warning: ${error.message}`); },
        onConnected: async () => { activePairing.delete(sessionId); pairing.set(sessionId, { ...(pairing.get(sessionId) ?? {}), isPairing: false }); emit(userId, `${label} connected`); },
      }).catch((err) => { activePairing.delete(sessionId); emit(userId, `Socket error: ${String(err)}`); });
      res.json({ sessionId });
    } catch (err) { res.status(400).json({ error: err instanceof Error ? err.message : String(err) }); }
  });
  app.get('/api/sessions/:id/pairing', requireAuth, (req, res) => res.json(pairing.get(req.params.id) ?? {}));
  app.post('/api/sessions/:id/freeze', requireAuth, (req, res) => { freezeSession(req.params.id); emit((req as AuthedRequest).userId, `Session frozen: ${req.params.id}`); res.json({ ok: true }); });
  app.post('/api/sessions/:id/unfreeze', requireAuth, (req, res) => { unfreezeSession(req.params.id); emit((req as AuthedRequest).userId, `Session unfrozen: ${req.params.id}`); res.json({ ok: true }); });
  app.delete('/api/sessions/:id', requireAuth, (req, res) => { purgeSession((req as AuthedRequest).userId, req.params.id); emit((req as AuthedRequest).userId, `Session purged: ${req.params.id}`); res.json({ ok: true }); });
  app.post('/api/sessions/:id/autopromote', requireAuth, (req, res) => { const updated = updateSessionMeta((req as AuthedRequest).userId, req.params.id, { autoPromote: { enabled: Boolean(req.body.enabled), message: String(req.body.message ?? ''), intervalMinutes: Math.max(5, Number(req.body.intervalMinutes ?? 60)) } }); res.json(updated); });

  app.post('/api/buckets/links', requireAuth, (req, res) => { const links = String(req.body.links ?? '').split(/\s+/).filter((l) => /^https?:\/\//.test(l)); const result = addToMainBucket((req as AuthedRequest).userId, links); emit((req as AuthedRequest).userId, `Added ${result.added} links (${result.dupes} duplicates)`); res.json(result); });
  app.post('/api/buckets/import', requireAuth, (req, res) => { try { const result = importLinksToMain((req as AuthedRequest).userId, String(req.body.filename ?? 'links.txt'), Buffer.from(String(req.body.content ?? ''), req.body.base64 ? 'base64' : 'utf8').toString('utf8'), String(req.body.sessionId ?? '') || undefined); emit((req as AuthedRequest).userId, `Imported ${result.added} links from ${req.body.filename}`); res.json(result); } catch (err) { res.status(400).json({ error: err instanceof Error ? err.message : String(err) }); } });
  app.get('/api/buckets/:bucket', requireAuth, (req, res) => res.json(loadBucket((req as AuthedRequest).userId, req.params.bucket as 'main' | 'active' | 'dead')));
  app.delete('/api/buckets/:bucket', requireAuth, (req, res) => { saveBucket((req as AuthedRequest).userId, req.params.bucket as 'main' | 'active' | 'dead', []); emit((req as AuthedRequest).userId, `Purged ${req.params.bucket} bucket`); res.json({ ok: true }); });
  app.get('/api/buckets/:bucket/export/:format', requireAuth, (req, res) => { const file = exportBucket((req as AuthedRequest).userId, req.params.bucket as 'main' | 'active' | 'dead', req.params.format as 'txt' | 'csv' | 'html'); res.download(file); });

  app.post('/api/validator/start', requireAuth, (req, res) => { const userId = (req as AuthedRequest).userId; const sessionId = String(req.body.sessionId); const socket = getSocket(sessionId); if (!socket) return res.status(404).json({ error: 'Select an active validation session' }); startAutoFilter(userId, sessionId, socket, async (msg) => emit(userId, msg)).catch((err) => emit(userId, `Validator failed: ${String(err)}`)); res.json({ ok: true }); });
  app.post('/api/validator/stop', requireAuth, (req, res) => { stopAutoFilter((req as AuthedRequest).userId); emit((req as AuthedRequest).userId, 'Validation stopped'); res.json({ ok: true }); });

  app.post('/api/outreach', requireAuth, async (req, res) => { const userId = (req as AuthedRequest).userId; const socket = getSocket(String(req.body.sessionId)); if (!socket) return res.status(404).json({ error: 'Active session not found' }); const progress = async (msg: string) => emit(userId, msg); const result = req.body.type === 'allchat' ? await cmdAllChat(socket, String(req.body.sessionId), userId, String(req.body.message ?? ''), { onProgress: progress }) : await cmdAllStatus(socket, String(req.body.sessionId), userId, String(req.body.message ?? ''), { onProgress: progress }); res.json(result); });
  app.post('/api/outreach/stop', requireAuth, (req, res) => { stopOutreach(String(req.body.sessionId)); emit((req as AuthedRequest).userId, 'Outreach stop requested'); res.json({ ok: true }); });

  app.post('/api/statusdesign/preview', requireAuth, (req, res) => { const text = statusDesignEngine.render({ theme: String(req.body.theme ?? 'clean') as StatusTheme, url: String(req.body.url ?? 'https://example.com'), title: String(req.body.title ?? ''), message: String(req.body.message ?? '') }).text; res.json({ text }); });
  app.post('/api/settings', requireAuth, (req, res) => { const patch = { prefix: req.body.prefix, notificationsEnabled: req.body.notificationsEnabled, defaultLinkCollection: req.body.defaultLinkCollection, autoValidationEnabled: req.body.autoValidationEnabled, statusDesignEnabled: req.body.statusDesignEnabled, statusDesignTheme: req.body.statusDesignTheme }; const updated = updateConfig((req as AuthedRequest).userId, patch); emit((req as AuthedRequest).userId, 'Settings saved'); res.json(updated); });

  app.use(express.static(publicDir));
  app.get('/{*path}', (_, res) => res.sendFile(path.join(publicDir, 'index.html')));
  return app;
}

export async function startWebServer(): Promise<void> {
  const app = createWebApp();
  const port = Number(process.env.WEB_PORT ?? 3000);
  app.listen(port, () => logger.info(`[Web] Dashboard listening on :${port}`));
}
