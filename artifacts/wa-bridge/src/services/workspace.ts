// ============================================================
// WA-Bridge — Workspace I/O Manager
// Per-user isolated sandboxes: /workspaces/{telegram_id}/
// ============================================================

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import type {
  Workspace,
  UserConfig,
  SessionMeta,
  BucketEntry,
} from '../types/index.js';
import { logger } from '../utils/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT
  ? path.resolve(process.env.WORKSPACE_ROOT)
  : path.resolve(__dirname, '../../workspaces');

// ── Path Helpers ──────────────────────────────────────────

export function workspaceDir(telegramId: string): string {
  return path.join(WORKSPACE_ROOT, telegramId);
}

export function sessionDir(telegramId: string, sessionId: string): string {
  return path.join(workspaceDir(telegramId), 'sessions', sessionId);
}

export function sessionAuthDir(telegramId: string, sessionId: string): string {
  return path.join(sessionDir(telegramId, sessionId), 'auth');
}

export function sessionLogDir(telegramId: string, sessionId: string): string {
  return path.join(sessionDir(telegramId, sessionId), 'logs');
}

export function bucketPath(
  telegramId: string,
  bucket: 'main' | 'active' | 'dead'
): string {
  return path.join(workspaceDir(telegramId), 'buckets', `${bucket}.json`);
}

export function configPath(telegramId: string): string {
  return path.join(workspaceDir(telegramId), 'config.json');
}

// ── Default Structures ────────────────────────────────────

function defaultConfig(telegramId: string): UserConfig {
  return {
    telegramId,
    isBanned: false,
    isOwner: telegramId === process.env.TELEGRAM_OWNER_ID,
    prefix: '.',
    nullPrefix: false,
    stickerMacros: {},
    sudoNumbers: [],
    defaultLinkCollection: false,
    notificationsEnabled: true,
    autoValidationEnabled: false,
    sleeping: false,
    statusDesignEnabled: true,
    statusDesignTheme: 'clean',
    statusDesignStickyThemes: {},
    joinedAt: Date.now(),
    lastActivity: Date.now(),
  };
}

// ── Core Workspace Operations ─────────────────────────────

/**
 * Initialize a new workspace for a Telegram user.
 * Creates the full directory tree and default config.
 */
export function initWorkspace(telegramId: string): Workspace {
  const dir = workspaceDir(telegramId);

  // Create directory structure
  for (const sub of ['sessions', 'buckets', 'exports']) {
    fs.mkdirSync(path.join(dir, sub), { recursive: true });
  }

  const config = defaultConfig(telegramId);
  const workspace: Workspace = {
    telegramId,
    config,
    sessions: {},
    mainBucket: [],
    activeBucket: [],
    deadBucket: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  saveConfig(telegramId, config);
  saveBucket(telegramId, 'main', []);
  saveBucket(telegramId, 'active', []);
  saveBucket(telegramId, 'dead', []);

  logger.info(`[Workspace] Initialized workspace for ${telegramId}`);
  return workspace;
}

/**
 * Load a full workspace from disk. Initializes if missing.
 */
export function loadWorkspace(telegramId: string): Workspace {
  const dir = workspaceDir(telegramId);

  if (!fs.existsSync(dir)) {
    return initWorkspace(telegramId);
  }

  const config = loadConfig(telegramId);
  const sessions = loadAllSessions(telegramId);
  const mainBucket = loadBucket(telegramId, 'main');
  const activeBucket = loadBucket(telegramId, 'active');
  const deadBucket = loadBucket(telegramId, 'dead');

  return {
    telegramId,
    config,
    sessions,
    mainBucket,
    activeBucket,
    deadBucket,
    createdAt: 0,
    updatedAt: Date.now(),
  };
}

// ── Config ────────────────────────────────────────────────

export function loadConfig(telegramId: string): UserConfig {
  const p = configPath(telegramId);
  if (!fs.existsSync(p)) return defaultConfig(telegramId);
  try {
    const stored = JSON.parse(fs.readFileSync(p, 'utf8')) as Partial<UserConfig>;
    return { ...defaultConfig(telegramId), ...stored, sudoNumbers: stored.sudoNumbers ?? [] };
  } catch {
    return defaultConfig(telegramId);
  }
}

export function saveConfig(telegramId: string, config: UserConfig): void {
  const p = configPath(telegramId);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(config, null, 2));
}

export function updateConfig(
  telegramId: string,
  patch: Partial<UserConfig>
): UserConfig {
  const config = loadConfig(telegramId);
  const updated = { ...config, ...patch, lastActivity: Date.now() };
  saveConfig(telegramId, updated);
  return updated;
}

// ── Sessions ──────────────────────────────────────────────

export function sessionMetaPath(telegramId: string, sessionId: string): string {
  return path.join(sessionDir(telegramId, sessionId), 'meta.json');
}

export function saveSessionMeta(meta: SessionMeta): void {
  const dir = sessionDir(meta.telegramId, meta.sessionId);
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(sessionAuthDir(meta.telegramId, meta.sessionId), { recursive: true });
  fs.mkdirSync(sessionLogDir(meta.telegramId, meta.sessionId), { recursive: true });
  const p = sessionMetaPath(meta.telegramId, meta.sessionId);
  fs.writeFileSync(p, JSON.stringify(meta, null, 2));
}

