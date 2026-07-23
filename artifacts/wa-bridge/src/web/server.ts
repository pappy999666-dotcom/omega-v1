// ============================================================
// WA-Bridge — User Web Dashboard API + Frontend
// User-facing controls only; no owner/admin override routes.
// ============================================================

import express, { type Request, type Response, type NextFunction } from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { createWebUser, verifyWebUser, createSession, resolveSession, deleteSession } from './auth.js';
import { addToMainBucket, loadAllSessions, loadBucket, loadConfig, loadWorkspace, purgeSession, saveSessionMeta, updateConfig } from '../services/workspace.js';
import { freezeSession, getSocket, getUserSockets, initSocket, normalizePairingPhone, unfreezeSession } from '../whatsapp/socket-manager.js';
import { registerSessionOwner } from '../whatsapp/event-handlers.js';
import { cmdAllChat, cmdAllStatus, stopOutreach } from '../whatsapp/commands/mass-outreach.js';
import { statusDesignEngine, type StatusTheme } from '../services/StatusDesignEngine.js';
import type { SessionMeta } from '../types/index.js';
import { logger } from '../utils/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(__dirname, '../public');
const logs = new Map<string, string[]>();
const pairing = new Map<string, { qr?: string; code?: string; error?: string }>();

type AuthedRequest = Request & { userId: string };

function emit(userId: string, line: string): void {
  const list = logs.get(userId) ?? [];
  list.push(`[${new Date().toLocaleTimeString()}] ${line}`);
  logs.set(userId, list.slice(-200));
}

function cookie(req: Request, name: string): string | undefined {
  return req.headers.cookie?.split(';').map((p) => p.trim()).find((p) => p.startsWith(`${name}=`))?.slice(name.length + 1);
}

function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const userId = resolveSession(cookie(req, 'wa_web_session'));
  if (!userId) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }
  (req as AuthedRequest).userId = userId;
  next();
}

function setSessionCookie(res: Response, token: string): void {
  res.setHeader('Set-Cookie', `wa_web_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=1209600`);
}

export function createWebApp(): express.Express {
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use(express.urlencoded({ extended: true }));

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
    if (!user) return res.status(401).json({ error: 'Invalid username or password' });
    setSessionCookie(res, createSession(user.id));
    emit(user.id, `Signed in as ${user.username}`);
    res.json({ user });
  });

  app.post('/api/auth/logout', (req, res) => {
    deleteSession(cookie(req, 'wa_web_session'));
    res.setHeader('Set-Cookie', 'wa_web_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
    res.json({ ok: true });
  });

  app.get('/api/dashboard', requireAuth, (req, res) => {
    const userId = (req as AuthedRequest).userId;
    const workspace = loadWorkspace(userId);
    res.json({
      config: workspace.config,
      sessions: Object.values(workspace.sessions),
      activeSockets: getUserSockets(userId),
      buckets: { main: workspace.mainBucket.length, active: workspace.activeBucket.length, dead: workspace.deadBucket.length },
      logs: logs.get(userId) ?? [],
    });
  });

  app.post('/api/sessions', requireAuth, async (req, res) => {
    const userId = (req as AuthedRequest).userId;
    try {
      const phone = normalizePairingPhone(String(req.body.phone ?? ''));
      const label = String(req.body.label ?? 'Workspace').slice(0, 64);
      const pairMethod = req.body.method === 'code' ? 'code' : 'qr';
      const sessionId = `web_${userId}_${phone}`;
      const meta: SessionMeta = { sessionId, telegramId: userId, phone, label, pairMethod, status: 'connecting', errorCount: 0, autoJoinDone: false };
      saveSessionMeta(meta);
      registerSessionOwner(sessionId, userId);
      emit(userId, `Starting ${pairMethod.toUpperCase()} pairing for ${label}`);
      initSocket(meta, {
        usePairingCode: pairMethod === 'code',
        phone,
        onQR: async (qr) => { pairing.set(sessionId, { ...(pairing.get(sessionId) ?? {}), qr }); emit(userId, 'QR code ready'); },
        onPairingCode: async (code) => { pairing.set(sessionId, { ...(pairing.get(sessionId) ?? {}), code }); emit(userId, `Pairing code ready: ${code}`); },
        onPairingError: async (error) => { pairing.set(sessionId, { ...(pairing.get(sessionId) ?? {}), error: error.message }); emit(userId, `Pairing warning: ${error.message}`); },
        onConnected: async () => emit(userId, `${label} connected`),
      }).catch((err) => emit(userId, `Socket error: ${String(err)}`));
      res.json({ sessionId });
    } catch (err) { res.status(400).json({ error: err instanceof Error ? err.message : String(err) }); }
  });

  app.get('/api/sessions/:id/pairing', requireAuth, (req, res) => res.json(pairing.get(req.params.id) ?? {}));
  app.post('/api/sessions/:id/freeze', requireAuth, (req, res) => { freezeSession(req.params.id); res.json({ ok: true }); });
  app.post('/api/sessions/:id/unfreeze', requireAuth, (req, res) => { unfreezeSession(req.params.id); res.json({ ok: true }); });
  app.delete('/api/sessions/:id', requireAuth, (req, res) => { purgeSession((req as AuthedRequest).userId, req.params.id); res.json({ ok: true }); });

  app.post('/api/buckets/links', requireAuth, (req, res) => {
    const links = String(req.body.links ?? '').split(/\s+/).filter((l) => /^https?:\/\//.test(l));
    const result = addToMainBucket((req as AuthedRequest).userId, links);
    emit((req as AuthedRequest).userId, `Added ${result.added} links (${result.dupes} duplicates)`);
    res.json(result);
  });
  app.get('/api/buckets/:bucket', requireAuth, (req, res) => res.json(loadBucket((req as AuthedRequest).userId, req.params.bucket as 'main' | 'active' | 'dead')));

  app.post('/api/outreach', requireAuth, async (req, res) => {
    const userId = (req as AuthedRequest).userId;
    const socket = getSocket(String(req.body.sessionId));
    if (!socket) return res.status(404).json({ error: 'Active session not found' });
    const progress = async (msg: string) => emit(userId, msg);
    const result = req.body.type === 'allchat'
      ? await cmdAllChat(socket, String(req.body.sessionId), userId, String(req.body.message ?? ''), { onProgress: progress })
      : await cmdAllStatus(socket, String(req.body.sessionId), userId, String(req.body.message ?? ''), { onProgress: progress });
    res.json(result);
  });
  app.post('/api/outreach/stop', requireAuth, (req, res) => { stopOutreach(String(req.body.sessionId)); res.json({ ok: true }); });

  app.post('/api/statusdesign/preview', requireAuth, (req, res) => {
    const text = statusDesignEngine.render({ theme: String(req.body.theme ?? 'clean') as StatusTheme, url: String(req.body.url ?? 'https://example.com'), message: String(req.body.message ?? '') }).text;
    res.json({ text });
  });
  app.post('/api/settings', requireAuth, (req, res) => res.json(updateConfig((req as AuthedRequest).userId, req.body)));

  app.use(express.static(publicDir));
  app.get('*', (_, res) => res.sendFile(path.join(publicDir, 'index.html')));
  return app;
}

export async function startWebServer(): Promise<void> {
  const app = createWebApp();
  const port = Number(process.env.WEB_PORT ?? 3000);
  app.listen(port, () => logger.info(`[Web] Dashboard listening on :${port}`));
}
