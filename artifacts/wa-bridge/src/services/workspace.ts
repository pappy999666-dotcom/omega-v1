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
  PlatformConfig,
  MenuButton,
} from '../types/index.js';
import { logger } from '../utils/logger.js';

import os from 'os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── WORKSPACE ROOT (session persistence — CRITICAL) ────────
// Sessions MUST live OUTSIDE the git repository. The old default
// (`artifacts/workspaces`) was inside the repo tree AND git-tracked,
// so `git pull` / `git reset --hard` / `git clean` on the VPS wiped
// every session. New default: ~/.omega-v1/workspaces (never tracked).
//
// Resolution order:
//   1. WORKSPACE_ROOT env var (explicit VPS override, e.g. /root/omega-data)
//   2. OMEGA_DATA_DIR env var
//   3. ~/.omega-v1/workspaces (safe default, outside any git checkout)
export const WORKSPACE_ROOT: string = (() => {
  const envRoot = process.env.WORKSPACE_ROOT ?? process.env.OMEGA_DATA_DIR;
  if (envRoot) return path.resolve(envRoot);
  return path.join(os.homedir(), '.omega-v1', 'workspaces');
})();

/**
 * One-time migration: copy any existing in-repo workspace data
 * (legacy `artifacts/workspaces`) into the new persistent root.
 * Idempotent — only copies when the new root is empty/missing.
 * Runs at module load; safe to call repeatedly.
 */
export function migrateLegacyWorkspaces(): void {
  try {
    // The OLD default resolved relative to the module location, which differs
    // between dev (src/services → wa-bridge/workspaces) and the bundled build
    // (dist → artifacts/workspaces — the git-tracked path that caused the
    // session-wipe bug). Scan BOTH candidate legacy roots.
    const candidates = [
      path.resolve(__dirname, '../../../workspaces'), // bundled build: artifacts/workspaces
      path.resolve(__dirname, '../../workspaces'), // dev/tsx: wa-bridge/workspaces
    ];
    const legacy = candidates.find((c) => {
      if (c === WORKSPACE_ROOT || !fs.existsSync(c)) return false;
      return fs.readdirSync(c).filter((f) => f !== '.gitkeep').length > 0;
    });
    if (!legacy) return;
    if (fs.existsSync(WORKSPACE_ROOT) && fs.readdirSync(WORKSPACE_ROOT).length > 0) return;
    fs.mkdirSync(WORKSPACE_ROOT, { recursive: true });
    for (const entry of fs.readdirSync(legacy)) {
      if (entry === '.gitkeep') continue;
      fs.cpSync(path.join(legacy, entry), path.join(WORKSPACE_ROOT, entry), { recursive: true });
    }
    logger.warn(
      `[Workspace] Migrated session data from legacy in-repo path ${legacy} → ${WORKSPACE_ROOT}. ` +
        'Sessions are now stored outside the git repository and will survive git pull/reset/clean.'
    );
  } catch (err) {
    logger.error('[Workspace] Legacy workspace migration failed', { err: String(err) });
  }
}

migrateLegacyWorkspaces();

// ── Atomic JSON writes ─────────────────────────────────────
// Write to a temp file then rename, so a crash / kill mid-write can
// never leave a truncated config/meta/bucket file behind.
function ensurePrivatePath(p: string): void {
  try {
    if (fs.existsSync(p)) fs.chmodSync(p, 0o600);
  } catch { /* best effort on non-POSIX filesystems */ }
}