export function loadSessionMeta(
  telegramId: string,
  sessionId: string
): SessionMeta | null {
  const p = sessionMetaPath(telegramId, sessionId);
  if (!fs.existsSync(p)) return null;
  try {
    const stored = JSON.parse(fs.readFileSync(p, 'utf8')) as SessionMeta;
    return {
      ...stored,
      linkCollectionEnabled: stored.linkCollectionEnabled ?? loadConfig(telegramId).defaultLinkCollection ?? false,
      linksCollected: stored.linksCollected ?? 0,
    };
  } catch {
    return null;
  }
}

export function loadAllSessions(
  telegramId: string
): Record<string, SessionMeta> {
  const sessDir = path.join(workspaceDir(telegramId), 'sessions');
  if (!fs.existsSync(sessDir)) return {};

  const sessions: Record<string, SessionMeta> = {};
  for (const entry of fs.readdirSync(sessDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const meta = loadSessionMeta(telegramId, entry.name);
    if (meta) sessions[entry.name] = meta;
  }
  return sessions;
}

export function updateSessionMeta(
  telegramId: string,
  sessionId: string,
  patch: Partial<SessionMeta>
): SessionMeta | null {
  const meta = loadSessionMeta(telegramId, sessionId);
  if (!meta) return null;
  const updated = { ...meta, ...patch };
  saveSessionMeta(updated);
  return updated;
}

/**
 * Purge a session completely — removes auth state and meta.
 * Called on 401/Bad MAC errors.
 */
export function purgeSession(telegramId: string, sessionId: string): void {
  const dir = sessionDir(telegramId, sessionId);
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
    logger.warn(`[Workspace] Purged session ${sessionId} for ${telegramId}`);
  }
}

/**
 * Purge all sessions for a user (ban/reset scenario).
 */
export function purgeAllSessions(telegramId: string): void {
  const sessDir = path.join(workspaceDir(telegramId), 'sessions');
  if (fs.existsSync(sessDir)) {
    fs.rmSync(sessDir, { recursive: true, force: true });
    fs.mkdirSync(sessDir, { recursive: true });
    logger.warn(`[Workspace] Purged all sessions for ${telegramId}`);
  }
}

// ── Buckets ───────────────────────────────────────────────

export function loadBucket(
  telegramId: string,
  bucket: 'main' | 'active' | 'dead'
): BucketEntry[] {
  const p = bucketPath(telegramId, bucket);
  if (!fs.existsSync(p)) return [];
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8')) as BucketEntry[];
  } catch {
    return [];
  }
}

export function saveBucket(
  telegramId: string,
  bucket: 'main' | 'active' | 'dead',
  entries: BucketEntry[]
): void {
  const p = bucketPath(telegramId, bucket);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(entries, null, 2));
}

export function addToMainBucket(
  telegramId: string,
  links: string[],
  sourceSessionId?: string
): { added: number; dupes: number } {
  const existing = loadBucket(telegramId, 'main');
  const existingLinks = new Set(existing.map((e) => e.link));
  let added = 0;
  let dupes = 0;

  for (const link of links) {
    if (existingLinks.has(link)) {
      dupes++;
      continue;
    }
    existing.push({
      link,
      addedAt: Date.now(),
      status: 'unvalidated',
      sourceSessionId,
    });
    existingLinks.add(link);
    added++;
  }

  saveBucket(telegramId, 'main', existing);
  return { added, dupes };
}

export function moveToActiveBucket(
  telegramId: string,
  entries: BucketEntry[]
): void {
  const active = loadBucket(telegramId, 'active');
  const existingJids = new Set(active.map((e) => e.jid ?? e.link));
  for (const e of entries) {
    if (!existingJids.has(e.jid ?? e.link)) {
      active.push({ ...e, status: 'active' });
      existingJids.add(e.jid ?? e.link);
    }
  }
  saveBucket(telegramId, 'active', active);
}

export function moveToDeadBucket(
  telegramId: string,
  entries: BucketEntry[]
): void {
  const dead = loadBucket(telegramId, 'dead');
  const existingLinks = new Set(dead.map((e) => e.link));

  // Remove from main bucket
  const main = loadBucket(telegramId, 'main').filter(
    (e) => !entries.some((d) => d.link === e.link)
  );
  saveBucket(telegramId, 'main', main);

  // Remove from active bucket
  const active = loadBucket(telegramId, 'active').filter(
    (e) => !entries.some((d) => d.link === e.link)
  );
  saveBucket(telegramId, 'active', active);

  for (const e of entries) {
    if (!existingLinks.has(e.link)) {
      dead.push({ ...e, status: 'dead' });
      existingLinks.add(e.link);
    }
  }
  saveBucket(telegramId, 'dead', dead);
}

// ── Export Helpers ────────────────────────────────────────

export function exportDir(telegramId: string): string {
  const dir = path.join(workspaceDir(telegramId), 'exports');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function getAllUserIds(): string[] {
  if (!fs.existsSync(WORKSPACE_ROOT)) return [];
  return fs.readdirSync(WORKSPACE_ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
}
