// ============================================================
// WA-Bridge — User Web Dashboard API + Frontend
// User-facing controls only; no owner/admin override routes.
// ============================================================
import express, { type Request, type Response, type NextFunction } from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import multer from 'multer';
import { createWebUser, verifyWebUser, createSession, resolveSession, deleteSession } from './auth.js';
import { addToMainBucket, loadBucket, loadSessionMeta, loadWorkspace, purgeSession, saveBucket, saveSessionMeta, updateConfig, updateSessionMeta } from '../services/workspace.js';
import { exportBucket } from '../services/tri-bucket.js';
import { freezeSession, getSocket, getUserSockets, initSocket, normalizePairingPhone, unfreezeSession } from '../whatsapp/socket-manager.js';
import { registerSessionOwner } from '../whatsapp/event-handlers.js';
import { cmdAllChat, cmdAllStatus, stopOutreach } from '../whatsapp/commands/mass-outreach.js';
import { startAutoFilter, stopAutoFilter, validateLinksHttp } from '../services/tri-bucket.js';
import { importLinksToMainBucket } from '../services/importer.js';
import { statusDesignEngine, type StatusTheme } from '../services/StatusDesignEngine.js';
import { fetchLinkMeta } from '../whatsapp/preview-manager.js';
import type { SessionMeta } from '../types/index.js';
import { logger } from '../utils/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(__dirname, '../public');
const logs = new Map<string, string[]>();
const pairing = new Map<string, { qr?: string; code?: string; error?: string; isPairing?: boolean; method?: 'qr' | 'code' }>();
const clients = new Map<string, Set<Response>>();

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

export function createWebApp(): express.Express {
  const app = express();
  app.use(express.json({ limit: '15mb' }));
  app.use(express.urlencoded({ extended: true, limit: '15mb' }));

  // ── Anti-scraping / bot protection ──────────────────────
  const reqCounts = new Map<string, { count: number; resetAt: number }>();
  app.use((req, res, next) => {
    // Block obvious scrapers by UA
    const ua = req.headers['user-agent'] ?? '';
    if (/curl|wget|python|scrapy|bot|spider|crawl|httpclient|okhttp|java\/|go-http/i.test(ua) && !req.path.startsWith('/api/auth')) {
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

  app.post('/api/sessions', requireAuth, async (req, res) => {
    const userId = (req as AuthedRequest).userId;
    try {
      const phone = normalizePairingPhone(String(req.body.phone ?? ''));
      const label = String(req.body.label ?? 'Workspace').slice(0, 64);
      const pairMethod = req.body.method === 'code' ? 'code' : 'qr';
      const sessionId = `web_${userId}_${phone}`;
      const current = pairing.get(sessionId);
      if (current?.isPairing && current.method === pairMethod) { res.json({ sessionId, reused: true }); return; }
      pairing.set(sessionId, { isPairing: true, method: pairMethod });
      const meta: SessionMeta = { sessionId, telegramId: userId, phone, label, pairMethod, status: 'connecting', errorCount: 0, autoJoinDone: false };
      saveSessionMeta(meta); registerSessionOwner(sessionId, userId);
      emit(userId, `Starting ${pairMethod.toUpperCase()} pairing for ${label}`);
      initSocket(meta, {
        usePairingCode: pairMethod === 'code', phone,
        onQR: async (qr) => { if (pairMethod === 'qr') pairing.set(sessionId, { isPairing: true, method: pairMethod, qr }); emit(userId, 'QR code ready'); },
        onPairingCode: async (code) => { if (pairMethod === 'code') pairing.set(sessionId, { isPairing: true, method: pairMethod, code }); emit(userId, `Pairing code ready: ${code}`); },
        onPairingError: async (error) => { pairing.set(sessionId, { isPairing: false, method: pairMethod, error: error.message }); emit(userId, `Pairing warning: ${error.message}`); },
        onConnected: async () => { pairing.set(sessionId, { isPairing: false, method: pairMethod }); emit(userId, `${label} connected`); },
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
      const meta = await fetchLinkMeta(url);
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
      onConnected: async () => emit(userId, `${meta.label || meta.phone} reconnected`),
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