function atomicWriteJson(p: string, data: unknown): void {
  fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
  try { fs.chmodSync(path.dirname(p), 0o700); } catch { /* best effort on non-POSIX filesystems */ }
  const tmp = `${p}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  try { fs.chmodSync(tmp, 0o600); } catch { /* best effort on non-POSIX filesystems */ }
  fs.renameSync(tmp, p);
  try { fs.chmodSync(p, 0o600); } catch { /* best effort on non-POSIX filesystems */ }
}

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
    ownerWaNumbers: [],
    trustedAdminNumbers: [],
    defaultLinkCollection: false,
    notificationsEnabled: true,
    autoValidationEnabled: false,
    sleeping: false,
    statusDesignEnabled: true,
    statusDesignTheme: 'clean',
    statusDesignStickyThemes: {},
    forceJoinTargets: [],
    broadcastEnabled: true,
    joinedAt: Date.now(),
    lastActivity: Date.now(),
    publicMode: true,
    tagReply: true,
    permissionDeniedResponse: 'You are not authorized to use this command.',
    stickerPackName: 'PAPPY',
    stickerAuthor: 'OMEGA',
    releasePostsEnabled: true,
    autoStatusView: true,
    autoStatusLike: false,
    statusEmoji: '👍',
    antiCallEnabled: false,
    responseMode: 'txt',
    timezone: undefined,
    // Game API (AI-powered poll games) — per-session, never exposed.
    gameApiKey: undefined,
    gameApiModel: undefined,
    gameApiEndpoint: undefined,
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
  ensurePrivatePath(p);
  try {
    const stored = JSON.parse(fs.readFileSync(p, 'utf8')) as Partial<UserConfig>;
    return { ...defaultConfig(telegramId), ...stored, sudoNumbers: stored.sudoNumbers ?? [], forceJoinTargets: stored.forceJoinTargets ?? [], ownerWaNumbers: stored.ownerWaNumbers ?? [], trustedAdminNumbers: stored.trustedAdminNumbers ?? [] };
  } catch {
    return defaultConfig(telegramId);
  }
}

export function saveConfig(telegramId: string, config: UserConfig): void {
  atomicWriteJson(configPath(telegramId), config);
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


export function sessionConfigPath(telegramId: string, sessionId: string): string {
  return path.join(sessionDir(telegramId, sessionId), 'config.json');
}

export function loadSessionConfig(telegramId: string, sessionId: string): UserConfig {
  const base = loadConfig(telegramId);
  const p = sessionConfigPath(telegramId, sessionId);
  
  // DEFAULT ISOLATION: New sessions always start with prefix '.'
  // Changing the global user config prefix must NEVER affect existing or new sessions.
  const isolatedDefaults = {
    prefix: '.',
    nullPrefix: false,
    publicMode: true,
    tagReply: true,
    responseMode: 'txt' as const,
    timezone: undefined as string | undefined,
  };

  // ── GLOBAL SUDO (platform layer) ─────────────────────────────
  // Global Sudo numbers are merged into EVERY session automatically, so a
  // newly paired session inherits them without any per-session setup.
  const globalSudo = getGlobalSudoNumbers(telegramId);
  const mergedSudo = [...new Set([...(base.sudoNumbers ?? []), ...(storedSudoNumbers(telegramId, sessionId, p)), ...globalSudo])];

  if (!fs.existsSync(p)) {
    return {
      ...base,
      ...isolatedDefaults,
      // Game credentials are never inherited from the user-level config.
      // They belong exclusively to this session's config.json.
      gameApiKey: undefined,
      gameApiModel: undefined,
      gameApiEndpoint: undefined,
      stickerMacros: { ...base.stickerMacros },
      sudoNumbers: [...new Set([...(base.sudoNumbers ?? []), ...globalSudo])],
      forceJoinTargets: [...(base.forceJoinTargets ?? [])],
      statusDesignStickyThemes: { ...(base.statusDesignStickyThemes ?? {}) }
    };
  }

  try {
    ensurePrivatePath(p);
    const stored = JSON.parse(fs.readFileSync(p, 'utf8')) as Partial<UserConfig>;
    return {
      ...base,
      ...isolatedDefaults, // Apply defaults first
      ...stored,           // Then session overrides
      // Explicitly override inherited base values, including legacy keys.
      gameApiKey: stored.gameApiKey,
      gameApiModel: stored.gameApiModel,
      gameApiEndpoint: stored.gameApiEndpoint,
      telegramId,
      stickerMacros: { ...(base.stickerMacros ?? {}), ...(stored.stickerMacros ?? {}) },
      sudoNumbers: mergedSudo,
      forceJoinTargets: stored.forceJoinTargets ?? base.forceJoinTargets ?? [],
      ownerWaNumbers: stored.ownerWaNumbers ?? base.ownerWaNumbers ?? [],
      trustedAdminNumbers: stored.trustedAdminNumbers ?? base.trustedAdminNumbers ?? [],
      statusDesignStickyThemes: { ...(base.statusDesignStickyThemes ?? {}), ...(stored.statusDesignStickyThemes ?? {}) },
    };
  } catch {
    return { ...base, ...isolatedDefaults, gameApiKey: undefined, gameApiModel: undefined, gameApiEndpoint: undefined };
  }
}

/** Session-level sudo numbers read directly from disk (used before file-exists branching). */
function storedSudoNumbers(
  telegramId: string,
  sessionId: string,
  p: string
): string[] {
  try {
    if (!fs.existsSync(p)) return [];
    const stored = JSON.parse(fs.readFileSync(p, 'utf8')) as Partial<UserConfig>;
    return stored.sudoNumbers ?? [];
  } catch {
    return [];
  }
}

// ── Global Sudo / Omni Owner ────────────────────────────────────
// GLOBAL SUDO = PER-TELEGRAM-USER (their main hub): sudo on every session
// this Telegram account pairs. Stored in the user's workspace config.json,
// merged into every session at load (loadSessionConfig) and re-checked live
// on each command, so updates synchronize without a reload.
//
// OMNI OWNER = BOT-WIDE (platform): the highest permission layer, applies to
// EVERY session of EVERY Telegram user. Stored in _platform/config.json
// (PlatformConfig.omniOwnerNumbers). Never a session or per-user setting.

/** Per-user Global Sudo numbers — sudo on every session of this Telegram user. */
export function getGlobalSudoNumbers(telegramId: string): string[] {
  return loadConfig(telegramId).globalSudoNumbers ?? [];
}

/** Replace the per-user Global Sudo list. */
export function setGlobalSudoNumbers(telegramId: string, numbers: string[]): void {
  updateConfig(telegramId, { globalSudoNumbers: [...new Set(numbers)] });
}

/** Add numbers to the per-user Global Sudo list (idempotent). */
export function addGlobalSudoNumbers(telegramId: string, numbers: string[]): string[] {
  const next = [...new Set([...getGlobalSudoNumbers(telegramId), ...numbers])];
  setGlobalSudoNumbers(telegramId, next);
  return next;
}

/** Remove numbers from the per-user Global Sudo list. */
export function removeGlobalSudoNumbers(telegramId: string, numbers: string[]): string[] {
  const set = new Set(getGlobalSudoNumbers(telegramId));
  for (const n of numbers) set.delete(n);
  const next = [...set];
  setGlobalSudoNumbers(telegramId, next);
  return next;
}

// ── OMNI OWNER (bot-wide platform layer) ───────────────────────
// Omni Owner is the highest permission layer and is BOT-WIDE: it applies to
// every session of every Telegram user. It is stored in the platform config
// (_platform/config.json), never per-user and never per-session.

let omniMigrationDone = false;

/**
 * One-time migration: legacy per-user `omniOwnerNumbers` (from the pre-
 * promotion era where Omni lived in each user's config) are swept up into
 * the platform config so existing owners keep their bot-wide access, then
 * removed from the per-user configs. Idempotent; runs lazily on first
 * Omni read (after the platform config constants are initialized).
 */
function migrateLegacyOmniOwnersToPlatform(): void {
  if (omniMigrationDone) return;
  omniMigrationDone = true;
  try {
    const platform = loadPlatformConfig();
    const existing = new Set((platform.omniOwnerNumbers ?? []).map((n) => n.replace(/\D/g, '')));
    let changed = false;
    for (const uid of getAllUserIds()) {
      const cfg = loadConfig(uid);
      const legacy = cfg.omniOwnerNumbers ?? [];
      if (legacy.length === 0) continue;
      for (const n of legacy) {
        const clean = String(n).replace(/\D/g, '');
        if (clean && !existing.has(clean)) {
          existing.add(clean);
          platform.omniOwnerNumbers = [...(platform.omniOwnerNumbers ?? []), n];
          changed = true;
        }
      }
      delete cfg.omniOwnerNumbers;
      saveConfig(uid, cfg);
    }
    if (changed) {
      savePlatformConfig(platform);
      logger.info('[Workspace] Migrated legacy per-user Omni Owner numbers to the bot-wide platform config');
    }
  } catch (err) {
    logger.warn('[Workspace] Legacy Omni Owner migration failed', { err: String(err) });
  }
}

/** BOT-WIDE Omni Owner numbers — highest permission layer (all sessions, all users). */
export function getOmniOwnerNumbers(_telegramId?: string): string[] {
  migrateLegacyOmniOwnersToPlatform();
  return loadPlatformConfig().omniOwnerNumbers ?? [];
}

/** Replace the BOT-WIDE Omni Owner list (platform config). */
export function setOmniOwnerNumbers(_telegramId: string | undefined, numbers: string[]): void {
  updatePlatformConfig({ omniOwnerNumbers: [...new Set(numbers)] });
}

/** Add numbers to the BOT-WIDE Omni Owner list (idempotent). */
export function addOmniOwnerNumbers(_telegramId: string | undefined, numbers: string[]): string[] {
  const next = [...new Set([...(getOmniOwnerNumbers()), ...numbers])];
  setOmniOwnerNumbers(undefined, next);
  return next;
}

/** Remove numbers from the BOT-WIDE Omni Owner list. */
export function removeOmniOwnerNumbers(_telegramId: string | undefined, numbers: string[]): string[] {
  const set = new Set(getOmniOwnerNumbers());
  for (const n of numbers) set.delete(n);
  const next = [...set];
  setOmniOwnerNumbers(undefined, next);
  return next;
}

/** True when the given WhatsApp number is a BOT-WIDE Omni Owner (any Telegram user). */
export function isOmniOwnerNumber(_telegramId: string | undefined, number: string): boolean {
  const clean = String(number).replace(/\D/g, '');
  if (!clean) return false;
  return getOmniOwnerNumbers().some((n) => String(n).replace(/\D/g, '') === clean);
}

export function saveSessionConfig(telegramId: string, sessionId: string, config: UserConfig): void {
  atomicWriteJson(sessionConfigPath(telegramId, sessionId), { ...config, telegramId });
}

export function updateSessionConfig(telegramId: string, sessionId: string, patch: Partial<UserConfig>): UserConfig {
  const updated = { ...loadSessionConfig(telegramId, sessionId), ...patch, lastActivity: Date.now() };
  saveSessionConfig(telegramId, sessionId, updated);
  return updated;
}

export function sessionMetaPath(telegramId: string, sessionId: string): string {
  return path.join(sessionDir(telegramId, sessionId), 'meta.json');
}

export function saveSessionMeta(meta: SessionMeta): void {
  const dir = sessionDir(meta.telegramId, meta.sessionId);
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(sessionAuthDir(meta.telegramId, meta.sessionId), { recursive: true });
  fs.mkdirSync(sessionLogDir(meta.telegramId, meta.sessionId), { recursive: true });
  atomicWriteJson(sessionMetaPath(meta.telegramId, meta.sessionId), meta);
}

export function loadSessionMeta(
  telegramId: string,
  sessionId: string
): SessionMeta | null {
  const p = sessionMetaPath(telegramId, sessionId);
  if (!fs.existsSync(p)) return null;
  try {
    const stored = JSON.parse(fs.readFileSync(p, 'utf8')) as SessionMeta;
    
    // Compatibility mapping for old statuses
    let status = stored.status;
    if (['connecting', 'error'].includes(status)) status = 'PAIRING' as any;
    if (['open', 'closed'].includes(status)) status = 'ACTIVE' as any;
    if (['dead', 'purged', 'banned'].includes(status)) status = 'PURGED' as any;
    if ((status as string) === 'frozen') status = 'FROZEN' as any;

    return {
      ...stored,
      status: status as SessionMeta['status'],
      sessionName: stored.sessionName ?? stored.label ?? 'Main',
      // pairMethod is a required field; guard against sessions saved before it was added
      pairMethod: stored.pairMethod ?? 'qr',
      linkCollectionEnabled: stored.linkCollectionEnabled ?? loadConfig(telegramId).defaultLinkCollection ?? false,
      linksCollected: stored.linksCollected ?? 0,
      notificationDelivered: stored.notificationDelivered ?? false,
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

/** All sessions across every workspace — used by the wildcard remote allowlist. */
export function loadAllSessionsGlobally(): Array<{ telegramId: string; sessionId: string; meta: SessionMeta }> {
  try {
    if (!fs.existsSync(WORKSPACE_ROOT)) return [];
    const all: Array<{ telegramId: string; sessionId: string; meta: SessionMeta }> = [];
    for (const entry of fs.readdirSync(WORKSPACE_ROOT, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const sessions = loadAllSessions(entry.name);
      for (const [sessionId, meta] of Object.entries(sessions)) {
        all.push({ telegramId: entry.name, sessionId, meta });
      }
    }
    return all;
  } catch {
    return [];
  }
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
 * Purge a session completely — removes auth state, meta, and database records.
 * Called on 401/Bad MAC errors or manual deletion.
 */
/**
 * Purge a session completely — removes auth state, meta, and database records.
 * Called on 401/Bad MAC errors or manual deletion.
 * Implements the "Purge Engine" requirements.
 */
export async function purgeSession(telegramId: string, sessionId: string): Promise<void> {
  const dir = sessionDir(telegramId, sessionId);
  
  logger.warn(`[PurgeEngine] Starting purge for session ${sessionId}...`);

  // 1. Unregister from runtime first to stop events
  try {
    const { unregisterSessionOwner } = await import('../whatsapp/event-handlers.js');
    unregisterSessionOwner(sessionId);
  } catch {}

  // 2. Cancel Active Jobs & Queues
  try {
    const { cancelSessionJobs } = await import('./queue.js');
    await cancelSessionJobs(sessionId);
  } catch (err) {
    logger.warn(`[PurgeEngine] Queue cleanup failed for ${sessionId}`, { err: String(err) });
  }

  // 3. Redis Cleanup (Queues, Cache, Circuit Breakers, State)
  try {
    const { getRedis } = await import('./queue.js');
    const redis = getRedis();
    // Pattern match all keys related to this session
    const keys = await redis.keys(`*${sessionId}*`);
    if (keys.length > 0) {
      await redis.del(...keys);
      logger.info(`[PurgeEngine] Deleted ${keys.length} Redis keys`);
    }
  } catch (err) {
    logger.warn(`[PurgeEngine] Redis purge failed for ${sessionId}`, { err: String(err) });
  }

  // 4. Mongo Cleanup
  if (process.env.MONGO_URI) {
    try {
      const { execSync } = await import('child_process');
      // Delete session records, logs, and any associated data
      execSync(`mongosh "${process.env.MONGO_URI}" --eval "db.sessions.deleteMany({ sessionId: '${sessionId}' }); db.logs.deleteMany({ sessionId: '${sessionId}' });"`, { stdio: 'ignore' });
      logger.info(`[PurgeEngine] Mongo records cleared`);
    } catch (err) {
      // Non-critical
    }
  }

  // 5. Memory Cache & Registry Cleanup
  try {
    const { markPurged, closeSocket } = await import('../whatsapp/socket-manager.js');
    markPurged(sessionId);
    await closeSocket(sessionId);
  } catch {}

  // Reset notification delivered flag if session metadata exists before deletion
  // This is implicit since we delete the directory, but for clarity:
  logger.info(`[PurgeEngine] Resetting delivery flags for ${sessionId}`);

  // 6. Session Files (Auth + Logs + Meta)
  if (fs.existsSync(dir)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      logger.info(`[PurgeEngine] Session directory removed: ${dir}`);
    } catch (err) {
      logger.error(`[PurgeEngine] Failed to remove directory ${dir}`, { err: String(err) });
    }
  }

  logger.warn(`[PurgeEngine] Session ${sessionId} fully purged.`);
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

// ── Buckets ────────���──────────────────────────────────────

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
  atomicWriteJson(bucketPath(telegramId, bucket), entries);
}

export function addToMainBucket(
  telegramId: string,
  links: string[],
  sourceSessionId?: string
): { added: number; dupes: number } {
  const existing = loadBucket(telegramId, 'main');
  const existingLinks = new Set([
    ...existing.map((entry) => entry.link),
    ...loadBucket(telegramId, 'active').map((entry) => entry.link),
    ...loadBucket(telegramId, 'dead').map((entry) => entry.link),
  ]);
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
  const movedLinks = new Set(entries.map((entry) => entry.link));
  saveBucket(telegramId, 'main', loadBucket(telegramId, 'main').filter((entry) => !movedLinks.has(entry.link)));
  saveBucket(telegramId, 'dead', loadBucket(telegramId, 'dead').filter((entry) => !movedLinks.has(entry.link)));
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


export function loadPlatformSessions(): SessionMeta[] {
  return getAllUserIds().flatMap((telegramId) => Object.values(loadAllSessions(telegramId)));
}


export function findSessionOwner(sessionId: string): string | null {
  for (const telegramId of getAllUserIds()) {
    if (loadSessionMeta(telegramId, sessionId)) return telegramId;
  }
  return null;
}

// ── Platform Config (global settings shared across all users) ─────

const PLATFORM_CONFIG_PATH = path.join(WORKSPACE_ROOT, '_platform', 'config.json');

// Using PlatformConfig from types/index.js

export function loadPlatformConfig(): PlatformConfig {
  if (!fs.existsSync(PLATFORM_CONFIG_PATH)) return {};
  try {
    return JSON.parse(fs.readFileSync(PLATFORM_CONFIG_PATH, 'utf8')) as PlatformConfig;
  } catch {
    return {};
  }
}

export function savePlatformConfig(config: PlatformConfig): void {
  atomicWriteJson(PLATFORM_CONFIG_PATH, config);
}

export function updatePlatformConfig(patch: Partial<PlatformConfig>): PlatformConfig {
  const config = loadPlatformConfig();
  const updated = { ...config, ...patch };
  savePlatformConfig(updated);
  return updated;
}

export function getGlobalMenuButtons(): MenuButton[] {
  const config = loadPlatformConfig();
  return (config.globalMenuButtons ?? []).sort((a, b) => a.order - b.order);
}

export function saveGlobalMenuButtons(buttons: MenuButton[]): void {
  const config = loadPlatformConfig();
  config.globalMenuButtons = buttons;
  // Sync legacy fields for backward compatibility with components not yet migrated
  const activeUrls = buttons.filter(b => b.enabled).map(b => `${b.name}|${b.url}`);
  config.globalMenuUrl = activeUrls[0];
  config.globalMenuUrls = activeUrls;
  savePlatformConfig(config);
}

/** Get the platform-wide global menu URL, or null if unset. */
export function getGlobalMenuUrl(): string | null {
  const buttons = getGlobalMenuButtons().filter(b => b.enabled);
  if (buttons.length === 0) return null;
  return buttons.map(b => `${b.name}|${b.url}`).join('\n');
}

/** Set the platform-wide global menu URL. */
export function setGlobalMenuUrl(url: string): void {
  const raw = url.split(/[\n,]+/u).filter(Boolean);
  const buttons: MenuButton[] = raw.map((entry, i) => {
    const parts = entry.split('|');
    const name = parts.length > 1 ? parts[0]!.trim() : 'Link';
    const link = (parts.length > 1 ? parts.slice(1).join('|') : entry).trim();
    return {
      id: Math.random().toString(36).slice(2, 9),
      name,
      url: link,
      enabled: true,
      order: i,
    };
  });
  saveGlobalMenuButtons(buttons);
  logger.info('[Platform] Global menu buttons updated');
}

/** Remove the platform-wide global menu URL. */
export function clearGlobalMenuUrl(): void {
  const config = loadPlatformConfig();
  delete config.globalMenuUrl;
  delete config.globalMenuUrls;
  delete config.globalMenuButtons;
  savePlatformConfig(config);
  logger.info('[Platform] Global menu URL cleared');
}
